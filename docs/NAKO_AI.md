# Nako AI 集成文档

## 简介

Nako 是集成在 Nightcord 聊天室中的 AI 助手，基于 Qwen3-30B 模型，支持流式输出。

## 使用方法

### 触发 Nako

在聊天输入框中输入以下任一格式：

**1. @Nako 开头**
```
@Nako 你好
@Nako 请帮我写一首诗
```

**2. /nako 命令**
```
/nako 你好
/nako 解释一下量子计算
```

**3. 句中提及（推荐）**
```
@Nako 今天天气真好啊
我觉得 @Nako 你说得对
@Nako 你觉得呢？
```

**4. /clear 命令（清除上下文）**
```
/clear
```

清除 Nako 的对话上下文。执行后，下次与 Nako 对话时将不携带历史消息，相当于开始一个全新的对话。

### 示例对话

```
UserA: 早上好
UserB: 早上好
UserA: @Nako 你觉得今天天气怎么样？
Nako: 哼...天气好又怎样...
UserB: 哈哈，@Nako 你今天心情不好吗？
Nako: 关你什么事...
```

## 功能特性

### 1. 流式输出

- **调用者体验**：输入问题后，立即看到 Nako 的流式回复（打字效果）
- **其他用户体验**：看到完整的 Nako 回复

### 2. 消息标记

Nako 的消息在服务器端使用 `[Nako]` 前缀标记，前端会自动识别并处理：

```
服务器消息：[Nako]你好！我是 Nako，很高兴认识你。
前端显示：你好！我是 Nako，很高兴认识你。
```

### 3. 去重机制

调用者本地显示流式输出后，会收到服务器广播的完整消息。系统会自动去重，避免重复显示。

### 4. 上下文管理

- Nako 默认会携带最近 15 条对话历史
- 使用 `/clear` 命令可以清除上下文，下次对话将不携带历史消息
- 清除上下文后，Nako 会像第一次对话一样回复

## 技术实现

### 架构

```
前端 ←─ WebSocket ─→ 广播服务器（聊天）
前端 ←─ HTTP API ─→ Nako AI 服务器
```

### 模块结构

```
Nightcord (应用协调器)
  ├── EventBus (事件总线)
  ├── NightcordManager (业务逻辑)
  ├── NakoAIService (AI 服务) ← 新增
  └── UIManager (UI 渲染)
```

### 消息流程

#### 流式模式（默认）

1. 用户输入 `@Nako 问题`
2. 前端先广播用户的问题（所有人看到）
3. UIManager 检测到 Nako 触发，发出 `nako:ask` 事件
4. Nightcord 获取当前用户 ID 和最近 10 条对话历史
5. NakoAIService 调用 Nako API（传入 userId、history 和 stream: true）
6. API 返回 SSE 流式响应
7. NakoAIService 实时接收 SSE 数据，发出 `nako:stream:chunk` 事件
8. UIManager 监听事件，实时更新显示（调用者看到真正的打字效果）
9. 完成后，UIManager 通过 WebSocket 发送 `[Nako]完整回复`
10. 服务器广播给所有用户
11. 调用者自动去重，其他用户看到完整消息

#### 非流式模式

1-5. 同上
6. API 返回完整 JSON 响应
7. NakoAIService 模拟流式输出，逐字发出 `nako:stream:chunk` 事件
8-11. 同上

### API 格式

#### 流式模式（默认，推荐）

**请求**：

```json
POST https://nako.nightcord.de5.net/api/chat
Content-Type: application/json

{
  "userId": "UserA",
  "message": "今天天气真好啊",
  "stream": true,
  "history": [
    {
      "userId": "UserB",
      "message": "早上好",
      "isBot": false
    },
    {
      "userId": "Nako",
      "message": "哼...早什么早",
      "isBot": true
    }
  ]
}
```

**响应**（SSE 流式）：

```
Content-Type: text/event-stream

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1770659494,"model":"@cf/qwen/qwen3-30b-a3b-fp8","choices":[{"index":0,"delta":{"role":"assistant","content":""},"logprobs":null,"finish_reason":null}],"usage":{"prompt_tokens":411,"total_tokens":411,"completion_tokens":0}}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1770659494,"model":"@cf/qwen/qwen3-30b-a3b-fp8","choices":[{"index":0,"delta":{"reasoning_content":"思考过程..."},"logprobs":null,"finish_reason":null}],"usage":{"prompt_tokens":411,"total_tokens":413,"completion_tokens":2}}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1770659494,"model":"@cf/qwen/qwen3-30b-a3b-fp8","choices":[{"index":0,"delta":{"content":"哈"},"logprobs":null,"finish_reason":null}],"usage":{"prompt_tokens":411,"total_tokens":642,"completion_tokens":231}}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1770659494,"model":"@cf/qwen/qwen3-30b-a3b-fp8","choices":[{"index":0,"delta":{"content":"？"},"logprobs":null,"finish_reason":null}],"usage":{"prompt_tokens":411,"total_tokens":643,"completion_tokens":232}}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1770659494,"model":"@cf/qwen/qwen3-30b-a3b-fp8","choices":[{"index":0,"delta":{"content":"有"},"logprobs":null,"finish_reason":null}],"usage":{"prompt_tokens":411,"total_tokens":644,"completion_tokens":233}}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1770659494,"model":"@cf/qwen/qwen3-30b-a3b-fp8","choices":[{"index":0,"delta":{"content":"事"},"logprobs":null,"finish_reason":null}],"usage":{"prompt_tokens":411,"total_tokens":645,"completion_tokens":234}}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1770659494,"model":"@cf/qwen/qwen3-30b-a3b-fp8","choices":[{"index":0,"delta":{"content":"？"},"logprobs":null,"finish_reason":null}],"usage":{"prompt_tokens":411,"total_tokens":646,"completion_tokens":235}}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1770659494,"model":"@cf/qwen/qwen3-30b-a3b-fp8","choices":[{"index":0,"delta":{"content":""},"logprobs":null,"finish_reason":"stop"}],"usage":{"prompt_tokens":411,"total_tokens":652,"completion_tokens":241}}

data: [DONE]
```

**格式说明**：
- `delta.reasoning_content`：思考过程（前端忽略，不显示）
- `delta.content`：最终输出内容（前端显示）
- `finish_reason: "stop"`：表示生成完成
- `data: [DONE]`：流结束标记

#### 非流式模式

**请求**：

```json
POST https://nako.nightcord.de5.net/api/chat
Content-Type: application/json

{
  "userId": "UserA",
  "message": "今天天气真好啊",
  "history": []
}
```

**响应**（JSON）：

```json
{
  "success": true,
  "response": "哼,天气好又怎样...",
  "usage": {
    "promptTokens": 245,
    "completionTokens": 42,
    "totalTokens": 287
  }
}
```

**注意**：
- 流式模式：实时接收 SSE 流，真正的打字效果
- 非流式模式：等待完整响应，前端模拟打字效果
- `history` 包含最近 10 条对话记录
- `isBot` 标记是否是 Nako 的消息

### 代码位置

- **AI 服务层**：`nako-ai-service.js` - NakoAIService 类
  - `ask()` - 调用 Nako API
  - `processStream()` - 处理流式响应
  - `cancel()` - 取消请求
- **消息标记处理**：`nightcord-mgr.js` - `handleMessage()` 方法
- **UI 事件监听**：`ui-manager.js` - `setupNakoEventListeners()` 方法
- **流式显示**：`ui-manager.js` - `startStreamingMessage()`, `appendStreamingContent()`, `finishStreamingMessage()`
- **输入触发检测**：`ui-manager.js` - `setupChatRoom()` 中的 keydown 事件监听器
- **去重逻辑**：`ui-manager.js` - `setupEventListeners()` 中的 `message:received` 事件处理
- **应用协调**：`nightcord.js` - 初始化 NakoAIService 并连接事件

## 自定义配置

### 修改 API 地址

在 `nightcord.js` 初始化时传入配置：

```javascript
const app = new Nightcord({
  nakoApiUrl: 'https://your-api.com/api/chat',
  nakoStream: true  // 启用流式（默认）
});
app.init();
```

或者直接修改 `nako-ai-service.js` 的默认值：

```javascript
this.apiUrl = config.apiUrl || 'https://your-api.com/api/chat';
this.stream = config.stream !== false; // 默认启用流式
```

### 禁用流式模式

如果 API 不支持流式，可以禁用：

```javascript
const app = new Nightcord({
  nakoStream: false  // 禁用流式，使用模拟打字效果
});
app.init();
```

### 修改触发命令

在 `ui-manager.js` 的 `setupChatRoom()` 方法中修改：

```javascript
// 当前支持三种触发方式：
// 1. @Nako 开头
// 2. /nako 命令
// 3. 句中包含 @Nako

const nakoMention = message.match(/@Nako/i);
const nakoCommand = message.match(/^\/nako\s+(.+)/i);

if (nakoMention || nakoCommand) {
  // 触发 Nako
}
```

如果只想支持特定触发方式，可以修改条件：

```javascript
// 只支持 @Nako 开头
if (message.startsWith('@Nako ')) {
  // ...
}

// 只支持 /nako 命令
if (message.startsWith('/nako ')) {
  // ...
}

// 支持任意位置的 @Nako
if (message.includes('@Nako')) {
  // ...
}
```

### 修改 AI 名称

在 `nightcord.js` 初始化时传入配置：

```javascript
const app = new Nightcord({
  nakoName: 'AI助手'
});
app.init();
```

### 修改超时时间

在 `nightcord.js` 初始化时传入配置：

```javascript
const app = new Nightcord();
app.getNakoService().timeout = 120000; // 120秒
```

### 外部调用 Nako

```javascript
const app = new Nightcord();
app.init();

// 获取 Nako 服务
const nakoService = app.getNakoService();

// 直接调用（带历史记录）
nakoService.ask('你好', {
  userId: 'UserA',
  history: [
    { userId: 'UserB', message: '早上好', isBot: false },
    { userId: 'Nako', message: '哼...早什么早', isBot: true }
  ]
}).then(response => {
  console.log('Nako 回复:', response);
});

// 取消请求
nakoService.cancelAll();
```

## 错误处理

### API 调用失败

如果 Nako API 调用失败，会显示错误消息：

```
系统: 错误: Nako 调用失败: [错误详情]
```

### 空响应

如果 Nako 返回空响应，会显示错误：

```
系统: 错误: Nako 调用失败: Nako 返回了空响应
```

### 网络错误

如果网络连接失败，会显示相应的错误消息。

## 贡献

欢迎提交 Issue 和 Pull Request！
