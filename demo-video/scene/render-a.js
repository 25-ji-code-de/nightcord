// 背景、徽章与字标。

const bgEl = $('#bg');
const BG_KEYS = [
  { t: 0, c: ['#3a2f66', '#1b1636', '#7b4f9e'] },
  { t: 8, c: ['#3a2f66', '#1b1636', '#7b4f9e'] },
  { t: 24, c: ['#2e3a78', '#18183a', '#5a4fb0'] },
  { t: 34, c: ['#4a2c6a', '#1d1233', '#a14f94'] },
  { t: 48, c: ['#3a2f66', '#1b1636', '#7b4f9e'] },
  { t: 59, c: ['#3a2f66', '#1b1636', '#7b4f9e'] },
];
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, x) => '#' + hex(a).map((v, i) => Math.round(lerp(v, hex(b)[i], x)).toString(16).padStart(2, '0')).join('');
function bgColors(t) {
  let i = 0;
  while (i < BG_KEYS.length - 2 && t >= BG_KEYS[i + 1].t) i++;
  const k = EASE.std(seg(t, BG_KEYS[i].t, BG_KEYS[i + 1].t));
  return BG_KEYS[i].c.map((c, n) => mix(c, BG_KEYS[i + 1].c[n], k));
}
function renderBg(t) {
  const [c1, c2, c3] = bgColors(t);
  const a = t * 0.22;
  const p1 = [960 + Math.cos(a) * 520, 340 + Math.sin(a * 0.9) * 220];
  const p2 = [420 + Math.sin(a * 0.8 + 1) * 380, 860 + Math.cos(a * 0.7) * 160];
  const p3 = [1540 + Math.cos(a * 0.6 + 2) * 300, 820 + Math.sin(a * 0.8 + 3) * 200];
  bgEl.style.background = [
    `radial-gradient(900px 700px at ${p1[0].toFixed(0)}px ${p1[1].toFixed(0)}px, ${c1}cc, transparent 70%)`,
    `radial-gradient(1000px 760px at ${p2[0].toFixed(0)}px ${p2[1].toFixed(0)}px, ${c3}66, transparent 72%)`,
    `radial-gradient(800px 600px at ${p3[0].toFixed(0)}px ${p3[1].toFixed(0)}px, ${c2}ff, transparent 75%)`,
    '#0b0912',
  ].join(',');
}

// 用 pathLength=1 的虚线只画出 [tail, head] 这一段，实现“书写”与“收笔”。
function strokeSpan(el, tail, head) {
  el.style.strokeDasharray = `${Math.max(0, head - tail).toFixed(4)} 2`;
  el.style.strokeDashoffset = (-tail).toFixed(4);
}

// 徽章几何（与字标里的月牙同构）：外圆半径 R，内圆半径 12/16·R、圆心右移 4/16·R，两只眼半径 2/16·R。
// o 为外轮廓：{ x, y, w, h, r } 的圆角矩形，等于 circ 时就是圆。
// s：{ cx, cy, R, outer, inner, eyes, fill, rot, lineO }，各项为 0–1 的进度。
function renderBadge(s) {
  if (!s) { vis(badgeSvg, false); return; }
  vis(badgeSvg, true);
  const { cx, cy, R } = s, u = R / 16;
  const o = s.box || { x: cx - R, y: cy - R, w: 2 * R, h: 2 * R, r: R };
  const outerD = rrect(o.x, o.y, o.w, o.h, o.r);
  const innerD = circ(cx + 4 * u, cy, 12 * u);
  const eyeD = s.eyeBoxes ? s.eyeBoxes.map(e => rrect(e.x, e.y, e.w, e.h, e.r)) : [circ(cx, cy, 2 * u), circ(cx + 8 * u, cy, 2 * u)];
  BADGE.outer.setAttribute('d', outerD);
  BADGE.inner.setAttribute('d', innerD);
  BADGE.eyes.forEach((e, i) => e.setAttribute('d', eyeD[i]));
  BADGE.fill.setAttribute('d', [outerD, innerD, ...eyeD].join(''));
  strokeSpan(BADGE.outer, s.outerTail || 0, s.outer);
  strokeSpan(BADGE.inner, 0, s.inner);
  BADGE.outer.style.opacity = BADGE.inner.style.opacity = (s.lineO ?? 1).toFixed(3);
  BADGE.eyes.forEach(e => { e.style.opacity = ((s.lineO ?? 1) * s.eyes).toFixed(3); });
  BADGE.fill.style.opacity = s.fill.toFixed(3);
  // 旋转与斜切都围绕 (px, py)（默认徽章中心）；斜切模拟参考片里线框“带透视翻过来”的感觉。
  const px = s.pivot ? s.pivot[0] : cx, py = s.pivot ? s.pivot[1] : cy;
  badgeG.setAttribute('transform', s.rot || s.skew
    ? `translate(${px.toFixed(1)} ${py.toFixed(1)}) rotate(${(s.rot || 0).toFixed(3)}) skewY(${(s.skew || 0).toFixed(3)}) translate(${(-px).toFixed(1)} ${(-py).toFixed(1)})`
    : '');
  badgeSvg.style.opacity = (s.o ?? 1).toFixed(3);
}

// 开场：线条绕出徽章 → 填色 → 缩小落到登录卡片的标志上（卡片随之出现）。
function badgeIntro(t) {
  if (t > CARD.in + 0.55) return null;
  const draw = EASE.std(seg(t, 0.25, 1.9));
  const shrink = EASE.cam(seg(t, 3.25, CARD.in + 0.25));
  return {
    cx: lerp(960, CARD.logo[0], shrink), cy: lerp(540, CARD.logo[1], shrink), R: lerp(BADGE_R, CARD.logoR, shrink),
    outer: draw, inner: EASE.std(seg(t, 0.75, 2.05)), eyes: EASE.out(seg(t, 1.75, 2.15)),
    fill: EASE.std(seg(t, 2.05, 2.7)), lineO: 1 - EASE.std(seg(t, 2.3, 2.9)),
    rot: (1 - EASE.out(seg(t, 0.25, 2.1))) * -140,
    o: 1 - EASE.std(seg(t, CARD.in + 0.25, CARD.in + 0.55)),
  };
}

// 结尾的手机姿态：先往一侧带透视倾斜，变形过程中回正。手机 DOM 与线框共用这组值，交接处严丝合缝。
function endPose(t) {
  const lean = EASE.cam(seg(t, END.tilt, END.wash[1]));
  const settle = EASE.cam(seg(t, END.morph[0] + 0.3, END.morph[1] + 0.3));
  return { rot: lerp(0, 9, lean) * (1 - settle) + 7 * Math.sin(Math.PI * settle) * (1 - settle), skew: lerp(0, -6, lean) * (1 - settle) };
}

const rbox = (b, k, c) => ({ x: lerp(b.x, c.x, k), y: lerp(b.y, c.y, k), w: lerp(b.w, c.w, k), h: lerp(b.h, c.h, k), r: lerp(b.r, c.r, k) });
const cbox = (x, y, r) => ({ x: x - r, y: y - r, w: 2 * r, h: 2 * r, r });

// 结尾（照参考片）：手机褪成线框 → 机身变形成外圆、灵动岛与底部横条变成两只眼睛、勾出内圆
// → 线条徽章停一下 → 缩小并移到字标月牙的位置 → 最后一击时交给实心字标。全程只有线条。
function badgeOutro(t) {
  if (t < END.wash[0] || t >= END.hit + 0.4) return null;
  const R = BADGE_R, u = R / 16;
  const m = EASE.cam(seg(t, END.morph[0], END.morph[1]));
  const go = EASE.cam(seg(t, END.move[0], END.move[1]));
  // 停留时轻轻“呼吸”一下，避免完全静止
  const breathe = 1 + 0.018 * Math.sin(Math.PI * seg(t, END.morph[1], END.move[0]));
  const sc = lerp(1, WM_SYM[2] / R, go) * breathe;
  const cx = lerp(960, WM_SYM[0], go), cy = lerp(540, WM_SYM[1], go);
  // 在“未缩放的居中徽章”坐标里算形状，再整体缩放平移到 (cx, cy)
  const tr = b => ({ x: cx + (b.x - 960) * sc, y: cy + (b.y - 540) * sc, w: b.w * sc, h: b.h * sc, r: b.r * sc });
  const box = tr(rbox(PH_BOX, m, cbox(960, 540, R)));
  const eyeBoxes = [rbox(PH_ISL, m, cbox(960, 540, 2 * u)), rbox(PH_BAR, m, cbox(960 + 8 * u, 540, 2 * u))].map(tr);
  const pose = endPose(t);
  const line = EASE.std(seg(t, END.wash[0] + 0.15, END.wash[1]));
  const out = EASE.std(seg(t, END.hit, END.hit + 0.35));
  return {
    cx, cy, R: R * sc, box, eyeBoxes, pivot: [cx, cy],
    outer: 1, inner: EASE.std(seg(t, END.inner[0], END.inner[1])), eyes: 1,
    fill: 0, lineO: line * (1 - out), rot: pose.rot, skew: pose.skew,
  };
}

// 片尾字标：最后一击时字母依次弹出，月牙由徽章无缝接替。
// 片尾字标（照参考片）：最后一击时整条字标一起淡入，月牙从线条徽章原位填实，不做逐字飞入。
function renderWordmark(t) {
  const glow = $('#glow');
  if (t < END.hit - 0.05) { vis(wmEl, false); vis(glow, false); return; }
  const k = EASE.std(seg(t, END.hit - 0.05, END.hit + 0.45));
  put(wmEl, { x: WM_POS[0], y: WM_POS[1], s: WM_SC, o: k });
  wmEl.style.transformOrigin = '0 0';
  put(glow, { x: 0, y: -60, o: 0.45 * EASE.out(seg(t, END.hit, END.hit + 1.2)) });
  LETTERS.forEach(g => { g.style.opacity = '1'; g.style.transform = ''; g.style.filter = ''; });
}
