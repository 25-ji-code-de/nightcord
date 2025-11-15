# API 文档

本文档详细说明了聊天应用中各个类的 API 使用方法。

## 目录

- [EventBus](#eventbus) - 事件总线
- [WebSocketManager](#websocketmanager) - WebSocket 管理器
- [ChatRoomManager](#chatroommanager) - 聊天室管理器
- [UIManager](#uimanager) - UI 管理器
- [ChatApplication](#chatapplication) - 主应用类

## NightcordManager

NightcordManager，负责处理聊天室的业务逻辑，包括用户管理、消息处理、房间管理等。完全独立于 UI 层，通过 EventBus 与外部通信。

### 构造函数

```javascript
const eventBus = new EventBus();
const chatRoom = new NightcordManager({
  hostname: 'example.com',    // 可选，默认为 'edge-chat-demo.cloudflareworkers.com'
  eventBus: eventBus          // 可选，默认创建新的 EventBus
});
```

### 方法

#### `setUser(username)`

设置当前用户。

**参数：**
- `username` (string) - 用户名

**触发事件：** `user:set`

**示例：**
```javascript
chatRoom.setUser('K');
```

#### `joinRoom(roomname)`

加入房间。

**参数：**
- `roomname` (string) - 房间名称

**返回值：** (boolean) 是否成功加入

**触发事件：** `room:joining`, `error` (失败时)

**示例：**
```javascript
const success = chatRoom.joinRoom('nightcord-default');
```

#### `sendMessage(message)`

发送消息。

**参数：**
- `message` (string) - 消息内容

**返回值：** (boolean) 是否成功发送

**触发事件：** `message:sent`

**示例：**
```javascript
chatRoom.sendMessage('As always, at 25:00.');
```

#### `leave()`

离开房间。

**触发事件：** `room:left`

**示例：**
```javascript
chatRoom.leave();
```

#### `getRoster()`

获取房间成员列表。

**返回值：** (string[]) 成员用户名数组

**示例：**
```javascript
const members = chatRoom.getRoster();
console.log('当前成员:', members);
```

#### `getRoomInfo()`

获取当前房间信息。

**返回值：** (Object) 房间信息对象

**示例：**
```javascript
const info = chatRoom.getRoomInfo();
// {
//   username: 'K',
//   roomname: 'room123',
//   memberCount: 5,
//   members: ['K', 'Amia', ...],
//   connected: true
// }
```

#### `isConnected()`

检查是否已连接。

**返回值：** (boolean) 是否已连接

**示例：**
```javascript
if (chatRoom.isConnected()) {
  console.log('已连接到聊天室');
}
```

### 事件

NightcordManager 通过 EventBus 发出以下事件：

| 事件名 | 数据 | 描述 |
|--------|------|------|
| `user:set` | `{ username }` | 用户设置完成 |
| `user:joined` | `{ username }` | 有用户加入 |
| `user:quit` | `{ username }` | 有用户退出 |
| `room:joining` | `{ roomname }` | 正在加入房间 |
| `room:ready` | `{ roomname, isPrivate }` | 房间准备就绪 |
| `room:left` | `{ roomname }` | 离开房间 |
| `message:received` | `{ name, message, timestamp }` | 收到消息 |
| `message:sent` | `{ message }` | 发送消息 |
| `message:error` | `{ error }` | 消息错误 |
| `roster:clear` | - | 清空成员列表 |
| `connection:open` | `{ roomname }` | 连接打开 |
| `connection:close` | `{ roomname }` | 连接关闭 |
| `connection:error` | `{ error }` | 连接错误 |
| `error` | `{ message, error }` | 通用错误 |

**返回值：** (boolean) 是否已连接

加入房间。


## Nightcord

Nightcord（原 ChatApplication），主应用类，协调各个管理器，控制应用整体流程。

### 构造函数

```javascript
const app = new Nightcord({
  hostname: 'example.com'  // 可选，默认为 'edge-chat-demo.cloudflareworkers.com'
});
```

### 方法

#### `init()`

初始化应用，启动用户名选择流程。

**示例：**
```javascript
const app = new Nightcord();
app.init();
```

#### `joinRoom(roomname)`

加入聊天室。

**参数：**
- `roomname` (string) - 房间名称

**示例：**
```javascript
app.joinRoom('room123');
```

#### `getState()`

获取当前应用状态。

**返回值：** (Object) 状态对象
- `phase` (string) - 当前阶段：'name-choosing' | 'chatting'
- `username` (string) - 当前用户名
- `roomname` (string) - 当前房间名
- `roster` (string[]) - 房间成员列表

**示例：**
```javascript
const state = app.getState();
console.log(`${state.username} 在 ${state.roomname} 房间`);
```

#### `getEventBus()`

获取事件总线实例（用于外部扩展）。

**返回值：** (EventBus) 事件总线

**示例：**
```javascript
const eventBus = app.getEventBus();
eventBus.on('message:received', (data) => {
  console.log('收到消息:', data);
});
```

#### `getChatRoomManager()`

获取 NightcordManager 实例（用于外部扩展）。

**返回值：** (NightcordManager) 聊天室管理器

**示例：**
```javascript
const chatRoom = app.getChatRoomManager();
console.log(chatRoom.getRoomInfo());
```

#### `getUIManager()`

获取 UI 管理器实例（用于外部扩展）。

**返回值：** (UIManager) UI 管理器

**示例：**
```javascript
const ui = app.getUIManager();
ui.addChatMessage(null, '* 自定义消息');
```

#### `destroy()`

销毁应用实例，清理资源。

**示例：**
```javascript
app.destroy();
```

---

## 完整使用示例

### 基本使用

```javascript
import { Nightcord } from './nightcord.js';

// 创建并初始化应用
const app = new Nightcord();
app.init();

// 暴露到全局（可选，用于调试）
window.chatApp = app;
```
#### `getRoomInfo()`

获取当前房间信息。

**返回值：** (Object) 房间信息对象

**示例：**
```javascript
const info = chatRoom.getRoomInfo();
// {
//   username: 'Alice',
//   roomname: 'room123',
//   memberCount: 5,
//   members: ['Alice', 'Bob', ...],
//   connected: true
// }
```

#### `isConnected()`

检查是否已连接。

**返回值：** (boolean) 是否已连接

**示例：**
```javascript
if (chatRoom.isConnected()) {
  console.log('已连接到聊天室');
}
```

### 事件

ChatRoomManager 通过 EventBus 发出以下事件：

| 事件名 | 数据 | 描述 |
|--------|------|------|
| `user:set` | `{ username }` | 用户设置完成 |
| `user:joined` | `{ username }` | 有用户加入 |
| `user:quit` | `{ username }` | 有用户退出 |
| `user:rename` | `{ oldUsername, newUsername }` | 用户重命名 |
| `room:joining` | `{ roomname }` | 正在加入房间 |
| `room:ready` | `{ roomname, isPrivate }` | 房间准备就绪 |
| `room:left` | `{ roomname }` | 离开房间 |
| `message:received` | `{ name, message, timestamp }` | 收到消息 |
| `message:sent` | `{ message }` | 发送消息 |
| `message:error` | `{ error }` | 消息错误 |
| `roster:clear` | - | 清空成员列表 |
| `connection:open` | `{ roomname }` | 连接打开 |
| `connection:close` | `{ roomname }` | 连接关闭 |
| `connection:error` | `{ error }` | 连接错误 |
| `error` | `{ message, error }` | 通用错误 |

---

## UIManager

UI 管理器，负责处理所有用户界面相关的逻辑和 DOM 操作。

### 构造函数

```javascript
const eventBus = new EventBus();
const ui = new UIManager(eventBus);
```

### 方法

#### `setupNameChooser(onSubmit)`

设置用户名选择器。

**参数：**
- `onSubmit` (Function) - 提交用户名时的回调 `(username) => void`

**示例：**
```javascript
ui.setupNameChooser((username) => {
  console.log('用户选择了名字:', username);
});
```

#### `hideNameChooser()`

隐藏用户名选择器。

**示例：**
```javascript
ui.hideNameChooser();
```

#### `setupRoomChooser(callbacks)`

设置房间选择器。

**参数：**
- `callbacks` (Object) - 回调函数对象
  - `onPublicRoom` (Function) - 选择公共房间 `(roomname) => void`
  - `onPrivateRoom` (Function) - 创建私人房间 `() => Promise<void>`
  - `onHashRoom` (Function) - URL 中有房间哈希 `(roomname) => void`

**示例：**
```javascript
ui.setupRoomChooser({
  onPublicRoom: (roomname) => {
    console.log('加入公共房间:', roomname);
  },
  onPrivateRoom: async () => {
    console.log('创建私人房间');
  },
  onHashRoom: (roomname) => {
    console.log('从 URL 加入房间:', roomname);
  }
});
```

#### `hideRoomChooser()`

隐藏房间选择器。

**示例：**
```javascript
ui.hideRoomChooser();
```

#### `setupChatRoom(onSendMessage)`

设置聊天室界面。

**参数：**
- `onSendMessage` (Function) - 发送消息时的回调 `(message) => void`

**示例：**
```javascript
ui.setupChatRoom((message) => {
  console.log('发送消息:', message);
});
```

#### `addChatMessage(name, text)`

添加聊天消息到界面。

**参数：**
- `name` (string|null) - 发送者名称，null 表示系统消息
- `text` (string) - 消息文本

**示例：**
```javascript
ui.addChatMessage('Alice', 'Hello!');
ui.addChatMessage(null, '* 系统消息');
```

#### `clearChatInput()`

清空聊天输入框。

**示例：**
```javascript
ui.clearChatInput();
```

#### `addUserToRoster(username)`

添加用户到成员列表。

**参数：**
- `username` (string) - 用户名

**示例：**
```javascript
ui.addUserToRoster('Bob');
```

#### `removeUserFromRoster(username)`

从成员列表移除用户。

**参数：**
- `username` (string) - 用户名

**示例：**
```javascript
ui.removeUserFromRoster('Bob');
```

#### `clearRoster()`

清空成员列表。

**示例：**
```javascript
ui.clearRoster();
```

#### `showWelcomeMessages(data)`

显示欢迎消息。

**参数：**
- `data` (Object) - 房间数据
  - `roomname` (string) - 房间名称
  - `isPrivate` (boolean) - 是否为私人房间

**示例：**
```javascript
ui.showWelcomeMessages({ roomname: 'room123', isPrivate: false });
```

#### `showError(message)`

显示错误消息。

**参数：**
- `message` (string) - 错误消息

**示例：**
```javascript
ui.showError('连接失败');
```

#### `setCurrentRoom(roomname)`

设置当前房间（更新 URL hash）。

**参数：**
- `roomname` (string) - 房间名称

**示例：**
```javascript
ui.setCurrentRoom('room123');
```

#### `getElements()`

获取所有 DOM 元素引用。

**返回值：** (Object) DOM 元素对象

**示例：**
```javascript
const elements = ui.getElements();
console.log(elements.chatInput);
```

#### `scrollToBottom()`

滚动聊天记录到底部。

**示例：**
```javascript
ui.scrollToBottom();
```

#### `isScrolledToBottom()`

检查是否滚动到底部。

**返回值：** (boolean) 是否在底部

**示例：**
```javascript
if (ui.isScrolledToBottom()) {
  console.log('在底部');
}
```

---

## ChatApplication

主应用类，协调各个管理器，控制应用的整体流程。

### 构造函数

```javascript
const app = new ChatApplication({
  hostname: 'example.com'  // 可选，默认为 'edge-chat-demo.cloudflareworkers.com'
});
```

### 方法

#### `init()`

初始化应用，启动用户名选择流程。

**示例：**
```javascript
const app = new ChatApplication();
app.init();
```

#### `startRoomChooser()`

启动房间选择阶段。

**示例：**
```javascript
app.startRoomChooser();
```

#### `joinRoom(roomname)`

加入聊天室。

**参数：**
- `roomname` (string) - 房间名称

**示例：**
```javascript
app.joinRoom('room123');
```

#### `leaveRoom()`

离开聊天室。

**示例：**
```javascript
app.leaveRoom();
```

#### `getState()`

获取当前应用状态。

**返回值：** (Object) 状态对象
- `phase` (string) - 当前阶段：'name-choosing' | 'room-choosing' | 'chatting'
- `username` (string) - 当前用户名
- `roomname` (string) - 当前房间名
- `roster` (string[]) - 房间成员列表

**示例：**
```javascript
const state = app.getState();
console.log(`${state.username} 在 ${state.roomname} 房间`);
```

#### `getEventBus()`

获取事件总线实例（用于外部扩展）。

**返回值：** (EventBus) 事件总线

**示例：**
```javascript
const eventBus = app.getEventBus();
eventBus.on('message:received', (data) => {
  console.log('收到消息:', data);
});
```

#### `getChatRoomManager()`

获取聊天室管理器实例（用于外部扩展）。

**返回值：** (ChatRoomManager) 聊天室管理器

**示例：**
```javascript
const chatRoom = app.getChatRoomManager();
console.log(chatRoom.getRoomInfo());
```

#### `getUIManager()`

获取 UI 管理器实例（用于外部扩展）。

**返回值：** (UIManager) UI 管理器

**示例：**
```javascript
const ui = app.getUIManager();
ui.addChatMessage(null, '* 自定义消息');
```

#### `destroy()`

销毁应用实例，清理资源。

**示例：**
```javascript
app.destroy();
```

---

## 完整使用示例

### 基本使用

```javascript
import { ChatApplication } from './chat-application.js';

// 创建并初始化应用
const app = new ChatApplication();
app.init();

// 暴露到全局（可选，用于调试）
window.chatApp = app;
```

### 监听事件

```javascript
const eventBus = app.getEventBus();

// 监听所有消息
eventBus.on('message:received', (data) => {
  console.log(`[${data.timestamp}] ${data.name}: ${data.message}`);
});

// 监听用户加入/退出
eventBus.on('user:joined', (data) => {
  console.log(`${data.username} 加入了房间`);
});

eventBus.on('user:quit', (data) => {
  console.log(`${data.username} 离开了房间`);
});
```

### 自定义功能

```javascript
// 添加消息过滤器
eventBus.on('message:received', (data) => {
  if (data.message.includes('spam')) {
    console.log('过滤垃圾消息');
    return;
  }
});

// 保存聊天历史
const history = [];
eventBus.on('message:received', (data) => {
  history.push(data);
  localStorage.setItem('chatHistory', JSON.stringify(history));
});

// 自动回复机器人
eventBus.on('message:received', (data) => {
  if (data.message.includes('@bot')) {
    setTimeout(() => {
      app.getChatRoomManager().sendMessage('我是机器人，有什么可以帮您？');
    }, 1000);
  }
});
```

### 状态管理

```javascript
// 定期检查状态
setInterval(() => {
  const state = app.getState();
  console.log('当前状态:', state);
  
  if (state.phase === 'chatting') {
    const roomInfo = app.getChatRoomManager().getRoomInfo();
    console.log(`房间 ${roomInfo.roomname} 有 ${roomInfo.memberCount} 个成员`);
  }
}, 5000);
```

---

## 类型定义 (TypeScript)

如果使用 TypeScript，可以参考以下类型定义：

```typescript
// event-bus.d.ts
export class EventBus {
  on(event: string, callback: (data: any) => void): void;
  off(event: string, callback: (data: any) => void): void;
  emit(event: string, data: any): void;
  clear(): void;
  clearEvent(event: string): void;
  listenerCount(event: string): number;
}

// websocket-mgr.d.ts
interface WebSocketConfig {
  hostname?: string;
  reconnectDelay?: number;
  onOpen?: (event: Event) => void;
  onMessage?: (data: any) => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (error: Event) => void;
  onReconnect?: () => void;
}

export class WebSocketManager {
  constructor(config?: WebSocketConfig);
  connect(roomname: string, username: string): void;
  send(message: object): boolean;
  disconnect(): void;
  isConnected(): boolean;
  getReadyState(): number;
  getConnectionInfo(): {
    hostname: string;
    roomname: string;
    username: string;
    connected: boolean;
    readyState: number;
  };
}

// nightcord-mgr.d.ts
interface NightcordManagerConfig {
  hostname?: string;
  eventBus?: EventBus;
}

export class NightcordManager {
  constructor(config?: NightcordManagerConfig);
  setUser(username: string): void;
  joinRoom(roomname: string): boolean;
  sendMessage(message: string): boolean;
  leave(): void;
  getRoster(): string[];
  getRoomInfo(): {
    username: string;
    roomname: string;
    memberCount: number;
    members: string[];
    connected: boolean;
  };
  isConnected(): boolean;
}

// ui-manager.d.ts
interface RoomCallbacks {
  onPublicRoom?: (roomname: string) => void;
  onPrivateRoom?: () => Promise<void>;
  onHashRoom?: (roomname: string) => void;
}

export class UIManager {
  constructor(eventBus: EventBus);
  setupNameChooser(onSubmit: (username: string) => void): void;
  hideNameChooser(): void;
  setupRoomChooser(callbacks?: RoomCallbacks): void;
  hideRoomChooser(): void;
  setupChatRoom(onSendMessage: (message: string) => void): void;
  addChatMessage(name: string | null, text: string): void;
  clearChatInput(): void;
  addUserToRoster(username: string): void;
  removeUserFromRoster(username: string): void;
  clearRoster(): void;
  showWelcomeMessages(data: { roomname: string; isPrivate: boolean }): void;
  showError(message: string): void;
  setCurrentRoom(roomname: string): void;
  getElements(): Record<string, HTMLElement>;
  scrollToBottom(): void;
  isScrolledToBottom(): boolean;
}

// nightcord.d.ts
interface NightcordConfig {
  hostname?: string;
}

export class Nightcord {
  constructor(config?: NightcordConfig);
  init(roomname: string): void;
  joinRoom(roomname: string): void;
  getState(): {
    phase: 'name-choosing' | 'chatting';
    username: string;
    roomname: string;
    roster: string[];
  };
  getEventBus(): EventBus;
  getChatRoomManager(): NightcordManager;
  getUIManager(): UIManager;
  destroy(): void;
}
```
