# Nightcord

<div align="center">

![GitHub License](https://img.shields.io/github/license/25-ji-code-de/nightcord?style=flat-square&color=884499)
![GitHub stars](https://img.shields.io/github/stars/25-ji-code-de/nightcord?style=flat-square&color=884499)
![GitHub forks](https://img.shields.io/github/forks/25-ji-code-de/nightcord?style=flat-square&color=884499)
![GitHub issues](https://img.shields.io/github/issues/25-ji-code-de/nightcord?style=flat-square&color=884499)
![GitHub last commit](https://img.shields.io/github/last-commit/25-ji-code-de/nightcord?style=flat-square&color=884499)
![GitHub repo size](https://img.shields.io/github/repo-size/25-ji-code-de/nightcord?style=flat-square&color=884499)
[![CodeFactor](https://img.shields.io/codefactor/grade/github/25-ji-code-de/nightcord?style=flat-square&color=884499)](https://www.codefactor.io/repository/github/25-ji-code-de/nightcord)

</div>

一个采用现代化、模块化架构设计的实时聊天应用。

## ✨ 特性

- 🎯 **高度解耦** - UI、业务逻辑、网络通信完全分离
- 📡 **事件驱动** - 使用发布-订阅模式实现组件间通信
- 🔄 **自动重连** - WebSocket 断线自动重连
- 🧩 **可扩展** - 通过插件系统轻松添加新功能
- 📦 **模块化** - ES6 模块，每个类都是独立文件
- 🧪 **易测试** - 单一职责，易于单元测试
- 📝 **完整文档** - API 文档、架构文档、示例文档
- 🤖 **AI 集成** - 内置 Nako AI 助手，支持流式对话
- 🔐 **SSO 认证** - 集成 SEKAI Pass 单点登录
- 📊 **数据上报** - 自动上报用户活动到 SEKAI Platform

### @ 提及

在输入框输入 `@` 或点击 `@` 按钮，可选择成员、`everyone` 或 AI。
成员提及绑定用户 ID，同名用户会分开列出，改名后仍能收到提及。点击消息中的成员提及可查看资料。
`@everyone` 会提醒当前房间的所有接收者；个人提及与全体提及都会高亮消息，并显示可跳转到消息的站内提醒。
历史回放、重复消息和自己发出的消息不会弹出提醒。

选择 Nako、Asagi、Miku 或汤川唯后输入问题并发送，会调用对应 AI。点击消息中的 AI 提及可在输入框继续提问。
每次发送调用一个 AI，接收消息不会重复调用；`@Nako`、`/nako` 等原有写法仍可使用。
`role` 类型保留渲染支持，等待自定义身份组功能，不会触发群体提醒。

### Emoji

输入 `::` 可打开表情选择器，也可以输入 `:joy:` 等名称。直接输入或粘贴的 Unicode emoji
会使用同一套表情图片显示，例如 `😂` 与 `:joy:` 显示相同。复制消息时保留输入的原文，
所以输入的 `😂` 复制后仍是 `😂`。表情库尚未收录的组合或肤色变体保留原样。

Unicode 映射由 `scripts/generate-emoji-unicode.mjs` 生成。更新表情库后，下载
[Unicode Emoji 17.0 数据](https://unicode.org/Public/17.0.0/emoji/emoji-test.txt)，
运行 `node scripts/generate-emoji-unicode.mjs <emoji-test.txt 路径>` 即可更新映射。

## 📁 项目结构

```
.
├── event-bus.js              # 事件总线
├── websocket-mgr.js          # WebSocket 管理器
├── nightcord-mgr.js          # 聊天室管理器（NightcordManager）
├── storage-manager.js        # 本地存储管理器
├── sekai-pass-auth.js        # SEKAI Pass OAuth 客户端
├── sekai-analytics.js        # SEKAI Analytics 事件上报服务
├── nako-ai-service.js        # Nako AI 服务
├── ui-manager.js             # UI 管理器（主控）
├── ui-sticker-service.js     # UI 贴纸服务（贴纸渲染与数据）
├── ui-autocomplete.js        # UI 自动补全（@提及与贴纸补全）
├── nightcord.js              # 主应用类（Nightcord）
├── index.html                # HTML 入口文件
├── manifest.json             # PWA 清单
├── sw.js                     # Service Worker（离线外壳，network-first）
├── pwa.js                    # PWA 引导（注册 SW、更新时激活新 SW）
├── icons/                    # 主屏图标、favicon 与 mark 矢量源
├── docs/API.md               # API 文档
├── docs/ARCHITECTURE.md      # 架构文档
├── docs/NAKO_AI.md           # Nako AI 文档
└── docs/EXAMPLES.md          # 扩展示例
```

## 🚀 快速开始

### 基本使用

```html
<!DOCTYPE html>
<html>
<head>
  <title>Nightcord</title>
</head>
<body>
  <!-- 你的 HTML 结构 -->
  
  <script type="module">
  import { Nightcord } from './nightcord.js';
    
  // 创建并初始化应用
  const app = new Nightcord();
  app.init();
    
  // 暴露到全局（可选）
  window.chatApp = app;
  </script>
</body>
</html>
```

### 自定义配置

```javascript
const app = new Nightcord({
  hostname: 'your-chat-server.com'
});
app.init();
```

### 自部署聊天后端

默认聊天室后端为 `chat.nightcord.de5.net`。Worker 源码、Cloudflare 配置、
本地验证和部署步骤见 [backend/README.md](backend/README.md)。前端构建命令为
`node scripts/build-pages.mjs`，Cloudflare Pages 输出目录为 `dist`。
本地静态预览可使用 `http://localhost:8000` 或 `http://127.0.0.1:8000`；
连接正式聊天后端需要浏览器允许该本地页面使用第三方 Cookie。若浏览器阻止，
请在正式站 `https://nightcord.de5.net` 验证。正式站使用同站 Cookie，不依赖第三方 Cookie。

## CSP 与 Cloudflare

HTML 经 Pages Functions 的 `functions/_middleware.js` 设置 CSP，每个响应生成随机
nonce，让 Cloudflare JavaScript Detections 从响应头继承；业务启动代码放在 `boot.js`。
内联脚本、内联事件处理器及动态求值被禁止，Web Analytics 和 Rocket Loader 的脚本域名
显式放行。图片、媒体和网络连接的完整来源策略仍为 Report-Only，避免阻断消息中的外部媒体。

Pages 构建命令为 `node scripts/build-pages.mjs`、输出目录为 `dist`，并需要一并部署
仓库根目录的 `functions/`。`_routes.json` 让脚本、样式、图标等静态资源直接交给 Pages。
本地连同 CSP 验证请运行 `npx wrangler@latest pages dev dist --compatibility-date=2026-11-05`；
普通静态服务器不会运行 Functions，也不会应用 `_headers`。

违规经 `report-to`（及旧浏览器的 `report-uri`）送到 `/csp-report`，以 `csp-violation`
结构化日志输出。可在 Pages 部署的实时日志或
`npx wrangler pages deployment tail --project-name=nightcord-web` 中查看；当前不保存历史报告。
接收器限制请求大小和批量数量，不记录 URL 查询参数、片段、脚本样本或 nonce。
上线后还应核对 Cloudflare 处理后的 HTML：检测脚本的 nonce 要与响应头一致，
统计脚本应能加载并向本站 `/cdn-cgi/rum` 发出请求，不能只检查仓库内的 HTML。

## 📱 PWA 与离线

站点带有 `manifest.json` 与 Service Worker，可安装为独立窗口应用：

- Chrome / Edge：地址栏右侧的安装图标，或菜单 →「安装 Nightcord」。
- iOS Safari：分享 →「添加到主屏幕」。图标与状态栏 meta 在安装时固化，修改后需删除图标重新添加。

离线只保证**应用外壳 + localStorage 里的历史消息**；聊天本身仍然需要网络。

更新流程只有一条：`version-checker.js` 每 30 秒以 `no-store` 检查 `/version.json`，
版本变化时显示 Update Toast；用户点击后才刷新。新 Service Worker 默认处于 `waiting`，
不会自动 `skipWaiting`，也不会自动刷新页面，避免聊天输入被清空。

维护 Service Worker 时请遵守以下约定（`test/pwa.test.mjs` 会检查）：

- 新增入口脚本或样式后，必须同步加入 `sw.js` 的 `PRECACHE`，否则测试会失败。
- 预缓存键是 `/`，不是 `/index.html`（后者会 308 到 `/`）。
- 不要预缓存 `/version.json`、`/sw.js`、`/api/*` 或音频；`/version.json` 永远走网络。
- 在线时代码一律 network-first，缓存只作离线兜底；不要把它改成 cache-first。
- 站点对未知路径返回 `200 + index.html`，因此写入缓存前必须校验 Content-Type。
- 图标由 `node scripts/generate-icons.mjs` 生成（几何同 `icons/nightcord-mark.svg`），勿手改：
  favicon / icon-192 / icon-512 是圆形底 + 透明四角；maskable 是满幅方形，圆角交给系统遮罩。
  `apple-touch-icon.png` 例外 —— 用设计提供的 180×180 液态玻璃稿，生成器不会覆盖它。
  底色统一用 `#99509A`，不要用 `apple-touch-icon-purple.png`
  （底色是 `#945397`，与主色不一致）。

## 📚 文档

- **[API.md](./docs/API.md)** - 详细的 API 文档，包含所有类和方法的说明
- **[ARCHITECTURE.md](./docs/ARCHITECTURE.md)** - 架构设计文档，解释设计原则和数据流
- **[NAKO_AI.md](./docs/NAKO_AI.md)** - Nako AI 集成文档，使用方法和技术实现
- **[EXAMPLES.md](./docs/EXAMPLES.md)** - 扩展示例，展示如何添加新功能
- **[LOCAL_STORAGE.md](./docs/LOCAL_STORAGE.md)** - 本地存储（localStorage）键名、迁移与调试说明

## 🏗️ 架构概览

```
Nightcord (应用协调器)
  ├── EventBus (事件总线)
  ├── NightcordManager (业务逻辑)
  │   └── WebSocketManager (网络通信)
  ├── NakoAIService (AI 服务)
  └── UIManager (UI 渲染主控)
      ├── StickerService (贴纸解析与加载)
      └── AutocompleteManager (自动补全控制)
      └── StorageManager (存储访问)
```

### 核心类

#### EventBus
事件总线，提供发布-订阅机制，实现组件间解耦通信。

```javascript
const eventBus = new EventBus();
eventBus.on('message:received', (data) => {
  console.log('收到消息:', data);
});
eventBus.emit('message:received', { text: 'Hello' });
```

#### WebSocketManager
WebSocket 连接管理器，处理连接、断开、重连等。

```javascript
const wsManager = new WebSocketManager({
  hostname: 'example.com',
  onMessage: (data) => console.log(data)
});
wsManager.connect('nightcord-default', 'K');
```

#### NightcordManager
聊天室业务逻辑管理器（NightcordManager），完全独立于 UI。

```javascript
const chatRoom = new NightcordManager({ eventBus });
chatRoom.setUser('K');
chatRoom.joinRoom('nightcord-default');
chatRoom.sendMessage('As always, at 25:00.');
```

#### UIManager
UI 管理器，作为 UI 层的主控类，协调 DOM 操作、用户交互以及各个 UI 子模块。

```javascript
const ui = new UIManager(eventBus);
ui.addChatMessage('K', 'As always, at 25:00.');
ui.setupChatRoom((message) => {
  console.log('发送消息:', message);
});
```

#### StickerService
贴纸服务模块，负责贴纸数据的异步加载、缓存以及将消息文本渲染为带图片的 DOM 片段。

#### AutocompleteManager
自动补全管理器，处理输入框中的 `@` 提及用户和 `[` 贴纸指令的实时建议与补全输入。

#### Nightcord
主应用类（Nightcord），协调各个管理器。

```javascript
const app = new Nightcord();
app.init();

// 获取状态
const state = app.getState();
console.log(state.username, state.roomname);

// 使用 Nako AI
app.getNakoService().ask('你好').then(response => {
  console.log('Nako:', response);
});
```

#### NakoAIService
Nako AI 服务，负责调用 AI API 和处理流式响应。

```javascript
const nakoService = new NakoAIService({
  eventBus,
  apiUrl: 'https://nako.nightcord.de5.net/api/chat'
});

// 监听事件
eventBus.on('nako:stream:chunk', (data) => {
  console.log('收到片段:', data.chunk);
});

// 调用 AI
nakoService.ask('你好');
```

## 🔌 扩展示例

### 1. 监听消息

```javascript
const eventBus = chatApp.getEventBus();

eventBus.on('message:received', (data) => {
  console.log(`${data.name}: ${data.message}`);
});
```

### 2. 自动回复机器人

```javascript
eventBus.on('message:received', (data) => {
  if (data.message.includes('@bot')) {
    setTimeout(() => {
  chatApp.getChatRoomManager().sendMessage('我是机器人！');
    }, 1000);
  }
});
```

### 3. 消息过滤

```javascript
const blockedWords = ['spam', 'advertisement'];

eventBus.on('message:received', (data) => {
  const hasBlockedWord = blockedWords.some(word => 
    data.message.toLowerCase().includes(word)
  );
  
  if (hasBlockedWord) {
    console.log('Blocked spam message');
    // 阻止显示
  }
});
```

### 4. 保存聊天历史

```javascript
const history = [];

eventBus.on('message:received', (data) => {
  history.push(data);
  localStorage.setItem('chatHistory', JSON.stringify(history));
});
```

更多示例请查看 [EXAMPLES.md](./EXAMPLES.md)

## 💾 本地存储（localStorage）说明

Nightcord 在浏览器端会把若干最近的聊天消息缓存在 `localStorage` 中，目的是在断网或刷新后为用户展示本地历史记录。

- 按房间存储：每个房间的消息存到 `nightcord-messages:<roomname>`，最新时间戳为 `nightcord-lastmsg:<roomname>`。
- 迁移：如果你在早期版本中有全局键 `nightcord-messages`/`nightcord-lastmsg`，程序会在加载时自动把这些旧数据迁移到 `nightcord-messages:nightcord-default` 并删除旧键（迁移合并时会去重并保留最近 2000 条）。

更多详情请参见 `docs/LOCAL_STORAGE.md`。

## 🎨 事件列表

NightcordManager 通过 EventBus 发出以下事件：

| 事件名 | 数据 | 描述 |
|--------|------|------|
| `user:set` | `{ username }` | 用户设置完成 |
| `user:joined` | `{ username }` | 用户加入房间 |
| `user:quit` | `{ username }` | 用户退出房间 |
| `user:rename` | `{ oldUsername, newUsername }` | 用户重命名 |
| `room:joining` | `{ roomname }` | 正在加入房间 |
| `room:ready` | `{ roomname, isPrivate }` | 房间准备就绪 |
| `room:left` | `{ roomname }` | 离开房间 |
| `message:received` | `{ name, message, timestamp }` | 收到消息 |
| `message:sent` | `{ message }` | 发送消息 |
| `message:error` | `{ error }` | 消息错误 |
| `connection:open` | `{ roomname }` | 连接打开 |
| `connection:close` | `{ roomname }` | 连接关闭 |
| `connection:error` | `{ error }` | 连接错误 |

## 🧪 测试

每个类都可以独立测试：

```javascript
// 测试 EventBus
describe('EventBus', () => {
  it('should emit and receive events', () => {
    const bus = new EventBus();
    let received = false;
    
    bus.on('test', () => { received = true; });
    bus.emit('test');
    
    expect(received).toBe(true);
  });
});

// 测试 NightcordManager（不依赖 UI）
describe('NightcordManager', () => {
  it('should normalize room names', () => {
    const eventBus = new EventBus();
    const chatRoom = new NightcordManager({ eventBus });
    
    chatRoom.joinRoom('Room_123!@#');
    expect(chatRoom.roomname).toBe('room-123');
  });
});
```

## 🔧 开发

### 添加新功能

1. 通过事件系统监听现有事件
2. 或创建插件类扩展功能
3. 不需要修改核心代码

### 替换 UI 实现

可以创建新的 UI 管理器（如 React/Vue 版本）：

```javascript
class ReactUIManager {
  constructor(eventBus) {
    this.eventBus = eventBus;
    
    // 订阅事件
    eventBus.on('message:received', (data) => {
      // 使用 React 更新界面
      this.setState({ messages: [...messages, data] });
    });
  }
}

// 替换 UI
const app = new Nightcord();
app.ui = new ReactUIManager(app.getEventBus());
```

## 📖 设计原则

1. **单一职责** - 每个类只负责一件事
2. **开放封闭** - 对扩展开放，对修改封闭
3. **依赖倒置** - 高层不依赖低层，都依赖抽象
4. **接口隔离** - 客户端不依赖不需要的接口
5. **迪米特法则** - 对象之间保持最少了解

## 🌟 最佳实践

### 错误处理

```javascript
try {
  await chatRoom.createPrivateRoom();
} catch (error) {
  eventBus.emit('error', { message: '创建房间失败', error });
}

eventBus.on('error', (data) => {
  console.error(data.message, data.error);
  // 显示错误提示
});
```

### 日志记录

```javascript
const allEvents = ['user:joined', 'message:received', /* ... */];

allEvents.forEach(event => {
  eventBus.on(event, (data) => {
    console.log(`[${event}]`, data);
  });
});
```

### 性能优化

```javascript
// 限流
let timer;
eventBus.on('typing', (data) => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    // 处理打字状态
  }, 100);
});
```

## 🌐 SEKAI 生态

本项目是 **SEKAI 生态**的一部分。

查看完整的项目列表和架构：**[SEKAI 门户](https://sekai.nightcord.de5.net)**

---

**声明**：本项目受 *Project SEKAI COLORFUL STAGE! feat. Hatsune Miku* 启发。

本项目是非官方、非商业性质的粉丝作品，与 SEGA、Colorful Palette、Crypton Future Media 或任何其他与《Project SEKAI》相关的版权持有方无任何官方关联。

所有游戏相关素材（包括但不限于角色、音乐、图像）的版权归其各自的版权持有方所有。

## 🤝 贡献

欢迎贡献！我们非常感谢任何形式的贡献。

在贡献之前，请阅读：
- [贡献指南](./CONTRIBUTING.md)
- [行为准则](./CODE_OF_CONDUCT.md)

## 🔒 安全

如果发现安全漏洞，请查看我们的 [安全政策](./SECURITY.md)。

## 📄 许可证

本项目采用 GNU Affero General Public License v3.0 only (AGPL-3.0-only) 许可证 - 详见 [LICENSE](./LICENSE) 文件。

⚠️ **重要提示**：AGPL-3.0-only 许可证仅适用于本项目的原创代码。游戏相关素材（音乐、图像等）的版权归 SEGA、Colorful Palette、Crypton Future Media 等原版权方所有。

本项目包含的第三方库保留其原有许可证：
- **DOMPurify**: Apache License 2.0 / Mozilla Public License 2.0
- **pangu.js**: Copyright (c) 2013 Vinta

## 📧 联系方式

- **GitHub Issues**: [https://github.com/25-ji-code-de/nightcord/issues](https://github.com/25-ji-code-de/nightcord/issues)
- **项目主页**: [https://nightcord.de5.net](https://nightcord.de5.net)
- **哔哩哔哩**: [@bili_47177171806](https://space.bilibili.com/3546904856103196)

## 🙏 致谢

- 感谢所有贡献者
- 感谢 Project SEKAI 提供的精美贴纸素材

## ⭐ Star History

如果这个项目对你有帮助，请给我们一个 Star！

[![Star History Chart](https://api.star-history.com/svg?repos=25-ji-code-de/nightcord&type=Date)](https://star-history.com/#25-ji-code-de/nightcord&Date)

---

<div align="center">

**[SEKAI 生态](https://sekai.nightcord.de5.net)** 的一部分

Made with 💜 by the [25-ji-code-de](https://github.com/25-ji-code-de) team

</div>
