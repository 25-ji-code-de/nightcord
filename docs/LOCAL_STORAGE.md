# 本地存储（localStorage）说明

本章节说明 Nightcord 在浏览器端使用 localStorage 保存聊天记录的约定、迁移策略与调试方法。

## Key 格式

- 私信后台推送：
  - localStorage Key: `nightcord-push-device`，仅保存当前设备订阅所属账号 `ownerId`、VAPID 公钥和 `pausedUntil`。不保存访问令牌或消息正文。
  - Service Worker 的 `nightcord-device` Cache 保存相同账号、暂停时间和 90 天有效期，用于过滤不属于当前账号的通知。退出登录会清除状态并撤销浏览器订阅；同步到服务端失败时，失效端点会在后续投递中清理。
  - sessionStorage Key: `nightcord-push-destination`，暂存通知对应的会话 ID，供 OAuth 返回并完成私信同步后打开；打开后删除。

- SEKAI Pass 会话提醒：
  - Key: `nightcord-sekai-session`
  - Value: `1` 表示用户尚未选择退出登录或以访客身份继续；仅用于在刷新页面后识别登录状态丢失，不作为身份凭据。
  - 登录失效时保留标记并提示「重新登录 / 暂不登录，继续使用」。主动登出或选择继续后清除；同源标签页同步这一选择。

- 侧边栏任务与收件箱已读状态：
  - Key: `nightcord-sidebar:<encodeURIComponent(roomname)>:<encodeURIComponent(userId)>`
  - 任务列表 `tasks`、待贴红单 `slips`、已读标记 `read`、最后使用的单号 `sequence` 和操作人 `operator` 保存在同一条记录里。删除或归档后，单号继续递增。
  - `createdAt` 和 `completedAt` 为出单与最近一次打卡完成的 Unix 毫秒时间；重新打开会清除完成时间，编辑标题不会改写时间。旧任务缺失的时间按未知处理，不回填。
  - `station` 记录纸留在哪台设备。新任务停在 `printer` 出纸口，取下上轨才写入 `startedAt`。收工时将本段起止写入 `sessions`，工时卡停在 `clock`，刷新后仍可取回。`archived` 表示已收入抽屉。旧任务缺省按原来的挂单或归档状态读取。
  - 任务内容与工时记录印在同一张任务卡上，共用一条任务记录。清单存放在 `items`，已贴的红单存放在 `notes`。累计工时只加总有起止时间的已结束段。
  - 红单独立保存为 `{ id, text, at, station }`，位置为 `printer` 或 `loose`；贴到任务时从 `slips` 移入该任务的 `notes`，取下时移回，保留原来的编号和打印时间。每个身份和房间最多保留 200 张未贴的红单。
  - 当前身份由服务端确认后启用；按身份和房间隔离。最多 200 项任务（标题 200 字），已读标记最多保留 2000 条。截止日期 `due` 为 `YYYY-MM-DD` 或空字符串。
  - 收件箱从已加载聊天记录中取最新的最多 2000 条回复与提及，不重复保存消息内容。任务及已读状态刷新后恢复，并响应同源标签页更新；不跨设备同步。访客 Cookie 清除后会产生新身份，原任务不会自动转移。
  - 存储不可用时保留当前页面内的改动并明确提示；清除站点数据会删除这些内容。删除任务可在当前窗口撤销最近一次操作。

- 提醒设置与关注：
  - Key: `nightcord-alerts:<encodeURIComponent(userId)>:<encodeURIComponent(roomname)>`
  - 保存提醒声音、音量、进退音效、各类提醒开关、普通消息显示 / 发声条件、暂停结束时间、成员动态范围，以及按稳定 ID 区分的 `followed`（显示名、上线 / 下线两个开关，最多 500 人）。
  - 按当前身份和房间隔离，同源标签页同步；访客重置身份后不按昵称关联。存储不可用时仅在当前页面保留改动，并在设置 / 资料卡提示。
  - 近期成员动态只保留在当前页面内存，最多 40 条；不保存到 localStorage。普通消息计数也仅保留于当前页面。

- 标签页音效去重：
  - Key: `nightcord-alert-delivery`
  - 只保存最近约一分钟的事件键和投递时间（约 250 条），不保存消息正文；配合 Web Locks 与 BroadcastChannel 协调同源标签页。清除此项不影响提醒设置或收件箱已读状态。

- 外观配色：
  - Key: `nightcord-palette`
  - Value: `gray-purple`、`indigo` 或 `plum-orchid`，默认 `gray-purple`；未知值也回退到 `gray-purple`。
  - 设置中选择后立即生效；刷新恢复、同源标签页同步。存储不可用时仍可切换本次页面的配色，设置内提示无法保存。只记录配色，不改变布局或风格。

- 成员列表样式：
  - Key: `nightcord-member-list`
  - Value: `current`（新版）或 `classic`（旧版），默认 `classic`；未知值回退到旧版。已有选择优先。
  - 仅改变 `member-list-panel` 内的分组图标、频道和成员行样式，与配色独立。即时生效、刷新恢复、同源标签页同步，不重新创建成员节点。文字聊天和离线成员在两版中均不显示摄像头 / 麦克风图标。

- 界面圆角：
  - Key: `nightcord-rounded-corners`
  - Value: `on`（圆角）或 `off`（直角），默认 `on`；未知值回退到圆角。
  - 与配色、成员列表样式独立。首次绘制前恢复选择；切换即时生效、自动保存、同源标签页同步。存储不可用时仍可切换，设置内提示无法保存。

- iPhone / iOS 适配：
  - Key: `nightcord-ios-layout`
  - Value: `on` 或 `off`；已保存的选择优先。没有选择或值无效时，iPhone / iPad / iPod 默认开启，其他设备默认关闭。iPadOS 的桌面模式通过 `MacIntel` 与多点触摸识别。
  - 开启后使用系统字体和分组设置行，开关沿用 Nightcord 原有样式；在手机尺寸（含触摸设备横屏）调整面板位置和屏幕安全区。输入栏收窄并贴近底部，背景可向下延伸 4px，按钮仍在安全区内。输入法唤起时保持顶栏位置，只缩减消息区域的高度；设置打开后收起导航及其遮罩。圆角关闭时仍尊重直角偏好。
  - 首次绘制前恢复；即时生效、刷新恢复、同源标签页同步。存储不可用时本次页面仍可切换，并提示无法保存。
  - 通用交互改进不依赖此开关：安卓、Windows 等设备同样支持清理设置后的侧栏遮罩、键盘焦点提示、减少动态效果，以及触屏 / 小屏输入工具的 44px 点击区域与可读字号。

- 语C角色：
  - Key: `nightcord-roleplay-roles`：JSON 数组，只保存用户添加的自定义角色名（默认的 K、雪、えななん、Amia 不保存）。读取时会按当前规则重新校验，重名、含方括号、超长或与 AI 同名的条目会被丢弃，最多保留 16 个。
  - Key: `nightcord-roleplay-active`：当前选中的角色名；空字符串表示以本人身份发言。旧版默认角色 Yuki、Enanan 自动对应为雪、えななん并保存，同名自定义角色保留原名。该角色已被删除时忽略。
  - 两项均为本浏览器设置，不跨设备同步；存储不可用时本次页面内仍可使用，刷新后丢失。

- 聊天消息（按房间）：
  - Key: `nightcord-messages:<roomname>`
  - Value: JSON 数组，元素格式为 { user, text, timestamp, profile, sender }
  - 说明：`user` 和 `profile` 保留发送时的昵称与资料快照，`sender` 用于 AI 转发者；UI 渲染层会生成 avatar、color、time 等显示信息。

- 最新消息时间戳（按房间）：
  - Key: `nightcord-lastmsg:<roomname>`
  - Value: 字符串化的整数时间戳（ms since epoch）

- 上次阅读位置（按身份、房间类型和房间）：
  - Key: `nightcord-reading:<userId>:<public|managed>:<roomname>`（身份和房间名使用 URL 编码）
  - Value: `{ timestamp, offset, seq? }`，只保存可见消息的位置；用户房间另存消息序号，不缓存消息正文。
  - 重开聊天先到最新；右上角可回到上次阅读的位置。自动跳到底部不会立即覆盖旧位置，开始阅读或主动跳转后再更新。
  - 记录只保存在当前浏览器。存储不可用时保留本次页面内的记录；旧消息已清除时不显示无法跳转的入口。

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
- 新消息先进入按房间分开的待写入队列，以 100 毫秒窗口合并写入，避免每条消息都解析和重写整份历史。写入时读取最新的存储内容，再合并本批消息；页面隐藏或离开时立即提交全部队列。通过 `StorageManager.loadMessages(room)` 或 `getLastMsgTimestamp(room)` 读取时，也会先提交该房间的待写入消息。
- 最后已知资料在内存中复用解析结果；每次查询仍检查存储原文，只在内容变化时重新解析，以便及时读取其他标签页的更新。
- localStorage 是浏览器级别持久化，受浏览器存储配额限制（通常数 MB 至数十 MB）。如果应用需要更高容量，请考虑后端存储或 IndexedDB。

## 示例

查看 `room-a` 的消息：

```javascript
const msgs = JSON.parse(localStorage.getItem('nightcord-messages:room-a') || '[]');
console.log(msgs.slice(-10)); // 查看最近 10 条

const last = localStorage.getItem('nightcord-lastmsg:room-a');
console.log('last:', last);
```
