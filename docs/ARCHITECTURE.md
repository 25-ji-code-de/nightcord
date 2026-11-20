# 架构文档

本文档详细说明了聊天应用的整体架构设计、设计理念和最佳实践。

## 目录

- [概述](#概述)
- [架构图](#架构图)
- [设计原则](#设计原则)
- [层次结构](#层次结构)
- [数据流](#数据流)
- [事件系统](#事件系统)
- [扩展性](#扩展性)
- [最佳实践](#最佳实践)

---

## 概述

该聊天应用采用模块化、分层架构设计，将应用划分为多个独立的、职责单一的模块。每个模块都可以独立测试、维护和扩展。

### 核心特性

- **高度解耦**：UI、业务逻辑、网络通信完全分离
- **事件驱动**：使用发布-订阅模式实现组件间通信
- **回调驱动**：通过回调函数实现灵活的控制流
- **可测试性**：每个类都可以独立测试
- **可扩展性**：易于添加新功能而不影响现有代码
- **可复用性**：核心模块可用于其他项目

---

## 架构图

```
┌─────────────────────────────────────────────────────────┐
│                      Nightcord                           │
│                    (主应用协调器)                         │
│  - 控制应用流程                                          │
│  - 协调各个管理器                                        │
└───────────┬─────────────────┬───────────────┬───────────┘
            │                 │               │
            ▼                 ▼               ▼
  ┌───────────────┐ ┌────────────────┐ ┌────────────┐
  │  UIManager    │ │ NightcordMgr   │ │ EventBus   │
  │  (UI 层)      │ │ (业务逻辑层)    │ │ (事件总线) │
  └───────┬───────┘ └──────┬─────────┘ └────────────┘
          │                │
          ▼                ▼
  ┌───────────────┐  ┌─────────────────┐
  │ UI 子模块      │  │ WebSocketMgr    │
  │ (Autocomplete,│  │ (网络通信层)     │
  │ StickerService)│  └─────────────────┘
  └───────────────┘
```

### 依赖关系

```
Nightcord
  ├── EventBus (创建)
  ├── IdentityController (登录、身份恢复、跨标签页同步)
  ├── MessageCommands (发送校验、格式化、AI 命令)
  ├── AIConversation (AI 上下文和回复广播)
  ├── NightcordManager (依赖 EventBus)
  │   └── WebSocketManager (内部使用，注入 ChatSessionProtocol)
  └── UIManager (依赖 EventBus)
      ├── js/ui/* (消息、输入框、成员、上传、弹窗等视图)
      ├── StickerService (贴纸解析与加载)
      ├── AutocompleteManager (自动补全控制)
      ├── SekaiRenderer (协调解析器和各类内容渲染器)
      └── StorageManager (存储访问)
```

### 文件组织与边界

| 位置 | 职责 |
| --- | --- |
| `nightcord.js`、`js/app/` | 组装模块、绑定回调和管理身份流程 |
| `nightcord-mgr.js`、`js/services/message-commands.js` | 房间、用户及消息业务；不访问 DOM 或浏览器存储 |
| `js/services/ai-conversation.js` | 从事件建立独立消息上下文，确认 AI 回传，通过注入的回调请求和广播回复 |
| `websocket-mgr.js` | 通用 JSON WebSocket 连接、收发与重连；不解释聊天消息 |
| `js/network/chat-session.js` | 聊天协议的访客 Cookie 初始化、认证握手、续期和发送就绪判断 |
| `ui-manager.js`、`js/ui/` | UI 协调和具体视图；用户输入通过回调上交，显示通过事件更新 |
| `sekai-renderer.js`、`js/renderer/` | 渲染入口与文本、图片、卡片、音频模块；`parser.js` 和 `resources.js` 可在无 DOM 环境中使用 |
| `sidebar-features.js`、`js/sidebar/` | 侧栏协调、搜索与收件箱、任务表单及票据；`storage.js` 管理按房间和身份隔离的持久化状态 |
| `css/app-shell/`、`css/renderer/` | 按界面职责拆分的样式，保留原有层叠顺序 |

UI 子组件共享 `UIManager` 提供的视图上下文；根入口保留原有方法作为显式委托接口。组件不修改入口的 prototype，也不通过运行时脚本注入来补全方法。业务服务通过构造参数接收数据提供者、存储接口和回调，不读取 UI 的消息数组。

项目继续使用经典脚本。`index.html` 按依赖顺序加载组件，`scripts/browser-components.json` 记录各入口的组件清单，隔离测试通过 `scripts/browser-source.mjs` 加载相同代码。新增组件时同步更新页面和 `sw.js` 的预缓存；`scripts/build-pages.mjs` 会复制 `js/` 和 `css/` 到发布目录。原有 CSS 入口保留为兼容导入文件，页面直接加载拆分后的样式。

单个手写前端 JS/CSS 文件以 500 行以内为目标，超过 700 行必须按职责拆分。生成的数据、第三方代码、后端生成的类型声明不适用此限制。`test/architecture.test.mjs` 检查行数、脚本顺序、全局声明冲突、分层依赖和离线资源覆盖。

验证命令：根目录运行 `node --test test/*.test.mjs` 和 `node scripts/build-pages.mjs`；在 `backend/` 运行 `npm run check`、`npm test`、`npm run test:browser`。附件、媒体控件和名称选择另由 `node --test test/composer-uploads.test.mjs test/media-controls.test.mjs test/name-chooser.test.mjs` 覆盖。浏览器测试可通过 `NIGHTCORD_TEST_CHROMIUM` 指定本机 Chromium 路径。

---

## 设计原则

### 1. 单一职责原则 (SRP)

每个类只负责一件事：

- **EventBus**: 只负责事件的发布和订阅
- **WebSocketManager**: 只负责 WebSocket 连接管理
- **NightcordManager**: 只负责聊天室业务逻辑
- **UIManager**: 作为 UI 层主控，负责视图协调
- **StickerService**: 专门负责贴纸数据的加载与渲染
- **AutocompleteManager**: 专门负责 @提及与贴纸自动补全逻辑
- **Nightcord**: 只负责协调各个管理器

### 2. 开放封闭原则 (OCP)

对扩展开放，对修改封闭：

- 通过事件系统，可以在不修改现有代码的情况下添加新功能
- 通过回调函数，可以自定义行为而无需修改类内部逻辑

### 3. 依赖倒置原则 (DIP)

高层模块不依赖低层模块，都依赖抽象：

- NightcordManager 通过事件总线与 UI 通信，不直接依赖 UI 实现
- UIManager 通过回调函数与业务逻辑通信，不直接依赖业务实现

### 4. 接口隔离原则 (ISP)

客户端不应该依赖它不需要的接口：

- WebSocketManager 提供精简的回调接口
- UIManager 只暴露必要的设置方法

### 5. 迪米特法则 (LoD)

一个对象应该对其他对象有最少的了解：

- UIManager 不知道 WebSocketManager 的存在
- WebSocketManager 不知道 NightcordManager 的存在

---

## 层次结构

### 1. 表示层 (Presentation Layer)

**类**: `UIManager`

**职责**:
- DOM 操作和事件处理
- 用户交互响应
- 界面状态管理
- 视图渲染

**特点**:
- 不包含任何业务逻辑
- 通过回调函数将用户操作通知上层
- 订阅事件总线以更新界面

### 2. 业务逻辑层 (Business Logic Layer)

**类**: `NightcordManager`

**职责**:
- 聊天室业务规则
- 用户管理
- 消息处理
- 房间管理

**特点**:
- 完全独立于 UI
- 通过事件总线发布状态变化
- 可通过注入 `createTransport`、`aiConfig` 和 `fetch` 在 Node.js 环境中独立测试

### 3. 网络通信层 (Network Layer)

**类**: `WebSocketManager`

**职责**:
- WebSocket 连接管理
- 消息发送和接收
- 自动重连
- 连接状态管理

**特点**:
- 可以独立于聊天应用使用
- 通过回调函数通知上层
- 不关心消息的业务含义；聊天认证由注入的 `ChatSessionProtocol` 处理

### 4. 基础设施层 (Infrastructure Layer)

**类**: `EventBus`

**职责**:
- 提供发布-订阅机制
- 实现组件间解耦通信

**特点**:
- 完全通用，可用于任何项目
- 无任何业务逻辑
- 纯粹的技术实现

### 5. 应用协调层 (Application Layer)

**类**: `Nightcord`

**职责**:
- 初始化各个模块
- 协调模块间的交互
- 管理应用生命周期
- 提供统一的 API 入口

**特点**:
- 轻量级，主要是组装和协调
- 提供对外的简洁接口
- 管理应用的整体流程

---

## 数据流

### 用户输入流

```
User Action (在 UI 上操作)
    ↓
UIManager (捕获事件)
    ↓
Callback (通知上层)
    ↓
Nightcord / MessageCommands (校验、格式化、命令分发)
    ↓
NightcordManager (执行业务逻辑)
    ↓
WebSocketManager (发送网络请求)
```

### 服务器消息流

```
Server (发送消息)
    ↓
WebSocketManager (接收消息)
    ↓
Callback (通知上层)
    ↓
NightcordManager (处理业务逻辑)
    ↓
EventBus (发布事件)
    ↓
UIManager (更新界面)
```

### 完整的消息发送流程

```
1. 用户在输入框输入消息并按回车
   └→ UIManager.setupChatRoom 中的 submit 事件监听器

2. UIManager 调用回调函数
   └→ onSendMessage(message)

3. Nightcord 接收到回调
   └→ commands.submit(message) → chatRoom.sendMessage(message)

4. NightcordManager 处理业务逻辑
   ├→ 验证消息
   ├→ wsManager.send({ message })
   └→ eventBus.emit('message:sent', { message })

5. WebSocketManager 发送消息
   └→ ws.send(JSON.stringify({ message }))

6. UIManager 监听到 message:sent 事件
   └→ clearChatInput()
```

---

## 事件系统

### 事件命名规范

采用 `<对象>:<动作>` 的命名方式：

- `user:set` - 用户相关的设置动作
- `message:received` - 消息相关的接收动作
- `room:joining` - 房间相关的加入动作

### 事件分类

#### 1. 用户事件
- `user:set` - 用户设置
- `user:joined` - 用户加入
- `user:quit` - 用户退出
- `user:rename` - 用户重命名

#### 2. 房间事件
- `room:joining` - 正在加入房间
- `room:ready` - 房间准备就绪
- `room:left` - 离开房间

#### 3. 消息事件
- `message:received` - 收到消息
- `message:sent` - 发送消息
- `message:error` - 消息错误

#### 4. 连接事件
- `connection:open` - 连接打开
- `connection:close` - 连接关闭
- `connection:error` - 连接错误

#### 5. 界面事件
- `roster:clear` - 清空成员列表

#### 6. 通用事件
- `error` - 通用错误

### 事件流转图

```
NightcordManager (发布事件)
         ↓
    EventBus (分发)
         ↓
    ┌────┴────┐
    ↓         ↓
UIManager  Custom Handlers
(订阅)     (订阅)
```

---

## 扩展性

### 1. 添加新的 UI 实现

可以创建一个新的 UI 管理器而不修改业务逻辑：

```javascript
class ReactUIManager {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.setupEventListeners();
  }
  
  setupEventListeners() {
    this.eventBus.on('message:received', (data) => {
      // 使用 React 更新界面
      this.setState({ messages: [...this.state.messages, data] });
    });
  }
}

const app = new Nightcord();
app.ui = new ReactUIManager(app.getEventBus());
```

### 2. 添加插件系统

```javascript
class ChatPlugin {
  constructor(app) {
    this.app = app;
    this.eventBus = app.getEventBus();
  }
  
  install() {
    // 插件逻辑
  }
}

// 使用插件
const autoReplyPlugin = new AutoReplyPlugin(app);
autoReplyPlugin.install();
```

### 3. 添加中间件

```javascript
class MessageMiddleware {
  constructor(chatRoom) {
    this.chatRoom = chatRoom;
    this.originalSend = chatRoom.sendMessage.bind(chatRoom);
    
    // 拦截发送方法
    chatRoom.sendMessage = (message) => {
      // 预处理
      message = this.preprocess(message);
      // 调用原方法
      return this.originalSend(message);
    };
  }
  
  preprocess(message) {
    // 过滤敏感词、添加表情等
    return message;
  }
}
```

### 4. 添加状态持久化

```javascript
const eventBus = app.getEventBus();

// 保存消息历史
eventBus.on('message:received', (data) => {
  const history = JSON.parse(localStorage.getItem('history') || '[]');
  history.push(data);
  localStorage.setItem('history', JSON.stringify(history));
});

// 恢复历史消息
const history = JSON.parse(localStorage.getItem('history') || '[]');
history.forEach(msg => {
  app.getUIManager().addChatMessage(msg.name, msg.message);
});
```

---

## 最佳实践

### 1. 错误处理

```javascript
// 在业务逻辑层捕获错误并通过事件通知
try {
  await chatRoom.createPrivateRoom();
} catch (error) {
  eventBus.emit('error', { 
    message: 'Failed to create room',
    error 
  });
}

// 在 UI 层显示错误
eventBus.on('error', (data) => {
  ui.showError(data.message);
  console.error(data.error);
});
```

### 2. 日志记录

```javascript
// 全局日志监听
const eventBus = app.getEventBus();
const allEvents = [
  'user:set', 'user:joined', 'user:quit',
  'room:joining', 'room:ready', 'room:left',
  'message:received', 'message:sent',
  'connection:open', 'connection:close'
];

allEvents.forEach(event => {
  eventBus.on(event, (data) => {
    console.log(`[${event}]`, data);
  });
});
```

### 3. 测试

```javascript
// 单元测试 - EventBus
describe('EventBus', () => {
  it('should emit and receive events', () => {
    const bus = new EventBus();
    let received = false;
    
    bus.on('test', () => { received = true; });
    bus.emit('test');
    
    expect(received).toBe(true);
  });
});

// 单元测试 - NightcordManager (不依赖 UI)
describe('NightcordManager', () => {
  it('should normalize room names', () => {
    const eventBus = new EventBus();
    const chatRoom = new NightcordManager({ eventBus });
    
    chatRoom.joinRoom('Room_123!@#');
    expect(chatRoom.roomname).toBe('room-123');
  });
});

// 集成测试
describe('Nightcord', () => {
  it('should flow through name and room selection', () => {
    const app = new Nightcord();
    // ... 测试完整流程
  });
});
```

### 4. 性能优化

```javascript
// 限流：避免频繁触发事件
class ThrottledEventBus extends EventBus {
  emit(event, data) {
    if (this.shouldThrottle(event)) {
      clearTimeout(this.timers[event]);
      this.timers[event] = setTimeout(() => {
        super.emit(event, data);
      }, 100);
    } else {
      super.emit(event, data);
    }
  }
}

// 批量更新：合并多个 UI 更新
let pendingRosterUpdates = [];
eventBus.on('user:joined', (data) => {
  pendingRosterUpdates.push(data);
  scheduleRosterUpdate();
});

function scheduleRosterUpdate() {
  if (!updateScheduled) {
    updateScheduled = true;
    requestAnimationFrame(() => {
      pendingRosterUpdates.forEach(data => {
        ui.addUserToRoster(data.username);
      });
      pendingRosterUpdates = [];
      updateScheduled = false;
    });
  }
}
```

### 5. 类型安全 (TypeScript)

```typescript
// 定义事件类型
interface EventMap {
  'message:received': { name: string; message: string; timestamp: number };
  'user:joined': { username: string };
  'error': { message: string; error: Error };
}

class TypedEventBus {
  on<K extends keyof EventMap>(
    event: K,
    callback: (data: EventMap[K]) => void
  ): void {
    // 实现
  }
  
  emit<K extends keyof EventMap>(
    event: K,
    data: EventMap[K]
  ): void {
    // 实现
  }
}
```

### 6. 安全性

```javascript
// 消息验证
class MessageValidator {
  static validate(message) {
    if (typeof message !== 'string' || !message.trim()) {
      throw new Error('Message must be non-empty text');
    }
    // 长度限制
    if (message.length > 256) {
      throw new Error('Message too long');
    }
    
    return message;
  }
}

// 业务层校验原始消息；HTML 转义和 DOMPurify 净化在渲染层执行。
chatRoom.sendMessage = (message) => {
  message = MessageValidator.validate(message);
  // 继续发送
};
```

---

## 架构优势

### 1. 可维护性

- **清晰的职责划分**：每个模块职责明确，易于理解和修改
- **低耦合**：模块间通过接口通信，修改一个模块不影响其他模块
- **高内聚**：相关功能集中在同一个模块中

### 2. 可测试性

- **单元测试**：每个类都可以独立测试
- **集成测试**：可以测试模块间的交互
- **Mock 友好**：可以轻松 mock 依赖

### 3. 可扩展性

- **插件化**：通过事件系统轻松添加新功能
- **可替换**：可以替换任何模块的实现
- **向后兼容**：添加新功能不影响现有代码

### 4. 可复用性

- **独立模块**：WebSocketManager、EventBus 可用于其他项目
- **无耦合**：业务逻辑完全独立于 UI
- **标准接口**：使用标准的回调和事件模式

---

## 未来改进方向

### 1. 状态管理

考虑引入类似 Redux 的状态管理：

```javascript
class StateManager {
  constructor() {
    this.state = {};
    this.reducers = {};
  }
  
  dispatch(action) {
    const newState = this.reducers[action.type](this.state, action);
    this.state = newState;
    this.notifySubscribers();
  }
}
```

### 2. 路由系统

为不同的聊天阶段添加路由：

```javascript
class Router {
  navigate(route) {
    // /name -> name choosing
    // /room -> room choosing
    // /chat/:roomId -> chatting
  }
}
```

### 3. 离线支持

添加 Service Worker 和离线数据同步：

```javascript
class OfflineManager {
  constructor(chatRoom) {
    this.queue = [];
    this.setupSync();
  }
  
  queueMessage(message) {
    this.queue.push(message);
    this.saveToIndexedDB();
  }
  
  syncWhenOnline() {
    // 同步离线消息
  }
}
```

### 4. 多房间支持

支持同时加入多个房间：

```javascript
class MultiRoomManager {
  constructor() {
    this.rooms = new Map();
  }
  
  joinRoom(roomId) {
  const room = new NightcordManager({ roomId });
    this.rooms.set(roomId, room);
  }
  
  switchRoom(roomId) {
    // 切换活动房间
  }
}
```

---

## 总结

该架构设计遵循现代软件工程的最佳实践，提供了：

✅ **清晰的分层结构**
✅ **松耦合的模块设计**
✅ **事件驱动的通信机制**
✅ **高度的可扩展性**
✅ **良好的可测试性**
✅ **强大的可维护性**

这使得代码易于理解、修改和扩展，为未来的功能增强提供了坚实的基础。
