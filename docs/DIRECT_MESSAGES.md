# 私信

私信要求双方使用 SEKAI Pass 登录。创建会话时，服务端会核实两人在指定聊天室的成员记录，并按两个账号 ID 生成唯一会话 ID；客户端不能指定发送者或对方资料。参与者检查覆盖历史、发送和会话管理接口。

## 行为与隐私

- 首条消息建立私信请求。在接收者接受之前，双方都不能继续发送；接收者可拒绝，也可稍后重新接受。
- “拒收消息”只影响对方发送给自己的新消息，不删除已有记录，也不阻止自己发送。对方再次发送时会看到拒收提示。
- “隐藏会话”是个人显示偏好：不显示正文、不计未读、不弹提醒，但新消息仍会保存。恢复显示后可重新查看，隐藏期间尚未阅读的消息也会计入未读。
- 文本上限为 256 个 UTF-16 码元，支持贴纸和引用回复。私信不进入公共聊天室、AI、公共搜索、公共收件箱或提及管线。
- 服务端持久保存正文；浏览器只在内存中缓存正文、草稿和失败发送项。退出或切换账号清空这些数据，刷新页面会丢失未发送草稿。私信不是端到端加密，目前没有消息删除或自动过期功能。
- 已读进度、隐藏和拒收状态跨设备同步。仅在窗口前台、会话可见、没有弹窗或导航遮挡且滚动到末尾时标记已读。

## 部署与存储

仓库的 `backend/wrangler.jsonc` 已设置 `DM_MODE=on`，按此配置部署会开启私信。

`backend/wrangler.jsonc` 的 `v4-direct-messages` 迁移注册 `DM_ROOMS` / `DirectRoom` 和 `DM_INBOXES` / `UserInbox`，使用 SQLite Durable Objects，不需要新增密钥。

| 配置 | 仓库配置值 | 含义 |
| --- | --- | --- |
| `DM_MODE` | `on` | 已开启私信。`read-only` 允许读取及已读、隐藏、拒收管理，禁止发信、创建会话和接受/拒绝请求；`off` 禁止访问但保留数据。 |
| `DM_MAX_BYTES` | `52428800` | 每个会话按消息 UTF-8 载荷加固定开销估算的容量上限；不是 SQLite 实际占用或账单上限。达到上限后禁止新消息，历史保留。 |
| `DM_REQUESTS_HOUR` | `10` | 每个账号在过去一小时首次发起会话的不同对象数。 |
| `DM_REQUESTS_DAY` | `30` | 每个账号在上海时区当天首次发起会话的不同对象数。重复打开同一对象不重复计数。 |

只有未设置 `DM_MODE` 或设置了无法识别的值时，服务端才回退为 `off`。后台推送另需配置 VAPID 密钥并由用户开启，不影响页面内收发私信。

每次 HTTP 请求经 SEKAI Pass 验证。每个账号使用一个 WebSocket 接收会话元数据，正文按需经 HTTP 分页读取。WebSocket 认证租期为五分钟，在四分钟左右续期；租期过期会重连，明确的登录失效才触发重新登录提示。重新连接和事件版本缺口会同步会话列表。

消息写入、会话状态和通知待办在同一个存储事务中提交。后台发送元数据给双方收件箱；持久化 alarm 负责失败重试，重复或乱序通知按版本去重。相同发送者与 `clientMessageId` 的重试只产生一条消息；同 ID 的不同载荷返回冲突。已读请求合并短时间内的最高可见序号，服务端只统计该序号之前的接收消息。

## 接口

HTTP 接口前缀为 `/api/dm`，要求配置允许的 `Origin`；除 `/config` 外使用 `Authorization: Bearer <token>`。响应禁止缓存。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /config` | 返回 `mode`、`enabled`。 |
| `GET /conversations?cursor=...` | 每页最多 50 个会话，返回 `next`、账号 `revision`。 |
| `POST /conversations` | `{peerId, sourceRoom}`，返回会话和账号版本。 |
| `GET /conversations/:id` | 参与者会话状态及个人偏好。 |
| `GET /conversations/:id/messages?before=N` | 读取更早历史；无游标时读取最新 50 条，按序号升序返回。 |
| `GET /conversations/:id/messages?after=N` | 补齐指定序号之后的消息，`more` 表示仍有后续页。 |
| `POST /conversations/:id/messages` | `{clientMessageId, kind, text, replyTo?}`，`kind` 为 `text` 或 `sticker`。 |
| `POST /conversations/:id/accept`、`reject` | 由请求接收者处理请求。 |
| `POST /conversations/:id/refuse` | `{refuseIncoming: boolean}`。 |
| `POST /conversations/:id/hide` | `{hidden: boolean}`。 |
| `POST /conversations/:id/read` | `{seq}`，服务器验证进度，重复或倒退的进度不会增加未读。 |
| `POST /conversations/:id/sync` | 参与者显式请求重新投递会话元数据。 |

`GET /events?account=sekai:...` 升级 WebSocket；账号参数用于路由，不代表认证。首帧及续期发送 `{type:"auth", accessToken}`，通过后返回 `dm:ready`（含 `user`、`expiresAt`、`revision`、`mode`）；后续 `dm:changed` 只携带元数据。令牌不放在 URL 中。

## 本地验证

先在 `backend` 执行 `npm ci`、`npm run check`、`npm run pretest`，再执行 `npm run test:dm`、`npm run test:dm:cost`、`npm run test:dm:browser`。浏览器测试使用本地身份夹具和 Chromium，不发送真实私信；截图输出到忽略的 `backend/dist/dm-screenshots`。前端回归在仓库根目录执行 `node --test test/direct-messages.test.mjs test/direct-message-view.test.mjs`。
