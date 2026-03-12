import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    updateMessageBlock,
} from '../../../../script.js';
import { appendMediaToMessage } from '../../../../script.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

const extensionName = 'st-image-auto-gen-pro';
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;

const DEFAULT_SYSTEM_PROMPT = `你是一个专业的图像提示词生成助手。根据对话内容生成适合 Stable Diffusion 的图像提示词。

要求：
1. 分析对话中的场景、角色、情绪、动作等元素
2. 生成英文提示词用于生图，中文作为图片描述
3. 英文提示词应包含：主体、场景、光线、风格、质量标签
4. 输出格式必须是严格的 JSON 格式

输出格式：
{
  "english_prompt": "英文提示词（用于生图）",
  "chinese_caption": "中文描述（作为图片注释）"
}

注意：
- 英文提示词使用逗号分隔的标签格式
- 中文描述应该简洁自然，描述图片内容
- 不要包含任何除 JSON 外的其他文字`;

const defaultSettings = {
    enabled: false,
    llmSource: 'main_api',
    selectedConnectionProfile: '',
    apiUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4',
    temperature: 0.7,
    maxTokens: 1000,
    historyCount: 5,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    positiveTags: 'masterpiece, best quality',
    negativeTags: 'low quality, blurry, worst quality',
    forbiddenWords: '',
    triggerMode: 'auto',
    triggerKeywords: '生成图片, 画图, imagine',
    insertType: 'inline',
    captionPosition: 'both',
};

let logContainer = null;
let currentModels = [];

// 标准化API URL - 处理各种格式的输入
function normalizeApiUrl(url) {
    if (!url) return url;

    url = url.trim();

    // 如果已经是完整的路径，先提取基础路径
    if (url.includes('/chat/completions')) {
        url = url.substring(0, url.indexOf('/chat/completions'));
    }

    // 移除末尾的斜杠
    url = url.replace(/\/+$/, '');

    return url;
}

// 获取API的基础URL（用于模型列表等）
function getApiBaseUrl(url) {
    const normalized = normalizeApiUrl(url);
    return normalized;
}

// 获取聊天补全API URL
function getChatCompletionsUrl(url) {
    const base = normalizeApiUrl(url);
    return `${base}/chat/completions`;
}

// 获取模型列表API URL
function getModelsUrl(url) {
    const base = normalizeApiUrl(url);
    return `${base}/models`;
}

function addLog(message, type = 'info') {
    if (!logContainer) return;

    const time = new Date().toLocaleTimeString();
    const colors = {
        info: '#2196F3',
        success: '#4CAF50',
        error: '#F44336',
        warning: '#FF9800',
    };

    const logEntry = document.createElement('div');
    logEntry.style.cssText = `
        padding: 4px 8px;
        margin: 2px 0;
        border-left: 3px solid ${colors[type] || colors.info};
        background: rgba(0,0,0,0.1);
        font-size: 12px;
        font-family: monospace;
    `;
    logEntry.innerHTML = `<span style="color:#888">[${time}]</span> ${message}`;
    logContainer.appendChild(logEntry);
    logContainer.scrollTop = logContainer.scrollHeight;
}

// 获取连接配置文件列表
function getConnectionProfileList() {
    try {
        const context = getContext();
        if (context.mainApi && context.mainApi.profiles) {
            return Object.keys(context.mainApi.profiles);
        }
    } catch (e) {
        console.log('无法获取连接配置列表:', e);
    }
    return [];
}

// 获取当前使用的连接配置名称
function getCurrentConnectionProfile() {
    try {
        const context = getContext();
        if (context.mainApi && context.mainApi.currentProfileId) {
            return context.mainApi.currentProfileId;
        }
    } catch (e) {
        console.log('无法获取当前连接配置:', e);
    }
    return '';
}

// 获取主API配置
function getMainApiConfig() {
    const context = getContext();
    try {
        if (context.chatCompletionSettings) {
            return {
                apiUrl: context.chatCompletionSettings.api_url || 'https://api.openai.com/v1',
                apiKey: context.chatCompletionSettings.api_key || '',
                model: context.chatCompletionSettings.model || 'gpt-4',
            };
        }
    } catch (e) {
        console.log('无法获取主API配置:', e);
    }
    return null;
}

// 获取连接配置
function getConnectionProfileConfig(profileId) {
    try {
        const context = getContext();
        if (context.mainApi && context.mainApi.profiles && context.mainApi.profiles[profileId]) {
            const profile = context.mainApi.profiles[profileId];
            return {
                apiUrl: profile.api_url || 'https://api.openai.com/v1',
                apiKey: profile.api_key || '',
                model: profile.model || 'gpt-4',
            };
        }
    } catch (e) {
        console.log('无法获取连接配置:', e);
    }
    return null;
}

// 获取当前LLM配置
function getCurrentLLMConfig() {
    const settings = extension_settings[extensionName];

    if (settings.llmSource === 'main_api') {
        const mainConfig = getMainApiConfig();
        if (mainConfig) {
            addLog('使用聊天主API配置', 'info');
            return mainConfig;
        }
        addLog('无法获取主API配置，回退到自定义配置', 'warning');
    } else if (settings.llmSource === 'connection_profile' && settings.selectedConnectionProfile) {
        const profileConfig = getConnectionProfileConfig(settings.selectedConnectionProfile);
        if (profileConfig) {
            addLog(`使用连接配置: ${settings.selectedConnectionProfile}`, 'info');
            return profileConfig;
        }
        addLog('无法获取连接配置，回退到自定义配置', 'warning');
    }

    return {
        apiUrl: settings.apiUrl,
        apiKey: settings.apiKey,
        model: settings.model,
    };
}

function updateUI() {
    const settings = extension_settings[extensionName];
    if (!settings) return;

    $('#aiagp_enabled').prop('checked', settings.enabled);
    $('#aiagp_llm_source').val(settings.llmSource);
    $('#aiagp_api_url').val(settings.apiUrl);
    $('#aiagp_api_key').val(settings.apiKey);
    $('#aiagp_model').val(settings.model);
    $('#aiagp_temperature').val(settings.temperature);
    $('#aiagp_max_tokens').val(settings.maxTokens);
    $('#aiagp_history_count').val(settings.historyCount);
    $('#aiagp_system_prompt').val(settings.systemPrompt);
    $('#aiagp_positive_tags').val(settings.positiveTags);
    $('#aiagp_negative_tags').val(settings.negativeTags);
    $('#aiagp_forbidden_words').val(settings.forbiddenWords);
    $('#aiagp_trigger_mode').val(settings.triggerMode);
    $('#aiagp_trigger_keywords').val(settings.triggerKeywords);
    $('#aiagp_insert_type').val(settings.insertType);
    $('#aiagp_caption_position').val(settings.captionPosition);

    // 切换显示的设置项
    $('#keyword_setting').toggle(settings.triggerMode === 'keyword');
    $('#custom_llm_settings').toggle(settings.llmSource === 'custom');
    $('#connection_profile_setting').toggle(settings.llmSource === 'connection_profile');

    // 更新连接配置列表
    updateConnectionProfileList();
}

// 更新连接配置列表
function updateConnectionProfileList() {
    const profileSelect = $('#aiagp_connection_profile');
    const profiles = getConnectionProfileList();
    const currentProfile = getCurrentConnectionProfile();
    const settings = extension_settings[extensionName];

    profileSelect.empty();
    profileSelect.append('<option value="" disabled>选择连接配置...</option>');

    profiles.forEach(profile => {
        const isSelected = settings.selectedConnectionProfile === profile || (!settings.selectedConnectionProfile && currentProfile === profile);
        profileSelect.append(`<option value="${profile}" ${isSelected ? 'selected' : ''}>${profile}</option>`);
    });

    if (currentProfile) {
        profileSelect.append(`<option value="__current__" ${settings.selectedConnectionProfile === '__current__' ? 'selected' : ''}>当前使用: ${currentProfile}</option>`);
    }
}

async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    const settings = extension_settings[extensionName];

    for (const key in defaultSettings) {
        if (settings[key] === undefined) {
            settings[key] = defaultSettings[key];
        }
    }

    updateUI();
}

function setupTabs() {
    const tabs = ['llm', 'prompt', 'general'];
    tabs.forEach(tab => {
        $(`#tab_${tab}`).on('click', function() {
            tabs.forEach(t => {
                $(`#tab_${t}`).removeClass('selected');
                $(`#panel_${t}`).hide();
            });
            $(this).addClass('selected');
            $(`#panel_${tab}`).show();
        });
    });
    $('#tab_llm').addClass('selected');
}

// 渲染模型下拉列表
function renderModelList(models, selectedModel) {
    const listContainer = $('#aiagp_model_list');
    listContainer.empty();

    models.forEach(model => {
        const option = document.createElement('div');
        option.className = `aiagp-model-option ${model === selectedModel ? 'selected' : ''}`;
        option.textContent = model;
        option.onclick = () => {
            $('#aiagp_model').val(model);
            extension_settings[extensionName].model = model;
            saveSettingsDebounced();
            hideModelList();
            addLog(`已选择模型: ${model}`, 'success');
        };
        listContainer.append(option);
    });
}

// 显示模型列表
function showModelList() {
    if (currentModels.length > 0) {
        $('#aiagp_model_list').addClass('show');
    }
}

// 隐藏模型列表
function hideModelList() {
    $('#aiagp_model_list').removeClass('show');
}

async function fetchModels() {
    const config = getCurrentLLMConfig();

    if (!config.apiUrl || !config.apiKey) {
        toastr.error('请先配置API地址和密钥');
        return;
    }

    try {
        addLog('正在拉取模型列表...', 'info');
        const modelsUrl = getModelsUrl(config.apiUrl);
        addLog(`请求地址: ${modelsUrl}`, 'info');

        const response = await fetch(modelsUrl, {
            headers: { 'Authorization': `Bearer ${config.apiKey}` },
        });

        if (!response.ok) throw new Error(`请求失败: ${response.status}`);

        const data = await response.json();
        currentModels = data.data?.map(m => m.id) || [];

        if (currentModels.length > 0) {
            renderModelList(currentModels, config.model);
            if (!currentModels.includes(config.model)) {
                $('#aiagp_model').val(currentModels[0]);
                extension_settings[extensionName].model = currentModels[0];
                saveSettingsDebounced();
            }
            toastr.success(`获取到 ${currentModels.length} 个模型，点击输入框选择`);
            addLog(`模型列表已加载: ${currentModels.join(', ')}`, 'success');
        } else {
            toastr.warning('未获取到模型列表');
        }
    } catch (error) {
        toastr.error(`拉取模型失败: ${error.message}`);
        addLog(`拉取模型失败: ${error.message}`, 'error');
    }
}

async function callLLMForPrompts(chatHistory) {
    const settings = extension_settings[extensionName];
    const config = getCurrentLLMConfig();

    if (!config.apiUrl || !config.apiKey || !config.model) {
        throw new Error('LLM配置不完整');
    }

    const messages = [
        { role: 'system', content: settings.systemPrompt },
    ];

    const context = getContext();
    if (context.characters && context.characterId !== undefined) {
        const char = context.characters[context.characterId];
        if (char) {
            const charInfo = `角色信息：
名称: ${char.name}
描述: ${char.description || ''}
性格: ${char.personality || ''}
场景: ${char.scenario || ''}`;
            messages.push({ role: 'system', content: charInfo });
        }
    }

    if (settings.positiveTags || settings.negativeTags) {
        const tagHint = `提示词要求：
- 英文提示词开头必须包含：${settings.positiveTags || '（无）'}
- 负面提示词必须包含：${settings.negativeTags || '（无）'}
${settings.forbiddenWords ? `- 禁止使用：${settings.forbiddenWords}` : ''}`;
        messages.push({ role: 'system', content: tagHint });
    }

    messages.push(...chatHistory);

    const chatCompletionsUrl = getChatCompletionsUrl(config.apiUrl);
    addLog(`请求地址: ${chatCompletionsUrl}`, 'info');

    const response = await fetch(chatCompletionsUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
            model: config.model,
            messages: messages,
            temperature: parseFloat(settings.temperature),
            max_tokens: parseInt(settings.maxTokens),
        }),
    });

    if (!response.ok) {
        throw new Error(`LLM请求失败: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;

    if (!content) {
        throw new Error('LLM返回空内容');
    }

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        throw new Error('无法解析LLM返回的JSON');
    }

    return JSON.parse(jsonMatch[0]);
}

function getChatHistory() {
    const settings = extension_settings[extensionName];
    const context = getContext();
    const history = [];

    const count = Math.min(parseInt(settings.historyCount) || 5, context.chat.length);
    const startIndex = Math.max(0, context.chat.length - count);

    for (let i = startIndex; i < context.chat.length; i++) {
        const msg = context.chat[i];
        history.push({
            role: msg.is_user ? 'user' : 'assistant',
            content: msg.mes,
        });
    }

    return history;
}

function shouldTrigger(message) {
    const settings = extension_settings[extensionName];

    if (!settings.enabled) return false;
    if (message.is_user) return false;

    if (settings.triggerMode === 'manual') return false;

    if (settings.triggerMode === 'keyword') {
        const keywords = settings.triggerKeywords.split(',').map(k => k.trim().toLowerCase());
        const lastUserMsg = getLastUserMessage();
        if (lastUserMsg) {
            return keywords.some(kw => lastUserMsg.toLowerCase().includes(kw));
        }
        return false;
    }

    return true;
}

function getLastUserMessage() {
    const context = getContext();
    for (let i = context.chat.length - 1; i >= 0; i--) {
        if (context.chat[i].is_user) {
            return context.chat[i].mes;
        }
    }
    return null;
}

async function generateAndInsertImage(messageIndex) {
    const settings = extension_settings[extensionName];
    const context = getContext();

    try {
        addLog('开始生成提示词...', 'info');

        const chatHistory = getChatHistory();
        const result = await callLLMForPrompts(chatHistory);

        addLog(`提示词生成成功: ${result.english_prompt.substring(0, 50)}...`, 'success');

        let englishPrompt = result.english_prompt;
        const chineseCaption = result.chinese_caption;

        if (settings.positiveTags) {
            englishPrompt = settings.positiveTags + ', ' + englishPrompt;
        }

        addLog('调用酒馆生图API...', 'info');

        const imageUrl = await SlashCommandParser.commands['imagine'].callback(
            { quiet: 'true', negative: settings.negativeTags },
            englishPrompt,
        );

        if (!imageUrl || typeof imageUrl !== 'string') {
            throw new Error('生图失败');
        }

        addLog('图片生成成功，正在插入...', 'success');

        const message = context.chat[messageIndex];
        const messageElement = $(`.mes[mesid="${messageIndex}"]`);

        if (!message.extra) message.extra = {};
        message.extra.image = imageUrl;
        message.extra.title = chineseCaption;
        message.extra.inline_image = true;

        if (settings.captionPosition === 'below' || settings.captionPosition === 'both') {
            message.mes = message.mes + '\n\n' + `📷 ${chineseCaption}`;
        }

        appendMediaToMessage(message, messageElement);
        updateMessageBlock(messageIndex, message);
        await context.saveChat();

        addLog('完成！', 'success');
        toastr.success('图片生成成功');

    } catch (error) {
        addLog(`错误: ${error.message}`, 'error');
        toastr.error(`图片生成失败: ${error.message}`);
        console.error(error);
    }
}

async function createSettings(settingsHtml) {
    if (!$('#aiagp_container').length) {
        $('#extensions_settings2').append(
            '<div id="aiagp_container" class="extension_container"></div>',
        );
    }

    $('#aiagp_container').empty().append(settingsHtml);
    logContainer = $('#aiagp_log')[0];

    setupTabs();

    // 模型输入框点击事件
    $('#aiagp_model').on('focus', showModelList);
    $(document).on('click', function(e) {
        if (!$(e.target).closest('#aiagp_model, #aiagp_model_list').length) {
            hideModelList();
        }
    });

    $('#aiagp_enabled').on('change', function() {
        extension_settings[extensionName].enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#aiagp_llm_source').on('change', function() {
        const source = $(this).val();
        extension_settings[extensionName].llmSource = source;
        updateUI();
        saveSettingsDebounced();
    });

    $('#aiagp_connection_profile').on('change', function() {
        let value = $(this).val();
        // 如果选择了"当前使用"，获取真实的当前配置名称
        if (value === '__current__') {
            value = getCurrentConnectionProfile();
        }
        extension_settings[extensionName].selectedConnectionProfile = value;
        saveSettingsDebounced();
    });

    $('#aiagp_api_url, #aiagp_api_key, #aiagp_model, #aiagp_temperature, #aiagp_max_tokens, #aiagp_history_count, #aiagp_system_prompt, #aiagp_positive_tags, #aiagp_negative_tags, #aiagp_forbidden_words, #aiagp_trigger_keywords').on('input', function() {
        const id = $(this).attr('id').replace('aiagp_', '');
        extension_settings[extensionName][id] = $(this).val();
        saveSettingsDebounced();
    });

    $('#aiagp_trigger_mode, #aiagp_insert_type, #aiagp_caption_position').on('change', function() {
        const id = $(this).attr('id').replace('aiagp_', '');
        extension_settings[extensionName][id] = $(this).val();
        updateUI();
        saveSettingsDebounced();
    });

    $('#aiagp_reset_prompt').on('click', function() {
        extension_settings[extensionName].systemPrompt = DEFAULT_SYSTEM_PROMPT;
        $('#aiagp_system_prompt').val(DEFAULT_SYSTEM_PROMPT);
        saveSettingsDebounced();
        toastr.success('提示词已恢复默认');
    });

    $('#aiagp_test_prompt').on('click', async function() {
        const lastMessageId = getLastMessageId();
        if (lastMessageId >= 0) {
            await generateAndInsertImage(lastMessageId);
        } else {
            toastr.warning('没有可用的消息');
        }
    });

    $('#aiagp_fetch_models').on('click', fetchModels);

    $('#aiagp_generate_now').on('click', async function() {
        const lastMessageId = getLastMessageId();
        if (lastMessageId >= 0) {
            await generateAndInsertImage(lastMessageId);
        } else {
            toastr.warning('没有可用的消息');
        }
    });

    $('#aiagp_clear_log').on('click', function() {
        if (logContainer) logContainer.innerHTML = '';
    });
}

function getLastMessageId() {
    const context = getContext();
    return context.chat.length - 1;
}

jQuery(async () => {
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    await loadSettings();
    await createSettings(settingsHtml);

    eventSource.on(event_types.MESSAGE_RECEIVED, async (messageId) => {
        const context = getContext();
        const message = context.chat[messageId];
        if (message && shouldTrigger(message)) {
            await generateAndInsertImage(messageId);
        }
    });

    addLog('Image Auto Gen Pro 已加载', 'success');
});
