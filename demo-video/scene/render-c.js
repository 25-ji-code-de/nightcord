// 标题、手机、功能标签，以及总入口 render(t)。

function renderHeadlines(t) {
  for (const { h, box, chars, sub } of HLS) {
    const on = t >= h.t0 - 0.01 && t < h.t1 + 0.6;
    if (!on) { vis(box, false); continue; }
    vis(box, true);
    const out = EASE.cam(seg(t, h.t1, h.t1 + 0.5));
    box.style.opacity = (1 - out).toFixed(4);
    box.style.transform = `translate3d(0,${(-12 * out).toFixed(2)}px,0)`;
    box.style.filter = out > 0.04 ? `blur(${(out * 8).toFixed(2)}px)` : '';
    chars.forEach((c, i) => {
      const k = EASE.ios(seg(t, h.t0 + i * 0.035, h.t0 + i * 0.035 + 0.85));
      set(c, { o: Math.min(1, k * 2), y: (1 - k) * 26, b: (1 - k) * 8 });
    });
    if (sub) {
      const k = EASE.out(seg(t, h.t0 + 0.4 + chars.length * 0.012, h.t0 + 1.3 + chars.length * 0.012));
      set(sub, { o: k, y: (1 - k) * 14, b: (1 - k) * 5 });
    }
  }
}

function renderPhones(t) {
  const out = EASE.cam(seg(t, PHONES_T[1] - 0.2, PHONES_T[1] + 0.5));
  const bob = Math.sin(t * 0.9);
  PH.forEach((el, i) => {
    const d = PHONES_T[0] + i * 0.18;
    const k = EASE.ios(seg(t, d, d + 1.2));
    put(el, {
      x: 1000 + i * 420 + (1 - k) * 120 + out * 40, y: 120 + i * 36 + (1 - k) * 70 + bob * (3 + i * 2) + out * -20,
      s: lerp(0.86, 1, k) * lerp(1, 0.96, out), o: k * (1 - out), b: (1 - k) * 8 + out * 8,
    });
  });
}

function renderChips(t) {
  const out = EASE.cam(seg(t, CHIPS_T[1] - 0.4, CHIPS_T[1]));
  const chips = $('#chips');
  if (t < CHIPS_T[0] || out >= 1) { vis(chips, false); return; }
  vis(chips, true);
  chips.style.opacity = (1 - out).toFixed(4);
  CHIP_EL.forEach((el, i) => {
    const k = EASE.ios(seg(t, CHIPS_T[0] + i * 0.08, CHIPS_T[0] + i * 0.08 + 0.7));
    set(el, { o: Math.min(1, k * 2), y: (1 - k) * 22, s: lerp(0.92, 1, k), b: (1 - k) * 6 });
  });
}

function render(t) {
  renderBg(t);
  const cam = camera(t);
  // 开场字标只在片头出现；片尾字标由 renderOutro 接管。
  if (t < OUTRO.wm - 0.01) renderWordmark(Winv(t));
  renderCard(Winv(t));
  renderWindow(t, cam);
  renderHeadlines(t);
  renderPhones(t);
  renderChips(t);
  renderLines(t);
  renderMontage(t);
  renderCursor(t, cam);
  if (t >= OUTRO.wm - 0.01) renderOutro(t);
  put($('#fade'), { o: EASE.cam(seg(t, FADE_OUT, DUR - 0.05)) });
  $('#fade').style.background = '#000';
  renderStage(t);
}
window.render = render;
