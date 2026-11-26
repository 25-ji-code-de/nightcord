# PWA 与后台推送

设置 → **应用与推送通知** 提供安装、后台私信推送、暂停一小时、存储保护和更新检查。支持的设备会显示未读私信角标。桌面 Chrome / Edge 和 Android 可使用安装按钮；iOS / iPadOS 16.4+ 需要通过 Safari 添加到主屏幕，然后从主屏幕打开并允许通知。

推送仅在用户点击开启后请求通知权限，要求登录 SEKAI Pass。它是当前账号、当前设备的独立设置，不受聊天室内的声音与提醒设置影响。隐藏会话、拒收、已读会取消尚未发出的通知；暂停后期间的消息不会补推。退出账号会清除设备状态并撤销浏览器订阅。通知只包含“您有新的私信，请打开 Nightcord 查看。”，不会发送消息正文或发送者资料。点击已有窗口的通知会打开会话并保留当前页面草稿；未登录时会在登录、同步后打开。

「消息提醒」中的新消息、回复我、@ 我和全体提及各有独立的「推送」开关，默认关闭。适用于公共聊天室和用户房间，按当前账号、设备、房间保存。首次开启会请求通知权限并启用现有设备订阅（含私信推送）。「声音与免打扰」中的暂停同步到当前房间推送；「应用与推送通知」中的暂停或关闭作用于该设备全部推送。成员上线、下线仍只在页面内提醒。

聊天室通知只显示“聊天室有新消息，请打开 Nightcord 查看。”，不包含正文、发送者或房间名。点击进入对应房间；已有窗口不在该房间时另开窗口，以免切换房间清空草稿。仍须通过原有房间成员鉴权。

## 聊天室推送与 Free 计划

- 复用现有 VAPID、`UserInbox` 设备凭据和房间 SQLite，不增加服务、D1 消息写入、绑定或 DO migration。未订阅房间不创建推送表；未订阅时消息发送路径没有新增推送 SQL 写入或 RPC。
- 首条匹配消息延迟约 15 秒；同一房间、同一设备连续消息合并，成功投递后至少间隔 60 秒。已经排队时后续消息不重复写任务或延后首次通知。
- 只有已启用的设备会进入推送队列，不遍历全部成员发 RPC。每批最多处理 8 个设备，每个设备使用一次 inbox RPC 检查有效订阅和设备暂停，再执行一次出站 Web Push。不使用定时轮询或客户端心跳；前台阅读状态仅在变化时通过现有 WebSocket 发送，阅读会取消尚未发出的通知。
- 每房间最多 256 个设备订阅，每 UTC 日最多 500 次 inbox 投递尝试（包含重试、暂停或失效设备的检查）。达到上限后当日新消息不再排队，次日仅推送新消息，不补推积压。每条任务最多尝试 3 次，重试间隔为 1、2 分钟；任务一小时过期，已发出的推送在浏览器服务端最多保留 5 分钟。
- 关闭设备推送立即撤销中央订阅；残留房间引用在下一次投递时移除，不再出站。成员被移除、封禁、房间归档或显示规则不再允许访问时，投递前重新检查并删除该订阅。房间选择 90 天过期，重新访问且验证设备后最多每天续期一次。
- 这些上限控制的是单个房间新增用量，不是整个 Cloudflare 账号的免费额度保证；总开销仍随订阅设备数、活跃房间数及站点原有业务增长。活跃聊天室优先只开启回复和个人提及，可显著减少投递。客户端与 Worker 的自动化测试验证合并、关闭页面、分类、权限、重试及预算；真实操作系统送达仍需部署后验证。

## 生产环境启用

前端和后端均需更新。仅更新前端会显示“后台推送通知当前不可用，请稍后再试。”。后端沿用 `UserInbox` 的 SQLite 和 alarm，不新增付费服务、数据库绑定或 DO migration。推送增加每台已订阅设备的存储与出站请求用量；未配置推送时不建立推送表、不添加私信推送任务。

在 `backend/` 执行一次 `npx web-push generate-vapid-keys --json`，将生成的密钥安全保存，再通过交互输入设置以下 Worker secrets：

```sh
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
```

`VAPID_SUBJECT` 使用实际维护者的 `mailto:` 地址或有效 HTTPS 联系页面。`VAPID_PRIVATE_KEY` 不能进入前端、仓库、日志或公开配置。公钥通过 `/api/push/config` 返回给浏览器。使用同一对密钥持续部署，轮换后用户需重新开启推送。`DM_MODE` 必须为 `on`。按现有流程部署 Worker 与 Pages 后，在设备的设置中主动开启推送。

本地联调可在被 git 忽略的 `backend/.dev.vars` 中设置同名变量。生产推送必须在真实 HTTPS 域名测试；localhost 可以验证 Service Worker、离线页面及设置交互。

## 行为与限制

- 每账号最多 8 个设备；订阅在 90 天未续期后不再推送，开启应用并验证登录会续期。已失效的浏览器订阅在应用重新打开时检查；不在 Service Worker 中保存登录 token 或自动续订账号。
- 使用标准 Web Push / VAPID 和 `aes128gcm` 加密。服务器只接受 Chrome、Firefox、Apple、Windows 浏览器推送服务的 HTTPS endpoint，且不跟随重定向。
- 发送在收件箱 alarm 中执行，约 2 秒合并同一设备、同一会话的连续消息。读取和隐藏会话能取消排队任务。网络错误、429 和 5xx 有限重试；404 / 410 删除订阅。通知有效期一小时，最多尝试 5 次。推送是尽力送达，浏览器或操作系统可能延迟通知。
- 已送达的有效推送会显示系统通知，包括页面处于前台时，以满足浏览器 `userVisibleOnly` 要求；同一会话的通知会合并替换。前台及时读取通常会在服务器发出推送前取消任务。后台角标只表示有新私信；重新打开应用后会校准为实际未读数。
- 离线缓存只保存应用界面与静态资源，代码始终优先读取网络。不会缓存 API、私信正文、凭据和音视频。离线不支持发送消息，不自动重发草稿。
- 更新只提示，由用户点击后激活并刷新；更新前应保存未发送的草稿。不会因后台安装了新 Service Worker 就自动刷新聊天。
- 自动化测试覆盖真实 Worker 加密载荷的解密和签名验证、账户隔离、取消与重试、通知点击和真实浏览器离线重载。真实设备上的操作系统推送送达仍需部署后验证。

## API

所有接口要求允许的 `Origin`，响应 `Cache-Control: no-store`。除 config 外，要求 `Authorization: Bearer <SEKAI Pass access token>`。

| 接口 | 请求 | 响应 |
| --- | --- | --- |
| `GET /api/push/config` | 无 | `{ enabled, publicKey }` |
| `POST /api/push/subscribe` | `{ subscription: PushSubscription.toJSON(), pausedUntil?: number }` | `{ enabled: true, pausedUntil }` |
| `POST /api/push/unsubscribe` | `{ endpoint }` | `{ enabled: false, pausedUntil: 0 }` |
| `POST /api/push/room` | `{ room, endpoint, preferences: { message, reply, mention, everyone, pausedUntil } }` | `{}` |

`pausedUntil` 为毫秒时间戳，最大为未来 24 小时，`0` 恢复。配置缺失返回 `503 push_unavailable`，账号未登录返回 `401 login_required`，设备数超限返回 `409 too_many_devices`，过频返回 `429 rate_limited`。每个接口支持 CORS OPTIONS。

房间接口的四个分类字段必须为布尔值，`pausedUntil` 还支持提醒设置的「直到手动恢复」（`Number.MAX_SAFE_INTEGER`）。必须已拥有此设备订阅并有房间访问权限；没有权限返回 `404 not_found`，设备不匹配返回 `400 invalid_subscription`，房间设备数超限返回 `409 room_push_limit`。
