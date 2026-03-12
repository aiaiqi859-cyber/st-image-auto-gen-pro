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
    llmSource: 'tavern', // 'tavern' | 'tavern_profile' | 'custom'
    selectedProfileId: '',
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

function getTavernHelper() {
    try {
        if (window.TavernHelper) {
            return window.TavernHelper;
        }
    } catch (e) {
        console.log('酒馆助手不可用:', e);
    }
    return null;
}

function getConnectionProfiles() {
    const context = getContext();
    try {
        if (context.mainApi && context.mainApi.profiles) {
            return Object.keys(context.mainApi.profiles);
        }
    } catch (e) {
        console.log('无法获取连接配置列表:', e);
    }
    return [];
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

    $('#keyword_setting').toggle(settings.triggerMode === 'keyword');
    $('#custom_llm_settings').toggle(settings.llmSource === 'custom');
    $('#connection_profile_setting').toggle(settings.llmSource === 'tavern_profile');

    updateConnectionProfileList();
}

function updateConnectionProfileList() {
    const profileSelect = $('#aiagp_connection_profile');
    const profiles = getConnectionProfiles();
    const settings = extension_settings[extensionName];

    profileSelect.empty();
    profileSelect.append('<option value="" disabled>选择连接配置...</option>');

    profiles.forEach(profile => {
        const isSelected = settings.selectedProfileId === profile;
        profileSelect.append(`<option value="${profile}" ${isSelected ? 'selected' : ''}>${profile}</option>`);
    });
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

async function callLLMForPrompts(chatHistory) {
    const settings = extension_settings[extensionName];
    const helper = getTavernHelper();

    if (!helper?.generateRaw && !helper?.generate) {
        throw new Error('酒馆助手不可用，请先安装酒馆助手');
    }

    let systemPrompt = settings.systemPrompt;
    const context = getContext();

    if (context.characters && context.characterId !== undefined) {
        const char = context.characters[context.characterId];
        if (char) {
            const charInfo = `角色信息：
名称: ${char.name}
描述: ${char.description || ''}
性格: ${char.personality || ''}
场景: ${char.scenario || ''}`;
            systemPrompt += '\n\n' + charInfo;
        }
    }

    if (settings.positiveTags || settings.negativeTags) {
        const tagHint = `\n\n提示词要求：
- 英文提示词开头必须包含：${settings.positiveTags || '（无）'}
- 负面提示词必须包含：${settings.negativeTags || '（无）'}
${settings.forbiddenWords ? `- 禁止使用：${settings.forbiddenWords}` : ''}`;
        systemPrompt += tagHint;
    }

    let userPrompt = '';
    chatHistory.forEach(msg => {
        userPrompt += `${msg.role === 'user' ? '用户' : '角色'}: ${msg.content}\n`;
    });

    let customApiConfig = null;
    if (settings.llmSource === 'custom') {
        addLog('使用自定义API配置', 'info');
        customApiConfig = {
            apiurl: settings.apiUrl,
            key: settings.apiKey,
            model: settings.model,
            source: 'openai',
            temperature: parseFloat(settings.temperature),
            max_tokens: parseInt(settings.maxTokens),
        };
    } else if (settings.llmSource === 'tavern_profile' && settings.selectedProfileId) {
        addLog(`使用连接配置: ${settings.selectedProfileId}`, 'info');
        customApiConfig = {
            source: 'tavern_profile',
            profile_id: settings.selectedProfileId,
            temperature: parseFloat(settings.temperature),
            max_tokens: parseInt(settings.maxTokens),
        };
    } else {
        addLog('使用酒馆主API配置', 'info');
    }

    let content;

    if (helper.generateRaw) {
        addLog('调用 generateRaw...', 'info');
        const prompts = [];
        prompts.push({ role: 'system', content: systemPrompt });
        prompts.push('user_input');

        content = await helper.generateRaw({
            user_input: userPrompt,
            ordered_prompts: prompts,
            custom_api: customApiConfig,
            should_stream: false,
            should_silence: true,
        });
    } else if (helper.generate) {
        addLog('调用 generate...', 'info');
        content = await helper.generate({
            user_input: userPrompt,
            system_prompt: systemPrompt,
            max_chat_history: 0,
            custom_api: customApiConfig,
            should_stream: false,
            should_silence: true,
        });
    } else {
        throw new Error('无可用的生成API');
    }

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

        if (!Array.isArray(message.extra.image_swipes)) {
            message.extra.image_swipes = [];
        }

        if (message.extra.image && !message.extra.image_swipes.includes(message.extra.image)) {
            message.extra.image_swipes.push(message.extra.image);
        }

        message.extra.image_swipes.push(imageUrl);
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
        const value = $(this).val();
        extension_settings[extensionName].selectedProfileId = value;
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
    await createSettings(settingsHtml);
    await loadSettings();

    eventSource.on(event_types.MESSAGE_RECEIVED, async (messageId) => {
        const context = getContext();
        const message = context.chat[messageId];
        if (shouldTrigger(message)) {
            await generateAndInsertImage(messageId);
        }
    });

    addLog('Image Auto Gen Pro 已加载', 'success');
});
