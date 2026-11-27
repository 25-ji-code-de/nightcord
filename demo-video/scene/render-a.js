// 背景与字标：缓慢漂移的“夜幕”色块，随段落切换色调。
const bgEl = $('#bg');
const BG_KEYS = [
  { t: 0, c: ['#3a2f66', '#1b1636', '#7b4f9e'] },
  { t: W(12), c: ['#3a2f66', '#1b1636', '#7b4f9e'] },
  { t: W(34), c: ['#2e3a78', '#18183a', '#5a4fb0'] },
  { t: W(38), c: ['#4a2c6a', '#1d1233', '#a14f94'] },
  { t: W(45), c: ['#3a2f66', '#1b1636', '#7b4f9e'] },
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

// 字标入场：月牙先浮现，字母依次从下方以模糊淡入。
function renderWordmark(t) {
  const glow = $('#glow');
  const t0 = 0.5;
  const sym = EASE.ios(seg(t, t0, t0 + 1.4));
  // 开场：居中大字标 → 左上位置交给标题（第 5.2 秒起淡出缩小）
  const out = EASE.cam(seg(t, 4.0, 4.8));
  const sc = lerp(1.0, 0.82, out);
  const o = (1 - out) * 1;
  const cx = 960, cy = 450;
  const on = put(wmEl, { x: cx - 542 * sc, y: cy - 108 * sc - 30 * out, s: sc, o: Math.min(1, Math.max(sym * 3, seg(t, 0.25, 0.4))) * o });
  const symFill = strokeSymbol(t - 0.25, 1.35);
  wmEl.style.transformOrigin = '0 0';
  put(glow, { x: 0, y: 0, o: on ? 0.9 * sym * (1 - out) : 0 });
  LETTERS.forEach((g, i) => {
    const d = i === 0 ? 0 : 0.55 + (i - 1) * 0.09;
    const k = i === 0 ? sym : EASE.ios(seg(t, t0 + d, t0 + d + 0.95));
    g.style.opacity = i === 0 ? '1' : k.toFixed(3);
    if (i === 0) g.firstChild.style.opacity = symFill.toFixed(3);
    g.style.transform = i === 0 ? `scale(${lerp(0.84, 1, k).toFixed(4)})` : `translate(0px, ${(1 - k) * 34}px)`;
    g.style.transformOrigin = i === 0 ? '107px 90px' : '0 0';
    g.style.filter = i === 0 ? '' : (1 - k) > 0.05 ? `blur(${((1 - k) * 10).toFixed(2)}px)` : '';
  });
  const tag = $('#tag');
  const tk = EASE.out(seg(t, 2.6, 3.6)), to = 1 - EASE.cam(seg(t, 3.8, 4.5));
  put(tag, { y: (1 - tk) * 16, o: tk * to });
}

function renderOutro(t) {
  const wmK = EASE.ios(seg(t, OUTRO.wm, OUTRO.wm + 1.3));
  const sc = 0.9;
  if (t >= OUTRO.wm) {
    put(wmEl, { x: 960 - 542 * sc, y: 340 - 108 * sc + (1 - wmK) * 28, s: sc, o: Math.max(wmK, seg(t, OUTRO.wm - 0.15, OUTRO.wm)) });
    wmEl.style.transformOrigin = '0 0';
    put($('#glow'), { x: 0, y: -90, o: wmK * 0.85 });
    const symFill = strokeSymbol(t - OUTRO.wm + 0.15, 1.1);
    LETTERS.forEach((g, i) => {
      const d = i === 0 ? 0 : 0.35 + (i - 1) * 0.07;
      const k = i === 0 ? wmK : EASE.ios(seg(t, OUTRO.wm + d, OUTRO.wm + d + 0.8));
      g.style.opacity = i === 0 ? '1' : k.toFixed(3);
      if (i === 0) g.firstChild.style.opacity = symFill.toFixed(3);
      g.style.transform = i === 0 ? `scale(${lerp(0.84, 1, k).toFixed(4)})` : `translate(0px, ${(1 - k) * 30}px)`;
      g.style.filter = i === 0 || 1 - k < 0.05 ? '' : `blur(${((1 - k) * 9).toFixed(2)}px)`;
    });
    const tag = $('#tag'), urls = $('#urls');
    const tk = EASE.out(seg(t, OUTRO.tag, OUTRO.tag + 0.9));
    tag.style.top = '520px';
    put(tag, { y: (1 - tk) * 16, o: tk });
    const uk = EASE.out(seg(t, OUTRO.urls, OUTRO.urls + 0.9));
    put(urls, { y: (1 - uk) * 16, o: uk });
  }
}
