# Nightcord 演示视频

成片：仓库根目录的 `nightcord-demo.mp4`（1920×1080 · 60 fps · 58.4 秒 · H.264 / AAC）。

画面里的聊天界面是仓库里真实的前端，没有改动任何前端源码。流程是：

1. `capture/`：用本地静态服务 + Playwright 的网络与 WebSocket 模拟（`mock.mjs`）跑起真实前端，按固定时间截取 2x 分辨率的界面截图，存到 `shots/`。
2. `scene/`：一个 HTML 页面，`render(t)` 是时间 `t` 的纯函数，负责镜头、转场、线条、光标、标题等所有动效。
3. `render/`：逐帧渲染（`frames.mjs`），混音（`audio.mjs`），再用 ffmpeg 编码（`encode.sh`）。

## 配乐与节奏

配乐取自 `reference.mp4` 的音轨（约 121 BPM，58 秒）。`scene/data.js` 里的 `MUSIC` 按拍号标出段落，`TIME_MAP` 把各个画面段落对到这些点上：

| 音乐 | 时刻 | 画面 |
| --- | --- | --- |
| 前奏结束 | 8.2 s | 聊天窗口入场 |
| 第一次高潮 | 24.0 s | 全局搜索 |
| 间奏 | 31.0 s 起 | 语音、配色，随后线条转场 |
| 第二次高潮 | 39.9 s | 手机，之后每 2 拍切一个局部特写 |
| 尾声 | 51.8 s | 片尾字标 |

`audio.mjs` 直接读取 `data.js` 的时间映射来放置提示音，改时间轴后重新混音即可保持同步。

## 重新生成

依赖：Node 22、`playwright-core`（全局安装）、Google Chrome、ffmpeg（含 `libopenh264`）、Python 3 + Pillow（仅截图素材预处理用）。

```sh
node capture/shoot.mjs                 # 截取界面素材 → shots/
python3 capture/prep_assets.py         # 裁出登录卡片、提醒卡片 → assets/
python3 scene/gen_wordmark.py          # 由 icons/nightcord-wordmark.svg 生成逐字母路径
node render/preview.mjs 12 20 30       # 抽静帧检查布局（可选）
node render/sheet.mjs build/s.png 12 20 30   # 把上面的静帧拼成联系表（可选）
node render/frames.mjs                 # 逐帧渲染 → frames/（约 4 分钟）
node render/audio.mjs                  # 混音 → build/audio.wav
bash render/encode.sh                  # 编码 → ../nightcord-demo.mp4
```

时间轴、文案与镜头都在 `scene/data.js`。素材里的人物、消息和头像均为虚构的演示数据。
