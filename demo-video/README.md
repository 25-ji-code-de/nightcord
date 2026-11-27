# Nightcord 演示视频

成片：仓库根目录的 `nightcord-demo.mp4`（1920×1080 · 60 fps · 59.35 秒 · H.264 / AAC）。

画面里的聊天界面是仓库里真实的前端，没有改动任何前端源码。片中不放说明文字，只用真实界面、光标和线条来讲。流程是：

1. `capture/`：用本地静态服务 + Playwright 的网络与 WebSocket 模拟（`mock.mjs`）跑起真实前端，按固定时间截取 2x 分辨率的界面截图，存到 `shots/`。
2. `scene/`：一个 HTML 页面，`render(t)` 是时间 `t` 的纯函数，负责镜头、线条、徽章变形、光标等所有动效。
3. `render/`：逐帧渲染（`frames.mjs`），生成音轨（`audio.mjs`），再用 ffmpeg 编码（`encode.sh`）。

## 配乐与节奏

配乐取自 `reference.mp4` 的音轨（约 121 BPM，第一拍在 0.24 秒），不叠加音效。`scene/data.js` 里所有时刻都用 `beat(k)` 按拍号写：

| 拍 | 时刻 | 画面 |
| --- | --- | --- |
| 0–16 | 0–8.2 s | 线条绕出徽章，徽章落到登录卡片上；输入昵称 Amia 并进入 |
| 16–62 | 8.2–31 s | 全景展示整个界面：发消息、K 的回复提醒、收件箱、搜索、配色、语音；打字到提醒、搜索结果、语音面板这三段推近并跟随光标，看完拉回 |
| 62–80 | 31–39.9 s | 窗口退场；波浪线收成画框，画框撑满全屏 |
| 80–96 | 39.9–47.8 s | 每 2 拍切一个局部特写 |
| 96–108.6 | 47.8–54.1 s | 两部手机落定，第 102 拍合成正中的一部 |
| 108.6–111.9 | 54.1–55.7 s | 手机带透视倾斜，屏幕褪成线框；机身变形成外圆，灵动岛和底部横条变成两只眼睛，再勾出内圆 |
| 111.9–115 | 55.7–57.3 s | 线条徽章停留，然后缩小移到字标月牙的位置 |
| 115 | 57.3 s | 最后一击，月牙填实、字标浮现；音乐在 57.8 秒收住 |

推近只发生在 `scene/data.js` 的 `ZOOM_SPANS` 列出的几段里，推拉各约 1 秒，用起止速度与加速度都为 0 的曲线、在对数空间插值倍率。推近期间镜头中心是光标位置 1.2 秒窗口的加权平均，靠近窗口边缘时软夹紧；拉远开始后跟随逐渐减速（`scene/render-b.js` 的 `camera`）。改镜头后可以用 `node render/camcheck.mjs 8 34` 查看速度、加速度峰值和最不平滑的帧。

## 重新生成

依赖：Node 22、`playwright-core`（全局安装）、Google Chrome、ffmpeg（含 `libopenh264`）。重新生成字标路径时还需要 Python 3。

```sh
node capture/shoot.mjs                 # 截取界面素材 → shots/
node capture/prep_assets.mjs           # 裁出登录卡片、提醒卡片 → assets/
node capture/diffbox.mjs a.png b.png   # 比对两张截图的差异区域，用来定位提醒卡片（可选）
python3 scene/gen_wordmark.py          # 由 icons/nightcord-wordmark.svg 生成逐字母路径
node render/preview.mjs 12 20 30       # 抽静帧检查布局（可选）
node render/sheet.mjs build/s.png 12 20 30   # 把上面的静帧拼成联系表（可选）
node render/frames.mjs                 # 逐帧渲染 → frames/（约 5 分钟）
node render/audio.mjs                  # 音轨 → build/audio.wav
bash render/encode.sh                  # 编码 → ../nightcord-demo.mp4
```

## 对话

对话不是编的：人物（K、雪、えななん、Amia）、台词和时间都取自 `reference-chat.jpg`，与 `index.html` 注释里保留的示例对话一致（`capture/mock.mjs` 的 `history`）。片中视角是 Amia：输入昵称进入，发出“有人在吗——？”，收到 K 的回复“我在”（站内提醒、收件箱），搜索“25点”找到 K 的“嗯。25点再见”。K 在 16:12 发的 `MIXrough02.mp3`（6.9MB）用真实的文件卡片显示。头像只用首字与配色，不使用任何角色图片。
