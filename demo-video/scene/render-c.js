// 线条转场、节拍特写、手机，以及总入口 render(t)。

function wavePath(phase, amp, y0, k, flat) {
  let d = '';
  for (let x = -40; x <= 1960; x += 20) {
    const env = Math.sin(Math.PI * clamp((x + 40) / 2000));
    const y = y0 + Math.sin(x / 1920 * Math.PI * 2 * k + phase) * amp * env * (1 - flat);
    d += (x === -40 ? 'M' : 'L') + x + ' ' + y.toFixed(1);
  }
  return d;
}

// 间奏：三条波浪线划过 → 拉平成一条 → 折成画框 → 画框撑满全屏，第二次高潮从框里切入特写。
function renderLines(t) {
  const pIn = PHONE.outline, pOut = PHONE.in + 0.9;
  const inBreak = t >= LINES.wave[0] && t < LINES.open[1];
  const inPhone = t >= pIn[0] && t < pOut;
  if (!inBreak && !inPhone) { vis(linesSvg, false); return; }
  vis(linesSvg, true);
  const [w0, w1] = LINES.wave;
  const flat = EASE.cam(seg(t, w1 - 0.9, w1));
  ['w0', 'w1', 'w2'].forEach((id, i) => {
    const el = LINE_EL[id];
    if (!inBreak) { el.style.opacity = '0'; return; }
    const a = w0 + i * 0.14;
    el.setAttribute('d', wavePath(t * 2.2 + i * 1.3, 50 - i * 12, 540 + (i - 1) * 22 * (1 - flat), 1.4 + i * 0.3, flat));
    strokeSpan(el, 0, EASE.std(seg(t, a, a + 1.1)));
    // 拉平后三条线并成一条，画框从中间接手
    el.style.opacity = ((0.9 - i * 0.2) * (1 - EASE.std(seg(t, LINES.frame[0] + 0.2, LINES.frame[0] + 0.6)))).toFixed(3);
  });
  // 画框：从一条横线展开成 16:9 的框，停住，然后放大到盖满画面。
  const fr = LINE_EL.frame;
  if (inBreak && t >= LINES.frame[0]) {
    const h = EASE.ios(seg(t, LINES.frame[0], LINES.frame[1]));
    const open = EASE.cam(seg(t, LINES.open[0], LINES.open[1]));
    const breathe = 1 + 0.02 * Math.sin((t - LINES.frame[1]) * 2.4) * (1 - open);
    const w = lerp(lerp(1500, 760, h), 1960, open) * breathe, hh = lerp(lerp(2, 428, h), 1120, open) * breathe;
    fr.setAttribute('d', rrect(960 - w / 2, 540 - hh / 2, w, hh, lerp(1, 22, h)));
    strokeSpan(fr, 0, 1);
    fr.style.opacity = (1 - EASE.std(seg(t, LINES.open[1] - 0.2, LINES.open[1]))).toFixed(3);
  } else fr.style.opacity = '0';
  // 手机轮廓：第二次高潮的特写结束后先勾出两部手机，手机再落进去。
  ['p0', 'p1'].forEach((id, i) => {
    const el = LINE_EL[id];
    if (!inPhone) { el.style.opacity = '0'; return; }
    strokeSpan(el, 0, EASE.out(seg(t, pIn[0] + i * 0.1, pIn[1] + i * 0.1)));
    el.style.opacity = (1 - EASE.std(seg(t, PHONE.in + 0.3 + i * 0.12, pOut))).toFixed(3);
  });
}

// 局部特写：踩着拍子硬切，每个镜头内只做缓慢横移，不缩放。
function renderMontage(t) {
  const mont = $('#mont');
  if (t < MONT_T0 || t >= MONT_END) { vis(mont, false); return; }
  vis(mont, true);
  const idx = Math.min(MONTAGE.length - 1, Math.floor((t - MONT_T0) / MONT_STEP));
  MONT_EL.forEach(({ m, box }, i) => {
    if (i !== idx) { vis(box, false); return; }
    vis(box, true);
    const p = (t - MONT_T0 - i * MONT_STEP) / MONT_STEP;
    const s = 1920 / m.w;
    const x = clamp(960 - m.cx * s + m.dx * (p - 0.5) * 2, 1920 - WIN_W * s, 0);
    const y = clamp(540 - m.cy * s, 1080 - WIN_H * s, 0);
    box.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0) scale(${s.toFixed(5)})`;
    // 每次切镜头的头几帧略亮，像闪光灯一样强调拍点
    box.style.filter = p < 0.12 ? `brightness(${(1 + 0.25 * (1 - p / 0.12)).toFixed(3)})` : '';
  });
}

// 手机：落进轮廓 → 第 104 拍两部合成一部（居中）→ 第 109 拍屏幕熄灭，交给徽章的线框接着变形。
function renderPhones(t) {
  const merge = EASE.cam(seg(t, PHONE.merge, PHONE.merge + 1.0));
  const dark = EASE.std(seg(t, END.morph - 0.1, END.morph + 0.3));
  const bob = Math.sin(t * 0.9);
  PH.forEach((el, i) => {
    const d = PHONE.in + i * 0.12;
    const k = EASE.ios(seg(t, d, d + 0.9));
    const x = lerp(PHONE.x[i], 960 - PHONE.w / 2, merge);
    const away = i === 1 ? merge : 0;
    const o = k * (1 - dark) * (1 - away);
    put(el, {
      x, y: PHONE.y + (1 - k) * 40 + bob * (3 + i * 2) * (1 - merge),
      s: lerp(0.94, 1, k) * (1 - 0.06 * away), o, b: (1 - k) * 6,
    });
  });
}

// 舞台级运镜：高潮落拍时整体轻推一下，平时有极轻的漂移，避免画面完全静止。
const PUNCH = [[beat(48), 0.025], [beat(80), 0.03], [beat(96), 0.015], [END.hit, 0.02]];
function renderStage(t) {
  let punch = 0;
  for (const [t0, a] of PUNCH) if (t >= t0) punch += a * Math.exp(-(t - t0) / 0.22);
  const s = 1.008 + punch;
  const dx = Math.sin(t * 0.37) * 3.2, dy = Math.cos(t * 0.29) * 2.4;
  const st = $('#stage');
  st.style.transformOrigin = '50% 50%';
  st.style.transform = `translate3d(${dx.toFixed(2)}px,${dy.toFixed(2)}px,0) scale(${s.toFixed(5)})`;
}

function render(t) {
  renderBg(t);
  const cam = camera(t);
  renderCard(t);
  renderWindow(t, cam);
  renderPhones(t);
  renderLines(t);
  renderMontage(t);
  renderBadge(badgeIntro(t) || badgeOutro(t));
  renderWordmark(t);
  renderCursor(t, cam);
  put($('#fade'), { o: EASE.cam(seg(t, END.fade, DUR)) });
  renderStage(t);
}
window.render = render;
