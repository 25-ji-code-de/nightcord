// 线条动画、节拍特写与整体运镜（舞台级的打点与轻微漂移）。

// 用 pathLength=1 的虚线画出 [tail, head] 这一段，实现“书写”与“收笔”。
function strokeSpan(el, tail, head) {
  const len = Math.max(0, head - tail);
  el.style.strokeDasharray = `${len.toFixed(4)} 2`;
  el.style.strokeDashoffset = (-tail).toFixed(4);
}

function wavePath(phase, amp, y0, k) {
  let d = '';
  for (let x = -40; x <= 1960; x += 20) {
    const y = y0 + Math.sin(x / 1920 * Math.PI * 2 * k + phase) * amp * Math.sin(Math.PI * clamp((x + 40) / 2000));
    d += (x === -40 ? 'M' : 'L') + x + ' ' + y.toFixed(1);
  }
  return d;
}

// 间奏：窗口退场后，三条波浪线从左往右划过画面，随后勾出两部手机的轮廓，手机再落进轮廓里。
function renderLines(t) {
  const [w0, w1] = LINES_T.wave, [p0, p1] = LINES_T.phone;
  const phonesIn = PHONES_T[0] + 1.0;
  if (t < w0 || t > phonesIn + 0.4) { vis(linesSvg, false); return; }
  vis(linesSvg, true);
  ['w0', 'w1', 'w2'].forEach((id, i) => {
    const el = LINE_EL[id];
    const a = w0 + i * 0.12;
    const head = EASE.std(seg(t, a, a + 1.05));
    const tail = EASE.std(seg(t, a + 0.55, w1));
    el.setAttribute('d', wavePath(t * 2.4 + i * 1.3, 46 - i * 10, 560 + i * 18, 1.5 + i * 0.25));
    el.style.opacity = (0.9 - i * 0.22).toFixed(3);
    strokeSpan(el, tail, head);
  });
  ['p0', 'p1'].forEach((id, i) => {
    const el = LINE_EL[id];
    const a = p0 + i * 0.12;
    strokeSpan(el, 0, EASE.out(seg(t, a, p1 + i * 0.12)));
    // 手机落定时，轮廓线淡出
    el.style.opacity = (1 - EASE.std(seg(t, phonesIn - 0.5 + i * 0.18, phonesIn + 0.2 + i * 0.18))).toFixed(3);
  });
}

// 月牙符号的描边：t 为本段开始后的秒数，返回填充透明度。
function strokeSymbol(t, drawDur) {
  const draw = EASE.std(seg(t, 0, drawDur));
  const fill = EASE.std(seg(t, drawDur * 0.75, drawDur + 0.5));
  wmStroke.style.strokeDashoffset = (1 - draw).toFixed(4);
  wmStroke.style.opacity = (t > 0 ? 1 - fill * 0.85 : 0).toFixed(3);
  return fill;
}

// 第二次高潮：四个局部特写踩着拍子硬切，每个镜头内缓慢推近并横移。
function renderMontage(t) {
  const mont = $('#mont');
  if (t < MONT_T0 || t >= MONT_END) { vis(mont, false); return; }
  vis(mont, true);
  mont.style.opacity = (1 - EASE.std(seg(t, MONT_END - 0.22, MONT_END))).toFixed(4);
  const idx = Math.min(MONTAGE.length - 1, Math.floor((t - MONT_T0) / MONT_STEP));
  MONT_EL.forEach(({ m, box }, i) => {
    if (i !== idx) { vis(box, false); return; }
    vis(box, true);
    const p = (t - MONT_T0 - i * MONT_STEP) / MONT_STEP;
    const hit = EASE.out(seg(p, 0, 0.3));
    const s = 1920 / m.w * (1.07 - 0.07 * hit) * (1 + 0.035 * p);
    const x = clamp(960 - m.cx * s + m.dx * (p - 0.5) * 2, 1920 - WIN_W * s, 0);
    const y = clamp(540 - m.cy * s, 1080 - WIN_H * s, 0);
    box.style.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0) scale(${s.toFixed(5)})`;
    box.style.opacity = Math.min(1, 0.35 + hit * 1.3).toFixed(3);
  });
}

// 舞台级运镜：高潮落拍时整体轻推一下，平时有极轻的漂移，避免画面完全静止。
function renderStage(t) {
  let punch = 0;
  for (const [t0, a] of PUNCH) if (t >= t0) punch += a * Math.exp(-(t - t0) / 0.22);
  const s = 1.008 + punch;
  const dx = Math.sin(t * 0.37) * 3.2, dy = Math.cos(t * 0.29) * 2.4;
  const st = $('#stage');
  st.style.transformOrigin = '50% 50%';
  st.style.transform = `translate3d(${dx.toFixed(2)}px,${dy.toFixed(2)}px,0) scale(${s.toFixed(5)})`;
}
