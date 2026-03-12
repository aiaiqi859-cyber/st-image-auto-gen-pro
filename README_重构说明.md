# Image Auto Gen Pro - 重构说明

## 重构背景

参考 Engram 插件的实现，重构为使用 `window.TavernHelper` API 调用大模型。

## 主要改动

### 1. LLM 调用方式变更
- **之前**: 直接通过 `fetch` 调用 OpenAI 兼容 API
- **现在**: 通过 `window.TavernHelper.generate()` 或 `generateRaw()` 调用

### 2. LLM 来源选项
- `tavern`: 使用酒馆主 API（聊天所用的 API）
- `tavern_profile`: 使用酒馆连接配置
- `custom`: 自定义 API 配置（仍然支持）

### 3. 支持的 TavernHelper API

```typescript
interface TavernHelper {
  generate(options): Promise<string>;
  generateRaw(options): Promise<string>;
}
```

### 4. 核心调用逻辑

```javascript
// 使用 generateRaw（推荐）
const content = await helper.generateRaw({
  user_input: userPrompt,
  ordered_prompts: [
    { role: 'system', content: systemPrompt },
    'user_input'
  ],
  custom_api: customApiConfig,
  should_stream: false,
  should_silence: true,
});

// 使用 generate
const content = await helper.generate({
  user_input: userPrompt,
  system_prompt: systemPrompt,
  max_chat_history: 0,
  custom_api: customApiConfig,
  should_stream: false,
  should_silence: true,
});
```

### 5. custom_api 配置格式

#### 自定义 API
```javascript
{
  apiurl: 'https://api.openai.com/v1',
  key: 'sk-...',
  model: 'gpt-4',
  source: 'openai',
  temperature: 0.7,
  max_tokens: 1000,
}
```

#### 连接配置
```javascript
{
  source: 'tavern_profile',
  profile_id: 'my_profile',
  temperature: 0.7,
  max_tokens: 1000,
}
```

## 文件变更

- `index.js`: 完全重写 LLM 调用逻辑
- `settings.html`: 更新 LLM 来源选项

## 参考项目

Engram 插件: https://github.com/.../Engram
