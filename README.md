# Nightcord

一个采用现代化、模块化架构设计的实时聊天应用。

## ✨ 特性

- 🎯 **高度解耦** - UI、业务逻辑、网络通信完全分离
- 📡 **事件驱动** - 使用发布-订阅模式实现组件间通信
- 🔄 **自动重连** - WebSocket 断线自动重连
- 🧩 **可扩展** - 通过插件系统轻松添加新功能
- 📦 **模块化** - ES6 模块，每个类都是独立文件
- 🧪 **易测试** - 单一职责，易于单元测试
- 📝 **完整文档** - API 文档、架构文档、示例文档

## 📁 项目结构

```
.
├── event-bus.js              # 事件总线
├── websocket-mgr.js          # WebSocket 管理器
├── nightcord-mgr.js          # 聊天室管理器（NightcordManager）
├── ui-manager.js             # UI 管理器
├── nightcord.js              # 主应用类（Nightcord）
├── index.html                # HTML 入口文件
├── docs/API.md               # API 文档
├── docs/ARCHITECTURE.md      # 架构文档
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

## 📚 文档

- **[API.md](./docs/API.md)** - 详细的 API 文档，包含所有类和方法的说明
- **[ARCHITECTURE.md](./docs/ARCHITECTURE.md)** - 架构设计文档，解释设计原则和数据流
- **[EXAMPLES.md](./docs/EXAMPLES.md)** - 扩展示例，展示如何添加新功能
- **[LOCAL_STORAGE.md](./docs/LOCAL_STORAGE.md)** - 本地存储（localStorage）键名、迁移与调试说明

## 🏗️ 架构概览

```
Nightcord (应用协调器)
  ├── EventBus (事件总线)
  ├── NightcordManager (业务逻辑)
  │   └── WebSocketManager (网络通信)
  └── UIManager (UI 渲染)
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
UI 管理器，处理所有 DOM 操作和用户交互。

```javascript
const ui = new UIManager(eventBus);
ui.addChatMessage('K', 'As always, at 25:00.');
ui.setupChatRoom((message) => {
  console.log('发送消息:', message);
});
```

#### Nightcord
主应用类（Nightcord），协调各个管理器。

```javascript
const app = new Nightcord();
app.init();

// 获取状态
const state = app.getState();
console.log(state.username, state.roomname);
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

## 🤝 贡献

欢迎贡献代码、报告问题或提出建议！

## 📄 许可证

MIT License

## 📮 联系方式

如有问题或建议，请通过 Issue 联系。也可在哔哩哔哩关注：bili_47177171806 — https://space.bilibili.com/3546904856103196

---

**享受 Nightcord 的乐趣！** 🎉
