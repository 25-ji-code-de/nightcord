# Nightcord 演示视频

成片：仓库根目录的 `nightcord-demo.mp4`（1920×1080 · 60 fps · 59.35 秒 · H.264 / AAC）。

画面里的聊天界面是仓库里真实的前端，没有改动任何前端源码。片中不放说明文字，只用真实界面、光标和线条来讲。流程是：

1. `capture/`：用本地静态服务 + Playwright 的网络与 WebSocket 模拟（`mock.mjs`）跑起真实前端，按固定时间截取 2x 分辨率的界面截图，存到 `shots/`。
2. `scene/`：一个 HTML 页面，`render(t)` 是时间 `t` 的纯函数，负责镜头、线条、卡片墙、徽章、光标等所有动效。
3. `render/`：逐帧渲染（`frames.mjs`），生成音轨（`audio.mjs`），再用 ffmpeg 编码（`encode.sh`）。

## 配乐与节奏

配乐取自 `reference.mp4` 的音轨（约 121 BPM，第一拍在 0.24 秒），不叠加音效。`scene/data.js` 里所有时刻都用 `beat(k)` 按拍号写：

| 拍 | 时刻 | 画面 |
| --- | --- | --- |
| 0–16 | 0–8.2 s | 线条绕出徽章，徽章落到登录卡片上；输入昵称并进入 |
| 16–62 | 8.2–31 s | 全景展示整个界面：输入、提醒、收件箱、搜索、配色、语音；看细节时才推近并跟随光标，看完拉回 |
| 62–80 | 31–39.9 s | 窗口退场；波浪线收成画框，画框撑满全屏 |
| 80–96 | 39.9–47.8 s | 每 2 拍切一个局部特写 |
| 96–101.5 | 47.8–50.6 s | 两部手机落定、互相转向，然后一上一下飞出 |
| 101.5–109 | 50.6–54.3 s | 六张界面卡片每半拍落一张，之后每拍点亮一张 |
| 109–115 | 54.3–57.3 s | 卡片卷进中心 → 勾出徽章 → 填色并扩散涟漪 → 移到字标位置 |
| 115 | 57.3 s | 最后一击，字标亮出；音乐在 57.8 秒收住 |

推近只发生在 `scene/data.js` 的 `ZOOM_SPANS` 列出的几段里；推近期间镜头中心是光标位置的滑动平均（`scene/render-b.js` 的 `camera`）。

## 重新生成

依赖：Node 22、`playwright-core`（全局安装）、Google Chrome、ffmpeg（含 `libopenh264`）、Python 3 + Pillow（仅截图素材预处理用）。

```sh
node capture/shoot.mjs                 # 截取界面素材 → shots/
python3 capture/prep_assets.py         # 裁出登录卡片、提醒卡片 → assets/
python3 scene/gen_wordmark.py          # 由 icons/nightcord-wordmark.svg 生成逐字母路径
node render/preview.mjs 12 20 30       # 抽静帧检查布局（可选）
node render/sheet.mjs build/s.png 12 20 30   # 把上面的静帧拼成联系表（可选）
node render/frames.mjs                 # 逐帧渲染 → frames/（约 5 分钟）
node render/audio.mjs                  # 音轨 → build/audio.wav
bash render/encode.sh                  # 编码 → ../nightcord-demo.mp4
```

素材里的人物、消息和头像均为虚构的演示数据。
