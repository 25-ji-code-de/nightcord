# Nightcord 演示视频

原成片：仓库根目录的 `nightcord-demo.mp4`（1920×1080 · 60 fps · 59.35 秒 · H.264 / AAC）。本次只更新源码和头像文件，尚未运行截图、渲染或编码；仓库中的原成片和 `shots/`、`assets/` 仍是旧版。

新流程分两次导出：先生成 `nightcord-demo-preview.mp4`，确认后再手动生成 `nightcord-demo-4k.mp4`，均输出到仓库根目录。

画面里的聊天界面是仓库里真实的前端，没有改动任何前端源码。片中不放说明文字，只用真实界面、光标和线条来讲。流程是：

1. `capture/`：用本地静态服务 + Playwright 的网络与 WebSocket 模拟（`mock.mjs`）跑起真实前端，按固定时间截取界面截图。预览版使用 2x、最终版使用 4x 采样，分别存到 `build/preview/shots/`、`build/final/shots/`。
2. `scene/`：一个 HTML 页面，`render(t)` 是时间 `t` 的纯函数，负责镜头、线条、徽章变形、光标等所有动效。
3. `render/`：逐帧渲染（`frames.mjs`），生成音轨（`audio.mjs`），再用 ffmpeg 编码（`encode.mjs` / `encode.sh`）。`export.mjs` 按顺序执行整个流程，任何一步失败都会停止。

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

在 Linux 渲染环境运行，依赖 Node 22、`playwright-core`（项目内或当前 Node 的全局安装）、Google Chrome、ffmpeg 和 ffprobe。推荐使用含 `libx264` 的 ffmpeg；仅预览版兼容原环境的 `libopenh264`，最终版必须使用 `libx264`。Chrome 默认路径为 `/usr/bin/google-chrome`，可用 `CHROME_PATH` 覆盖。使用已有的字标路径，无需重新生成。

在仓库根目录运行：

```sh
git pull --ff-only origin demo
node demo-video/render/export.mjs preview
```

不传参数也只生成预览版。先查看 `nightcord-demo-preview.mp4`；确认画面后再运行下面的命令，预览导出不会自动启动最终版：

```sh
node demo-video/render/export.mjs final
```

| 规格 | 预览版 | 最终版 |
| --- | --- | --- |
| 画面 | 1920×1080 · 60 fps | 3840×2160 · 60 fps |
| 界面截图 | 2x PNG（桌面 2880×1800） | 4x PNG（桌面 5760×3600） |
| 场景渲染 | 1x，无损 PNG 中间帧 | 2x，无损 PNG 中间帧 |
| H.264 目标码率 / 峰值上限 | 24 / 36 Mbps | 80 / 120 Mbps |
| libx264 preset | slow | veryslow |
| AAC 音频 | 256 kbps · 48 kHz | 320 kbps · 48 kHz |
| 默认并行页面数 | 8 | 2 |

码率为编码目标，实际值随画面内容变化。两版都去掉了原来的 `noise=alls=7:allf=t` 滤镜，保留 BT.709、电视范围、`yuv420p` 和 `faststart`。4K 在原有 1920×1080 CSS 舞台上以 2x 像素密度直接渲染，并重新截取 4x 界面素材；布局、分镜、台词、时长和配乐保持原样。`render/config.mjs` 统一管理两档参数，帧率和时长直接读取 `scene/data.js`。

需要减少内存占用时可降低并行数，例如：

```sh
DEMO_WORKERS=1 node demo-video/render/export.mjs final
```

中间素材和帧按版本隔离在 `build/<版本>/`、`frames/<版本>/`，已被 Git 忽略。每次完整导出会重新截图、裁切，并清理该版本的旧帧后渲染。编码前检查全部 3561 帧的编号和 PNG 尺寸，编码后检查分辨率、帧率、帧数和音画时长，成功后才替换对应输出文件。

需要分步执行、检查静帧或续渲时，从 `demo-video/` 目录运行；`DEMO_PROFILE` 默认为 `preview`，最终版改为 `final`：

```sh
export DEMO_PROFILE=preview
node capture/shoot.mjs                      # 截取界面素材 → build/preview/shots/
node capture/prep_assets.mjs                # 裁出卡片 → build/preview/assets/
node render/preview.mjs 12 20 30            # 抽静帧 → build/preview/stills/（可选）
node render/sheet.mjs build/s.png 12 20 30   # 拼成联系表（可选）
node render/frames.mjs                      # 渲染所有帧 → frames/preview/
# node render/frames.mjs 1200 3561 4         # 中断后按需补渲 [1200, 3561)，4 个页面
node render/audio.mjs                       # 音轨 → build/audio.wav
node render/check_frames.mjs               # 只检查帧文件头（可选，编码前会自动检查）
bash render/encode.sh                       # 编码当前 DEMO_PROFILE 对应的帧
# bash render/encode.sh preview ../custom.mp4  # 可单独指定版本和输出文件
```

不要复用原来的 `frames/*.jpg`，也不要把不同源码版本的帧混在一起。续渲只适用于素材、源码和导出参数未改动的同一任务。直接打开 `scene/index.html` 可查看原版素材；新导出使用 `?profile=preview` 或 `?profile=final` 加载对应的新素材。

## 对话

对话不是编的：人物（K、雪、えななん、Amia）、台词和时间都取自 `reference-chat.jpg`，与 `index.html` 注释里保留的示例对话一致（`capture/mock.mjs` 的 `history`）。片中视角是 Amia：输入昵称进入，发出“有人在吗——？”，收到 K 的回复“我在”（站内提醒、收件箱），搜索“25点”找到 K 的“嗯。25点再见”。K 在 16:12 发的 `MIXrough02.mp3`（6.9MB）用真实的文件卡片显示。

头像来自本次同步的 `origin/main`（`4208e81`）中的 `icons/roleplay/`：Amia → `amia.png`，えななん → `enanan.png`，K → `k.png`，雪 → `yuki.png`。模拟后端从本地文件响应头像请求，不依赖运行时联网；Amia 的游客与 SEKAI Pass 两种模拟身份均带有头像。截图前等待头像解码完成。
