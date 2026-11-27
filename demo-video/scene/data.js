// 分镜与时间轴（秒）。所有文案都取自仓库 README / 界面里真实存在的功能。
const FPS = 60;
const DUR = 58.4;

// 配乐（demo-video/reference.mp4 的音轨）约 121 BPM，第一拍在 0.24 秒。
// 段落按拍号划分：前奏 0–16，主歌 16–48，第一次高潮 48–62，间奏 62–80，第二次高潮 80–116（音乐在第 116 拍结束）。
const BEAT = 0.4958, BEAT0 = 0.24;
const beat = k => BEAT0 + BEAT * k;
const MUSIC = { lift: beat(16), drop1: beat(48), brk: beat(62), drop2: beat(80), end: beat(116) };

// 旧时间轴（50.3 秒版本）→ 新时间轴的分段线性映射，让每个段落落在音乐的段落点上：
// 窗口在前奏结束时入场，搜索踩第一次高潮，手机踩第二次高潮，片尾字标落在第 104 拍。
// render/audio.mjs 也读取这份映射来对齐提示音。
const TIME_MAP = [
  [0, 0], [9.5, MUSIC.lift], [24.0, MUSIC.drop1], [28.0, 28.04], [34.0, 33.0], [38.2, 37.6],
  [38.6, MUSIC.drop2], [42.0, beat(88)], [42.6, beat(96)], [45.7, beat(104)], [50.3, DUR],
];
function W(t) {
  const m = TIME_MAP;
  if (t <= m[0][0]) return t;
  for (let i = 0; i < m.length - 1; i++) {
    const [a0, b0] = m[i], [a1, b1] = m[i + 1];
    if (t <= a1) return b0 + (t - a0) * (b1 - b0) / (a1 - a0);
  }
  return t - m[m.length - 1][0] + m[m.length - 1][1];
}
// 新时间 → 旧时间：登录卡片、开场字标等动画仍按旧时间轴编写。
function Winv(t) {
  const m = TIME_MAP;
  for (let i = 0; i < m.length - 1; i++) {
    const [a0, b0] = m[i], [a1, b1] = m[i + 1];
    if (t <= b1) return a0 + (t - b0) * (a1 - a0) / (b1 - b0);
  }
  return t - m[m.length - 1][1] + m[m.length - 1][0];
}
const Wk = list => list.map(([t, ...rest]) => [W(t), ...rest]);

// 窗口（1440x900 的真实前端截图，2x 采样）在舞台上的镜头：[x, y, scale]
const WIN_W = 1440, WIN_H = 900;
// 以窗口坐标 (cx, cy) 为画面中心、放大 s 倍的镜头；放大后窗口必须盖满 1920x1080。
function view(cx, cy, s) {
  return [clamp(960 - cx * s, 1920 - WIN_W * s, 0), clamp(540 - cy * s, 1080 - WIN_H * s, 0), s];
}
const BASE = [(1920 - WIN_W * 0.86) / 2, 232, 0.86];
const BASE_IN = [960 - WIN_W * 0.9 / 2, 619 - WIN_H * 0.9 / 2, 0.9];   // 同一中心，略微推近
const Z_COMPOSER = [-2, -209, 1.3];
const Z_SENT = view(640, 700, 1.7);               // 发出的消息与输入框
const Z_TOAST = [-384, 60, 1.6];                  // 提醒镜头为了让卡片入镜，允许顶部露出背景
const Z_SEARCH = view(820, 200, 1.8);             // 搜索框与结果
const Z_VOICE_A = view(1183, 325, 1.6);           // 语音面板：先推近，停留时继续缓慢推进
const Z_VOICE_B = view(1183, 325, 1.75);
const Z_THEME = view(815, 455, 1.6);              // 配色卡片

const CAM = [
  { t: 0, v: BASE }, { t: MUSIC.lift, v: BASE }, { t: W(12.8), v: BASE_IN },
  { t: W(13.8), v: Z_COMPOSER }, { t: 14.85, v: Z_COMPOSER }, { t: 15.45, v: Z_SENT }, { t: 16.0, v: Z_SENT }, { t: 16.75, v: BASE },
  { t: W(18.9), v: BASE }, { t: W(19.8), v: Z_TOAST }, { t: W(21.2), v: Z_TOAST }, { t: W(22.1), v: BASE },
  // 收件箱缓慢推近，第一次高潮时快速拉回
  { t: MUSIC.drop1 - 0.08, v: BASE_IN, e: EASE.out }, { t: MUSIC.drop1 + 0.3, v: BASE },
  { t: 26.15, v: BASE }, { t: 26.85, v: Z_SEARCH }, { t: 27.45, v: Z_SEARCH }, { t: 28.15, v: BASE },
  { t: W(30.0), v: BASE }, { t: W(31.0), v: Z_VOICE_A }, { t: W(33.2), v: Z_VOICE_B }, { t: W(34.1), v: BASE },
  { t: 34.55, v: BASE }, { t: 35.25, v: Z_THEME }, { t: 36.6, v: Z_THEME }, { t: 37.3, v: BASE },
];

// 窗口里依次出现的真实界面（后者盖在前者之上）。t 为开始淡入时间，d 为淡入时长。
const STATES = [
  { src: 'chat', t: 9.5, d: 0.5 },
  { src: 'chat-sent', t: 15.5, d: 0.25 },
  { src: 'notify-clean', t: 17.2, d: 0.35 },
  { src: 'inbox-clean', t: 22.45, d: 0.12 },
  { src: 'search-0', t: 24.75, d: 0.12 },
  { src: 'search-1', t: 25.6, d: 0.06 },
  { src: 'search-2', t: 26.0, d: 0.06 },
  { src: 'voice-roster', t: 28.35, d: 0.35 },
  { src: 'voice-panel', t: 29.7, d: 0.3 },
  { src: 'chat', t: 34.2, d: 0.5 },
  { src: 'settings', t: 34.75, d: 0.3 },
  { src: 'settings-indigo', t: 35.8, d: 0.45 },
  { src: 'settings-plum', t: 37.0, d: 0.45 },
].map(s => ({ ...s, t: W(s.t) }));

const WIN_IN = MUSIC.lift, WIN_OUT = [37.6, 38.45];
const TYPE_START = W(13.3), TYPE_STEP = 0.17 * (W(15) - W(14)), TYPE_N = 10, TYPE_END = W(15.75);
const STRIP = { x: 340, y: 810, w: 1100, h: 90 };       // 窗口坐标系里的输入框条带
const TOAST = { in: W(17.9), out: W(22.3) };            // 站内提醒卡片（独立叠层，便于做滑入）

// 光标。[t, x, y]：stage 为舞台坐标，win 为窗口坐标（1440x900）。
const CUR_STAGE = Wk([[6.3, 1720, 260], [7.2, 1362, 512], [8.2, 1362, 520], [8.8, 1362, 650]]);
const CUR_WIN = Wk([
  [9.9, 900, 520], [12.2, 900, 700], [12.8, 900, 853], [16.6, 900, 853], [18.5, 1000, 330], [21.4, 1000, 330],
  [22.3, 28, 274], [23.4, 28, 274], [24.5, 28, 124], [24.9, 28, 124], [25.4, 900, 520], [27.7, 900, 520],
  [28.15, 1392, 24], [28.3, 1392, 24], [29.4, 1318, 24], [30.8, 1318, 24], [31.4, 1100, 420],
  [34.0, 60, 300], [34.5, 28, 474], [35.0, 28, 474], [35.55, 816, 456], [36.2, 816, 456], [36.75, 1027, 456], [37.7, 1027, 456],
]);
const CLICKS = [7.3, 8.9, 12.9, 22.4, 24.6, 28.2, 29.6, 34.6, 35.65, 36.85].map(W);
const CUR_STAGE_VIS = [[W(6.3), W(9.2)]];
const CUR_WIN_VIS = [[W(9.9), W(31.5)], [W(34.0), W(37.8)]];

// 标题。g 为渐变高亮的行号；al 为对齐；t0/t1 为显示区间。
const HL = [
  { t0: 5.8, t1: 9.1, x: 150, y: 400, w: 820, al: 'left', size: 92, lines: ['输入昵称，', '就能加入。'], g: 1, sub: '游客直接进入，也可使用 SEKAI Pass 登录。', ss: 30 },
  { t0: 10.1, t1: 12.4, x: 0, y: 44, w: 1920, al: 'center', size: 58, lines: ['实时聊天，安静而流畅。'], g: 0, sub: 'WebSocket 实时同步，断线自动重连。', ss: 27 },
  { t0: 17.4, t1: 18.9, x: 0, y: 44, w: 1920, al: 'center', size: 58, lines: ['被回复，被 @，第一时间知道。'], g: 0, sub: '站内提醒卡片、收件箱与未读角标。', ss: 27 },
  { t0: 22.6, t1: 23.9, x: 0, y: 44, w: 1920, al: 'center', size: 58, lines: ['收件箱，汇总所有提醒。'], g: 0, sub: '按类型与未读筛选，可逐条或全部标记已读。', ss: 27 },
  { t0: 24.0, t1: 25.95, x: 0, y: 44, w: 1920, al: 'center', size: 58, lines: ['全局搜索，一键跳回原消息。'], g: 0, sub: '关键词、发送者、日期筛选，快捷键 Ctrl / ⌘ + K。', ss: 27 },
  { t0: 28.3, t1: 30.0, x: 0, y: 44, w: 1920, al: 'center', size: 58, lines: ['房间语音，最多 8 人同聊。'], g: 0, sub: '原生 WebRTC，搭配 Cloudflare SFU / TURN。', ss: 27 },
  { t0: 34.3, t1: 35.45, x: 0, y: 40, w: 1920, al: 'center', size: 58, lines: ['三种配色，即选即用。'], g: 0, sub: '', ss: 0 },
  { t0: 38.6, t1: 42.0, x: 150, y: 410, w: 760, al: 'left', size: 84, lines: ['手机上，', '同样顺手。'], g: 1, sub: '可安装为 PWA，支持离线外壳与后台推送。', ss: 28 },
  { t0: 42.6, t1: 45.0, x: 0, y: 368, w: 1920, al: 'center', size: 88, lines: ['还有更多，等你发现。'], g: 0, sub: '', ss: 0 },
].map(h => ({ ...h, t0: W(h.t0), t1: W(h.t1) }));
// 搜索与配色两段的标题提前收起，给后面的局部特写让出画面顶部（这两个值本身就是新时间轴）。
HL[4].t1 = 25.95;
HL[6].t1 = 34.5;

const CHIPS = [
  '私信与会话隐藏', '@ 提及与 @everyone', 'Nako · Asagi · Miku · 汤川唯', 'Emoji 表情选择器', '图片 / 音频 / 文件上传',
  '任务台', '成员动态与关注', 'PWA 离线外壳', '后台推送', '圆角与布局设置',
];
const CHIPS_T = [W(43.4), W(45.4)]; // 开始出现、整体退出结束
const PHONES_T = [W(38.6), W(41.8)];
const OUTRO = { wm: W(45.7), tag: W(46.5), urls: W(47.1) };
const FADE_OUT = W(49.2);

// 第二次高潮里的局部特写：每张停留 2 拍。cx/cy 为窗口坐标里的画面中心，w 为裁切宽度（16:9）。
const MONT_T0 = beat(88), MONT_STEP = BEAT * 2;
const MONTAGE = [
  { src: 'chat-sent', cx: 640, cy: 650, w: 900, dx: -40 },
  { src: 'notify-clean', toast: true, cx: 1000, cy: 260, w: 880, dx: 30 },
  { src: 'voice-panel', cx: 1183, cy: 325, w: 1100, dx: -30 },
  { src: 'settings-indigo', cx: 815, cy: 470, w: 900, dx: 30 },
];
const MONT_END = MONT_T0 + MONTAGE.length * MONT_STEP;

// 画面整体的“打点”：高潮第一拍重一些，之后每小节轻轻一下。[时刻, 幅度]
const PUNCH = [
  [MUSIC.drop1, 0.03], [beat(52), 0.007], [beat(56), 0.007], [beat(60), 0.007],
  [MUSIC.drop2, 0.03], [beat(84), 0.007], [beat(104), 0.012],
];

// 间奏里的线条转场：横穿画面的波浪线，随后勾出两部手机的轮廓。
const LINES_T = { wave: [37.75, 39.6], phone: [39.1, 39.85] };
