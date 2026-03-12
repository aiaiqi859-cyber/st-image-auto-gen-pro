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

function updateUI() {
    const settings = extension_settings[extensionName];
    if (!settings) return;

    $('#aiagp_enabled').prop('checked', settings.enabled);
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

    if (!settings.apiUrl || !settings.apiKey || !settings.model) {
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

    const response = await fetch(`${settings.apiUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
            model: settings.model,
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

async function fetchModels() {
    const settings = extension_settings[extensionName];

    if (!settings.apiUrl || !settings.apiKey) {
        toastr.error('请先配置API地址和密钥');
        return;
    }

    try {
        const response = await fetch(`${settings.apiUrl}/models`, {
            headers: { 'Authorization': `Bearer ${settings.apiKey}` },
        });

        if (!response.ok) throw new Error(`请求失败: ${response.status}`);

        const data = await response.json();
        const models = data.data?.map(m => m.id) || [];

        if (models.length > 0) {
            const modelInput = $('#aiagp_model');
            modelInput.val(models[0]);
            toastr.success(`获取到 ${models.length} 个模型`);
            addLog(`模型列表: ${models.join(', ')}`, 'info');
        }
    } catch (error) {
        toastr.error(`拉取模型失败: ${error.message}`);
        addLog(`拉取模型失败: ${error.message}`, 'error');
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

    $('#aiagp_api_url').on('input', function() {
        extension_settings[extensionName].apiUrl = $(this).val();
        saveSettingsDebounced();
    });

    $('#aiagp_api_key').on('input', function() {
        extension_settings[extensionName].apiKey = $(this).val();
        saveSettingsDebounced();
    });

    $('#aiagp_model').on('input', function() {
        extension_settings[extensionName].model = $(this).val();
        saveSettingsDebounced();
    });

    $('#aiagp_temperature').on('input', function() {
        extension_settings[extensionName].temperature = $(this).val();
        saveSettingsDebounced();
    });

    $('#aiagp_max_tokens').on('input', function() {
        extension_settings[extensionName].maxTokens = $(this).val();
        saveSettingsDebounced();
    });

    $('#aiagp_history_count').on('input', function() {
        extension_settings[extensionName].historyCount = $(this).val();
        saveSettingsDebounced();
    });

    $('#aiagp_system_prompt').on('input', function() {
        extension_settings[extensionName].systemPrompt = $(this).val();
        saveSettingsDebounced();
    });

    $('#aiagp_positive_tags').on('input', function() {
        extension_settings[extensionName].positiveTags = $(this).val();
        saveSettingsDebounced();
    });

    $('#aiagp_negative_tags').on('input', function() {
        extension_settings[extensionName].negativeTags = $(this).val();
        saveSettingsDebounced();
    });

    $('#aiagp_forbidden_words').on('input', function() {
        extension_settings[extensionName].forbiddenWords = $(this).val();
        saveSettingsDebounced();
    });

    $('#aiagp_trigger_mode').on('change', function() {
        extension_settings[extensionName].triggerMode = $(this).val();
        $('#keyword_setting').toggle($(this).val() === 'keyword');
        saveSettingsDebounced();
    });

    $('#aiagp_trigger_keywords').on('input', function() {
        extension_settings[extensionName].triggerKeywords = $(this).val();
        saveSettingsDebounced();
    });

    $('#aiagp_insert_type').on('change', function() {
        extension_settings[extensionName].insertType = $(this).val();
        saveSettingsDebounced();
    });

    $('#aiagp_caption_position').on('change', function() {
        extension_settings[extensionName].captionPosition = $(this).val();
        saveSettingsDebounced();
    });

    $('#aiagp_fetch_models').on('click', fetchModels);

    $('#aiagp_reset_prompt').on('click', function() {
        extension_settings[extensionName].systemPrompt = DEFAULT_SYSTEM_PROMPT;
        $('#aiagp_system_prompt').val(DEFAULT_SYSTEM_PROMPT);
        saveSettingsDebounced();
        toastr.info('已恢复默认提示词');
    });

    $('#aiagp_test_prompt').on('click', async function() {
        addLog('测试提示词生成...', 'info');
        try {
            const history = getChatHistory();
            const result = await callLLMForPrompts(history);
            addLog(`测试成功!\n英文: ${result.english_prompt}\n中文: ${result.chinese_caption}`, 'success');
        } catch (e) {
            addLog(`测试失败: ${e.message}`, 'error');
        }
    });

    $('#aiagp_generate_now').on('click', async function() {
        const context = getContext();
        if (context.chat.length > 0) {
            await generateAndInsertImage(context.chat.length - 1);
        }
    });

    $('#aiagp_clear_log').on('click', function() {
        if (logContainer) logContainer.innerHTML = '';
    });

    updateUI();
}

function onExtensionButtonClick() {
    const extensionsDrawer = $('#extensions-settings-button .drawer-toggle');
    if ($('#rm_extensions_block').hasClass('closedDrawer')) {
        extensionsDrawer.trigger('click');
    }

    setTimeout(() => {
        const container = $('#aiagp_container');
        if (container.length) {
            $('#rm_extensions_block').animate({
                scrollTop: container.offset().top - $('#rm_extensions_block').offset().top + $('#rm_extensions_block').scrollTop(),
            }, 500);
            const drawerContent = container.find('.inline-drawer-content');
            const drawerHeader = container.find('.inline-drawer-header');
            if (drawerContent.is(':hidden') && drawerHeader.length) {
                drawerHeader.trigger('click');
            }
        }
    }, 500);
}

$(function () {
    (async function () {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);

        $('#extensionsMenu').append(`<div id="aiagp_menu" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-images"></div>
            <span data-i18n="Image Auto Gen Pro">Image Auto Gen Pro</span>
        </div>`);

        $('#aiagp_menu').off('click').on('click', onExtensionButtonClick);

        await loadSettings();
        await createSettings(settingsHtml);

        $('#extensions-settings-button').on('click', function () {
            setTimeout(() => {
                updateUI();
            }, 200);
        });
    })();
});

eventSource.on(event_types.MESSAGE_RECEIVED, async function () {
    const context = getContext();
    if (context.chat.length === 0) return;

    const message = context.chat[context.chat.length - 1];
    if (!shouldTrigger(message)) return;

    setTimeout(() => {
        generateAndInsertImage(context.chat.length - 1);
    }, 100);
});
