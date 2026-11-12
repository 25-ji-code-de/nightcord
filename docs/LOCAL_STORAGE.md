# 本地存储（localStorage）说明

本章节说明 Nightcord 在浏览器端使用 localStorage 保存聊天记录的约定、迁移策略与调试方法。

## Key 格式

- 外观配色：
  - Key: `nightcord-palette`
  - Value: `gray-purple` 或 `indigo`，默认 `gray-purple`；未知值也回退到 `gray-purple`。
  - 设置中选择后立即生效；刷新恢复、同源标签页同步。存储不可用时仍可切换本次页面的配色，设置内提示无法保存。只记录配色，不改变布局或风格。

- 成员列表样式：
  - Key: `nightcord-member-list`
  - Value: `current`（新版）或 `classic`（旧版），默认 `classic`；未知值回退到旧版。已有选择优先。
  - 仅改变 `member-list-panel` 内的分组图标、频道和成员行样式，与配色独立。即时生效、刷新恢复、同源标签页同步，不重新创建成员节点。文字聊天和离线成员在两版中均不显示摄像头 / 麦克风图标。

- 聊天消息（按房间）：
  - Key: `nightcord-messages:<roomname>`
  - Value: JSON 数组，元素格式为 { user, text, timestamp, profile, sender }
  - 说明：`user` 和 `profile` 保留发送时的昵称与资料快照，`sender` 用于 AI 转发者；UI 渲染层会生成 avatar、color、time 等显示信息。

- 最新消息时间戳（按房间）：
  - Key: `nightcord-lastmsg:<roomname>`
  - Value: 字符串化的整数时间戳（ms since epoch）

- 最后已知资料（跨房间，按唯一用户 ID 区分）：
  - Key: `nightcord-known-profiles`
  - Value: JSON 数组，元素格式为 { profile, observedAt }，`observedAt` 是本浏览器收到在线资料的时间。
  - 只从服务器确认的会话、上线和资料更新事件写入昵称、头像 URL、签名等公开显示字段。历史消息回放、加载本地消息、打开资料卡都不会写入，避免旧快照覆盖新资料。
  - 资料缓存不保存图片文件；头像图片仍遵循资源服务器的 HTTP 缓存响应头。成员列表更新时保留已有头像节点，避免中断下载或重复创建相同请求。
  - 资料卡依次使用在线资料、最后已知资料、发送时快照；离线缓存标注“最后已知资料”。消息上的昵称始终保留发送时的名字，资料卡名字不同时另显示“发送时昵称”。
  - 最多保留最近观察到的 1000 个身份。刷新后保留；清除站点存储会删除。存储不可用时本次页面内仍保留已知资料。

## 默认与回退

身份相关的显示偏好也会保存在本地：

- `nightcord-username`：最近由服务器确认的显示名，兼容旧版。
- `nightcord-guest-name`：最近由服务器确认的访客昵称；登录 Pass 不覆盖，退出后恢复。
- `nightcord-identity-event`：通知其他同源标签页重新连接的时间戳与随机事件编号，不包含凭证，也不授予认证状态。

访客认证凭证由聊天后端保存在 HttpOnly、Secure、host-only 的
`__Host-nightcord_guest` Cookie 中，不进入 localStorage，也不能通过公开 ID 找回。
访客 ID 在刷新、重连、改名和切房间后保持不变；清除 Cookie、过期或换浏览器后改变。
默认有效期 180 天，剩余不足 30 天时续期；浏览器也可能提前清理 Cookie。
Pass 身份始终由后端验证账号凭证后确定，本地资料缓存仅用于展示。

- 当未指定房间时，系统会使用 `nightcord-default` 作为回退房间名，生成的 key 如 `nightcord-messages:nightcord-default`。

## 旧数据迁移

在 11 月 15 日的重构中，storage 已从单一全局键迁移为按房间的键。为了兼容用户在重构前的历史数据，页面加载时会自动执行一次迁移：

1. 如果发现旧键 `nightcord-messages`（数组形式），会把这些消息合并（去重）并迁移到 `nightcord-messages:nightcord-default`。
2. 如果存在旧键 `nightcord-lastmsg`，会与目标房间的 `nightcord-lastmsg:nightcord-default` 做合并（取较大时间戳）。
3. 迁移完成后会删除旧键 `nightcord-messages` 与 `nightcord-lastmsg`。

兼容实现位于 `storage-manager.js`（全局构造后可通过 `window.StorageManager` 访问）。

## 限制与保留策略

- 每个房间只保留最近 2000 条本地消息，以防 localStorage 无限增长。
- localStorage 是浏览器级别持久化，受浏览器存储配额限制（通常数 MB 至数十 MB）。如果应用需要更高容量，请考虑后端存储或 IndexedDB。

## 示例

查看 `room-a` 的消息：

```javascript
const msgs = JSON.parse(localStorage.getItem('nightcord-messages:room-a') || '[]');
console.log(msgs.slice(-10)); // 查看最近 10 条

const last = localStorage.getItem('nightcord-lastmsg:room-a');
console.log('last:', last);
```
