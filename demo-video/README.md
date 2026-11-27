# Nightcord 演示视频

成片：仓库根目录的 `nightcord-demo.mp4`（1920×1080 · 60 fps · 50.3 秒 · H.264 / AAC）。

画面里的聊天界面是仓库里真实的前端，没有改动任何前端源码。流程是：

1. `capture/`：用本地静态服务 + Playwright 的网络与 WebSocket 模拟（`mock.mjs`）跑起真实前端，按固定时间截取 2x 分辨率的界面截图，存到 `shots/`。
2. `scene/`：一个 HTML 页面，`render(t)` 是时间 `t` 的纯函数，负责镜头、转场、光标、标题等所有动效。
3. `render/`：逐帧渲染（`frames.mjs`），用仓库自带的提示音混音（`audio.py`），再用 ffmpeg 编码。

## 重新生成

依赖：Node 22、`playwright-core`（全局安装）、Google Chrome、ffmpeg（含 `libopenh264`）、Python 3 + Pillow。

```sh
node capture/shoot.mjs                 # 截取界面素材 → shots/
python3 capture/prep_assets.py         # 裁出登录卡片、提醒卡片 → assets/
python3 scene/gen_wordmark.py          # 由 icons/nightcord-wordmark.svg 生成逐字母路径
node render/preview.mjs 12 20 30       # 抽静帧检查布局（可选）
node render/frames.mjs                 # 逐帧渲染 → frames/（约 3 分钟）
python3 render/audio.py                # 混音 → build/audio.wav
# 编码命令见 render/encode.sh
```

时间轴、文案与镜头都在 `scene/data.js`。素材里的人物、消息和头像均为虚构的演示数据。
