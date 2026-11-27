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
  const eyeD = [circ(cx, cy, 2 * u), circ(cx + 8 * u, cy, 2 * u)];
  BADGE.outer.setAttribute('d', outerD);
  BADGE.inner.setAttribute('d', innerD);
  BADGE.eyes.forEach((e, i) => e.setAttribute('d', eyeD[i]));
  BADGE.fill.setAttribute('d', [outerD, innerD, ...eyeD].join(''));
  strokeSpan(BADGE.outer, s.outerTail || 0, s.outer);
  strokeSpan(BADGE.inner, 0, s.inner);
  BADGE.outer.style.opacity = BADGE.inner.style.opacity = (s.lineO ?? 1).toFixed(3);
  BADGE.eyes.forEach(e => { e.style.opacity = ((s.lineO ?? 1) * s.eyes).toFixed(3); });
  BADGE.fill.style.opacity = s.fill.toFixed(3);
  badgeG.setAttribute('transform', s.rot ? `rotate(${s.rot.toFixed(3)} ${cx.toFixed(1)} ${cy.toFixed(1)})` : '');
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

// 结尾：卡片卷进中心的同时勾出外圆 → 内圆与眼睛 → 填色并弹一下 → 移到字标月牙的位置，最后一击交给字标。
function badgeOutro(t) {
  if (t < END.ring - 0.1 || t >= END.hit) return null;
  const R = BADGE_R;
  const pop = 1 + 0.12 * Math.sin(Math.PI * seg(t, END.filled, END.filled + 0.32));
  const go = EASE.cam(seg(t, END.move, END.hit - 0.04));
  return {
    cx: lerp(960, WM_SYM[0], go), cy: lerp(540, WM_SYM[1], go), R: lerp(R * pop, WM_SYM[2], go),
    outer: EASE.out(seg(t, END.ring, END.ring + 0.45)),
    inner: EASE.out(seg(t, END.build, END.build + 0.4)), eyes: EASE.out(seg(t, END.build + 0.25, END.build + 0.45)),
    fill: EASE.std(seg(t, END.filled - 0.12, END.filled + 0.12)),
    lineO: 1 - EASE.std(seg(t, END.filled, END.filled + 0.3)),
    rot: (1 - EASE.out(seg(t, END.ring, END.build + 0.4))) * -160,
  };
}

// 每拍从徽章扩散出去的一圈涟漪（112、113 拍），给最后几拍一点“鼓点”。
function renderRipples(t) {
  const rings = BADGE.ripples;
  [END.filled, beat(113)].forEach((t0, i) => {
    const p = seg(t, t0, t0 + 0.75);
    const el = rings[i];
    if (p <= 0 || p >= 1) { el.style.opacity = '0'; return; }
    el.setAttribute('d', circ(960, 540, BADGE_R * lerp(1.05, 2.6, EASE.out(p))));
    el.style.opacity = (0.7 * (1 - p)).toFixed(3);
    strokeSpan(el, 0, 1);
  });
}

// 片尾字标：最后一击时字母依次弹出，月牙由徽章无缝接替。
function renderWordmark(t) {
  const glow = $('#glow');
  if (t < END.hit) { vis(wmEl, false); vis(glow, false); return; }
  put(wmEl, { x: WM_POS[0], y: WM_POS[1], s: WM_SC });
  wmEl.style.transformOrigin = '0 0';
  put(glow, { x: 0, y: -60, o: 0.75 * EASE.out(seg(t, END.hit, END.hit + 0.9)) });
  LETTERS.forEach((g, i) => {
    if (i === 0) { g.style.opacity = '1'; g.style.transform = ''; return; }
    const d = END.hit + (i - 1) * 0.035;
    const k = EASE.ios(seg(t, d, d + 0.6));
    g.style.opacity = Math.min(1, k * 1.6).toFixed(3);
    g.style.transform = `translate(${((1 - k) * -26).toFixed(2)}px, 0px)`;
    g.style.filter = 1 - k > 0.05 ? `blur(${((1 - k) * 8).toFixed(2)}px)` : '';
  });
}
