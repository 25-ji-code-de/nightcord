# 本地存储（localStorage）说明

本章节说明 Nightcord 在浏览器端使用 localStorage 保存聊天记录的约定、迁移策略与调试方法。

## Key 格式

- 聊天消息（按房间）：
  - Key: `nightcord-messages:<roomname>`
  - Value: JSON 数组，元素格式为 { user, text, timestamp }
  - 说明：仅保存最小必要字段（用户名、文本、时间戳）；UI 渲染层会为每条消息生成 avatar、color、time 等显示信息。

- 最新消息时间戳（按房间）：
  - Key: `nightcord-lastmsg:<roomname>`
  - Value: 字符串化的整数时间戳（ms since epoch）

## 默认与回退

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
