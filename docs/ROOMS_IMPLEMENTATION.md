# 用户房实现与验证

官方房和旧链接房沿用原 namespace，新用户房使用 `r_` ID、`ManagedRoom` 和 D1。

已实现三种创建模式、大厅/我的房间、正式成员、在线状态、邀请生成/撤销/兑换、移出/禁止加入/解除禁止、转让与归档。用户房复用作业房的聊天界面；成员可通过可信 ManagedRoom 来源发起私信。只有活动用户房建立连接，不保存正文到 localStorage，不进入公共房 AI、上传或语音链路。未打开房间没有全局未读或后台订阅。

创建的账号和全站额度在 D1 同一条件 INSERT 中预留，固定请求 ID 和参数哈希，pending/归档仍占额度。我的房间最多恢复该账号三个 pending 创建。目录与成员引用采用版本墓碑，消息不更新目录；站方下架位独立于房主发布版本。隐藏尚未同步成功返回 202 和 syncing，界面显示同步中，不能当作已隐藏。重复操作可以重新确认；失败任务仍由 alarm 恢复。

WS 第一帧认证，五分钟租约，四分钟左右续期；首屏/补齐/发送走同一连接。过期和已撤销成员不能接收正文；等待认证返回后重新查成员。消息 ID 重试校验内容，重复确认不再次扣发送额度，容量满或归档后仍能确认合法成员已保存的消息。房间本地限流不等于全站统一发送额度。正式成员上限 50，每房/每账号连接数 64/3；每房默认 8 MiB 内容预算和每日 1,000 条。

浏览器将邀请秘密从 fragment 立即移除，仅在登录跳转时存入当前标签的 sessionStorage；回调恢复后清除。所有请求和 WS 都有账号/房间代次隔离。列表在内存复用 30 秒，管理后清缓存。断线时保留内存用于补齐，但重新鉴权前不展示正文；失权和账号重置清除消息、成员、待发送内容和邀请。

## 本地聊天界面复用（未发布）

`ManagedChatView` 将用户房数据接入现有 `#messages`、`#messageInput`、消息渲染器、回复、提及/贴纸选择器、文本格式工具、成员侧栏、搜索与收件箱。房间管理通过标题栏「房间信息」进入。删除独立的 `.rooms-log`、`.rooms-message` 和 `.rooms-compose` 实现，不再维护两套聊天 UI。

用户房回复以房间内序号定位，由适配层转换为共享回复引用；发送走 `RoomManager`，不经过公共房命令、AI 或消息持久化事件。归档、断线与只读状态禁用输入工具。成员变动刷新受权限保护的成员列表；失权或切换账号时同步清空聊天 DOM、回复索引、草稿、成员和搜索预览。官方频道草稿在返回时恢复。共用回复按钮补充键盘焦点与触屏操作。

用户房的「我的显示状态」也通过当前房间连接保存：`ready` 返回本人 `visibility`，`room:visibility` 命令支持 `online` / `offline` / `hidden`，只修改已验证的当前账号。选择按账号和房间持久保存，同账号其他连接同步；切回官方频道后使用官方频道自己的设置。聊天侧栏和普通成员查询过滤隐藏成员、在线列表过滤离线及隐藏状态；房主的成员管理仍保留完整名单以便移出、禁止和转让。聊天侧栏使用 `/members?view=roster`，包括房主也使用经过过滤的结果。隐藏不删除正式成员资格、消息或房主信息。

房主可在创建和房间设置中选择 `visibilityPolicy`：`online`（只允许正常显示）、`offline`（还允许显示为离线）、`hidden`（允许全部三种状态）。规则适用于房主和普通成员，仅影响当前自建房。旧房间未保存此字段时按 `hidden` 读取；旧创建请求的重试仍按归一化后的设置判断幂等。无需 D1 表结构迁移。

收紧规则不会重写已有个人状态。若个人状态不再允许，服务器向本人所有连接发送 `room:visibility-required`（房间规则、本人资料和原状态，不附带消息/成员列表），暂停其消息收发及成员列表读取；重连和重启后同样检查。连接只保留认证续期与显示状态确认能力，房主仍可通过管理接口调整房间规则。客户端需让成员明确选择允许的状态，并以 `room:visibility` 携带 `confirmPolicy`（当前规则值）确认。服务器在限流异步调用后重新检查权限及最新规则，拒绝禁止的状态或过期确认。确认成功后恢复本人所有连接并重新发送 `ready`；规则放宽到允许原状态时也可恢复，无需改变个人状态。「暂时离开」只断开聊天、返回大厅，保留成员资格。

验证入口：`node --test test/rooms.test.mjs` 覆盖权限、旧数据、收紧/放宽、多标签页、重连和重启；`node --test test/room-visibility-policy-browser.test.mjs` 覆盖房主设置、手机确认、暂时离开、再次进入及个人设置选项限制。

显示设置区分别提示连接中、连接已断开或服务版本不支持。部署时后端与前端需要同步更新；本地预览若来自 `dist/`，修改源文件后需重新运行 `node scripts/build-pages.mjs`。

本轮仅修改本地代码，按用户要求不部署。覆盖同一 DOM 节点复用、双人收发、富文本安全、回复、提及、贴纸、重试、重连、房间切换、归档、可信来源私信、失权清理与本地存储隔离。

## 此前生产部署记录

2026-11-25 已启用生产环境，`ROOMS_MODE`、`ROOMS_CREATE`、`ROOMS_DISCOVERY` 均为 `on`。后端基于已提交的 `79d0a6b` 代码，增加官方频道配置；前端包含本次大厅导航、样式、正式文案及官方频道列表调整。

- Worker：`nightcord-chat`，版本 `18fd36cf-96a9-40d7-be94-70df91cdfee1`，域名 `chat.nightcord.de5.net`。
- D1：`nightcord-rooms`，ID `2a8307f7-5298-47b1-b229-8a2b18921b03`，APAC 区域，已应用 `0001_rooms.sql`。
- Durable Objects：已应用 `v5-managed-rooms`，保留原有 migration 和 namespace。
- Pages：`nightcord-web` 的 `main` 生产环境，部署 `ab5fdf58-874b-4fbb-8503-a9d0df027d10`，域名 `nightcord.de5.net`。

发布前通过类型检查、296 项前端单元测试、70 项后端测试，以及身份、房间、私信、成员可见性和 PWA 浏览器回归。生产环境已验证健康检查、房间配置和公开列表接口，未登录的创建请求返回 401。

官方频道列表更新另通过 11 项房间后端测试、18 项前端检查和身份／房间浏览器回归；覆盖多个官方频道的顺序、名称、进入路径，以及用户房目录失败或关闭时的可访问性。生产域名已验证官方频道卡片、进入频道后的标题及手机布局。

后续部署复用现有数据库；有新增迁移时，在 `backend` 执行 `npx wrangler d1 migrations apply ROOM_DIRECTORY --remote`，再部署 Worker 和静态站。停用时设 `ROOMS_MODE=off` 并重新部署，保留数据库与 namespace；可分别设 `ROOMS_CREATE=off`、`ROOMS_DISCOVERY=off` 或 `ROOMS_MODE=read-only` 降级。

站方管理员通过 `ROOMS_MODERATORS` 配置，值为逗号分隔的可信 `sekai:<sub>`。本次发布未指定管理员账号。

## 官方频道列表

`backend/wrangler.jsonc` 的 `vars.ROOMS_OFFICIAL` 为官方频道数组，按配置顺序显示在大厅公开房间列表前部，与用户房间使用相同的卡片布局，并标注「官方」。每项包含 `id`、`name` 和可选的 `description`，支持多个频道；仅配置中列出的频道具有官方标识，普通用户创建房间不能设置该标识。

```json
"ROOMS_OFFICIAL": [
  { "id": "nightcord-default", "name": "作业", "description": "Nightcord 官方公共聊天室。" },
  { "id": "nightcord-study", "name": "自习室", "description": "官方自习频道。" }
]
```

上面的第二项仅为扩展示例，生产配置目前保留「作业」。新增频道时使用唯一且稳定的 ID（1–32 位小写字母、数字或连字符），填入名称及简介后部署 Worker；页面刷新后会读取最新列表，进入频道后的标题同步使用配置名称。调整名称或排序不会改变频道历史，修改 ID 则会指向另一个频道。

官方频道沿用公共聊天室连接，无需用户房成员关系；「我的房间」仍展示已加入的用户房。用户房间关闭、目录暂停或加载失败时，官方频道仍可访问。语音权限继续由 `VOICE_ALLOWED_ROOMS` 单独控制，新增官方频道不会自动开启语音。

站方下架入口：`POST /api/rooms/:id/moderation`，Pass Bearer 身份必须在 `ROOMS_MODERATORS` 中；请求 `{ "hidden": true, "reason": "具体原因" }`，解除时 hidden=false。每次写 D1 管理记录。此权限只管理目录展示，不授予消息阅读权限。

配置可覆盖 `ROOMS_MAX_TOTAL`（100）、`ROOMS_MAX_OWNED`（3）、`ROOMS_MAX_BYTES`（8388608）、`ROOMS_DAILY_MESSAGES`（1000）。8 MiB 是应用估计正文/资料大小，不是 SQLite 文件总大小或免费额度保证。

## 可复核验证

`npm run check`、`npm test`、`npm run test:browser`；根目录 `node --test 'test/*.test.mjs'` 与 `node scripts/build-pages.mjs`。新套件 `test:rooms` 和 `test:rooms:browser` 也可独立运行，需先 `npm run pretest`。本地 Node 22 使用 `NODE_OPTIONS=--experimental-strip-types`，CI 使用 Node 24。

后端用真实 Miniflare SQLite/D1 验证配额竞态、邀请最后一次兑换、幂等、权限撤销、转让、归档、重复确认、租约过期、D1 故障/重启恢复和事务回滚。浏览器覆盖桌面/手机宽度下创建、加入、发送、回复、邀请管理、移出与账号内存清理。前端单测覆盖乱序确认、去重、迟到请求和邀请目的地。

成本原始数据见 `measurements/rooms.json`。每个场景建立 1/10/50 个正式成员、一个在线发送连接，发送 100 条。测试副本仅取消发送间隔等待并注入内存计数，SQL cursor 消费后读取 rowsRead/rowsWritten；没有生产逐消息日志。观察到每条消息 4 行 SQL 写入，和正式成员数无关。可用 `ROOM_COST_OUTPUT=../docs/measurements/rooms.json npm run test:rooms` 重现。

没有测量 50 个同时在线连接、真实 Cloudflare duration、休眠或账号剩余额度。广播 CPU/帧数及接收资格读取随在线连接增长；外部 D1 调用用有限批次合并，平台 RPC 没有在本实现中获得可取消的 I/O 上限，不能声称本地测试证明故障时长有界。日额度错误只对明确含每日限制的 D1 错误使用跨日退避，其余故障用指数退避，不能把一般网络错误当作配额耗尽。
