// 分镜与时间轴（秒）。画面不放任何说明文字，只靠真实界面、光标和线条讲故事。
const FPS = 60;
const DUR = 59.35;   // 与配乐等长：音乐在 57.8 秒收住，之后是字标的留白

// 配乐（demo-video/reference.mp4 的音轨）约 121 BPM，第一拍在 0.24 秒。
// 段落（拍号）：前奏 0–16，主歌 16–48，第一次高潮 48–62，间奏 62–80，第二次高潮 80–116。
// 结尾过门：第 109–115 拍每拍一击，第 115 拍是最后一击，第 116 拍起静音。
const BEAT = 0.4958, BEAT0 = 0.24;
const beat = k => BEAT0 + BEAT * k;

// 窗口（1440x900 的真实前端截图，2x 采样）
const WIN_W = 1440, WIN_H = 900;
const S_BASE = 0.86;
// 镜头缩放：平时是能看全整个界面的全景；只在看细节时推近，推近期间镜头跟随光标，看完就拉回全景。
// [推近开始, 推近完成, 拉远开始, 拉远完成, 倍率]
const ZOOM_SPANS = [
  [10.9, 11.45, 13.75, 14.3, 1.75],   // 输入框逐字打字
  [15.0, 15.55, 16.45, 16.95, 1.8],   // 站内提醒卡片
  [20.85, 21.4, 22.75, 23.3, 1.7],    // 搜索结果
  [29.1, 29.7, 31.0, 31.6, 1.6],      // 语音面板
];
const ZOOM = [{ t: 0, v: [S_BASE] }];
for (const [a, b, c, d, s] of ZOOM_SPANS) ZOOM.push({ t: a, v: [S_BASE] }, { t: b, v: [s] }, { t: c, v: [s] }, { t: d, v: [S_BASE] });
const FOLLOW_LAG = 0.75;   // 镜头跟随光标的平滑窗口（秒）

// 窗口里依次出现的真实界面（后者盖在前者之上）。t 为开始淡入时间，d 为淡入时长。
const STATES = [
  { src: 'chat', t: beat(16), d: 0.4 },
  { src: 'chat-sent', t: beat(27), d: 0.2 },
  { src: 'notify-clean', t: beat(29), d: 0.3 },
  { src: 'inbox-clean', t: beat(34), d: 0.12 },
  { src: 'search-0', t: beat(40), d: 0.12 },
  { src: 'search-1', t: beat(41), d: 0.06 },
  { src: 'search-2', t: beat(42), d: 0.06 },
  { src: 'settings', t: beat(48), d: 0.2 },
  { src: 'settings-indigo', t: beat(50), d: 0.3 },
  { src: 'settings-plum', t: beat(52), d: 0.3 },
  { src: 'settings', t: beat(54), d: 0.3 },
  { src: 'chat', t: beat(55), d: 0.2 },
  { src: 'voice-roster', t: beat(56), d: 0.3 },
  { src: 'voice-panel', t: beat(57.5), d: 0.3 },
];

const WIN_IN = beat(16), WIN_OUT = [33.6, 34.4];
const TYPE_START = 11.45, TYPE_STEP = 0.2, TYPE_N = 10, TYPE_END = beat(27);
const STRIP = { x: 340, y: 810, w: 1100, h: 90 };       // 窗口坐标系里的输入框条带
const TOAST = { in: beat(29), out: 17.15 };             // 站内提醒卡片

// 登录卡片：居中，卡片顶部的月牙标志在舞台 (960, 286)，开场的徽章会变形落到这里。
const CARD = { x: 650, y: 187, logo: [960, 286], logoR: 36.6, in: 4.0, out: 7.3 };

// 光标。[t, x, y]：stage 为舞台坐标，win 为窗口坐标（1440x900）。
const CUR_STAGE = [[5.0, 1300, 760], [5.6, 960, 508], [6.3, 960, 512], [6.95, 960, 648]];
const CUR_WIN = [
  [8.6, 900, 560], [9.4, 900, 560], [10.6, 700, 300], [11.05, 880, 853], [13.8, 880, 853],
  [14.7, 820, 760], [15.5, 1240, 150], [16.5, 1240, 150],                        // 提醒卡片
  [17.02, 28, 274], [17.3, 28, 274], [18.0, 480, 240], [19.2, 520, 345],         // 收件箱
  [19.98, 28, 124], [20.25, 28, 124], [20.5, 700, 92], [21.3, 520, 235], [22.4, 560, 310], // 搜索
  [23.85, 28, 474], [24.1, 28, 474], [24.85, 814, 456], [25.15, 814, 456],       // 设置与配色
  [25.85, 1025, 456], [26.15, 1025, 456], [26.85, 598, 456], [27.1, 598, 456],
  [27.42, 1126, 132], [27.6, 1126, 132], [27.93, 1392, 24], [28.1, 1392, 24],    // 关闭设置 → 打开语音
  [28.55, 1318, 24], [28.85, 1318, 24], [29.6, 1236, 330], [30.7, 1250, 380], [31.3, 1256, 533],
];
const CLICKS = [5.7, beat(14), beat(22), beat(34), beat(40), beat(48), beat(50), beat(52), beat(54), beat(55), beat(56), beat(57.5)];
const CUR_STAGE_VIS = [[5.0, 7.6]];
const CUR_WIN_VIS = [[9.0, 31.3]];

// 间奏的线条：波浪线横穿画面 → 收成一个画框 → 画框撑满全屏，第二次高潮从里面切进特写。
const LINES = { wave: [34.3, 36.8], frame: [36.4, 37.9], open: [39.3, beat(80)] };

// 第二次高潮前半：局部特写，每张 2 拍硬切，镜头内只做横移。cx/cy 为窗口坐标里的画面中心，w 为裁切宽度。
const MONT_T0 = beat(80), MONT_STEP = BEAT * 2;
const MONTAGE = [
  { src: 'chat-indigo', cx: 640, cy: 300, w: 960, dx: -40 },
  { src: 'autocomplete', cx: 560, cy: 690, w: 900, dx: 40 },
  { src: 'notify-clean', toast: true, cx: 1080, cy: 200, w: 900, dx: -30 },
  { src: 'search-2', cx: 640, cy: 200, w: 1000, dx: 30 },
  { src: 'voice-panel', cx: 1183, cy: 325, w: 1100, dx: -30 },
  { src: 'tasks', cx: 850, cy: 250, w: 1200, dx: 30 },
  { src: 'inbox-clean', cx: 800, cy: 300, w: 1100, dx: -30 },
  { src: 'chat-plum', cx: 900, cy: 600, w: 1000, dx: 30 },
];
const MONT_END = MONT_T0 + MONTAGE.length * MONT_STEP;   // = beat(96)

// 第二次高潮后半：两部手机（第 96 拍先勾轮廓再落定，第 99 拍互相转向，第 101.5 拍一上一下飞出画面）。
const PHONE = { w: 392, h: 820, r: 64, y: 130, x: [554, 974], outline: [MONT_END, MONT_END + 0.6], in: MONT_END + 0.3, turn: beat(99), out: beat(101.5) };

// 卡片墙：六个界面缩略图每半拍落一张（101.5–104 拍）；105–108 拍每拍点亮一张；第 109 拍起依次卷向中心。
const TILE_W = 480, TILE_H = 300, TILE_GAP = 40;
const TILES = ['chat', 'inbox-clean', 'search-2', 'voice-panel', 'settings-indigo', 'tasks'];
const TILE_T = { in: beat(101.5), step: BEAT / 2, pop: [beat(105), beat(106), beat(107), beat(108)], popIdx: [0, 4, 2, 3] };

// 结尾过门（参考音乐第 109–115 拍每拍一击）：
// 109 拍卡片卷向中心 → 110 拍勾出圆 → 111 拍内圆与眼睛 → 112 拍填色并弹一下
// → 113.5 拍移到字标月牙的位置 → 115 拍（最后一击）字标亮出。徽章只在最后约 2 秒出现。
const END = { gather: beat(109), ring: beat(110), build: beat(111), filled: beat(112), move: beat(113.5), hit: beat(115), fade: DUR - 0.35 };
const BADGE_R = 150;
const WM_SC = 0.9;
const WM_POS = [960 - 542 * WM_SC, 540 - 108 * WM_SC];
// 字标里的月牙：符号外圆圆心 (25, 24)、半径 16，经 wordmark.js 的变换与外层 translate(0 4)。
const WM_SYM = [WM_POS[0] + (25 * 4.6875 - 10.1875) * WM_SC, WM_POS[1] + (24 * 4.6875 - 26.5 + 4) * WM_SC, 16 * 4.6875 * WM_SC];
