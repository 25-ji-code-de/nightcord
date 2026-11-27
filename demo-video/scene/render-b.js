// 窗口、跟随光标的镜头、光标、登录卡片、打字与提醒卡片。

function fadeImg(el, o) {
  if (o <= 0.002) { if (el._on !== false) { el.style.display = 'none'; el._on = false; } return; }
  if (el._on !== true) { el.style.display = 'block'; el._on = true; }
  el.style.opacity = o >= 0.999 ? '' : o.toFixed(4);
}

function cursorPos(t, list) {
  if (t <= list[0][0]) return [list[0][1], list[0][2]];
  const last = list[list.length - 1];
  if (t >= last[0]) return [last[1], last[2]];
  let i = 0;
  while (t >= list[i + 1][0]) i++;
  const k = EASE.cam(seg(t, list[i][0], list[i + 1][0]));
  return [lerp(list[i][1], list[i + 1][1], k), lerp(list[i][2], list[i + 1][2], k)];
}

// 平滑过渡曲线：起止处速度和加速度都为 0，推拉不会有“顿一下”的感觉。
const smoother = x => { x = clamp(x); return x * x * x * (x * (x * 6 - 15) + 10); };
// 软夹紧：在边界附近用平滑曲线代替硬折角，镜头跟随贴边时不会突然停住。
function softClamp(v, lo, hi, k = 60) {
  const sp = u => (u > 20 ? u : Math.log1p(Math.exp(u)));
  return lo + k * sp((v - lo) / k) - k * sp((v - hi) / k);
}

// 推近程度 z ∈ [0, 1] 与这一段的目标倍率。
function zoomAt(t) {
  for (const [a, b, c, d, s] of ZOOM_SPANS) {
    if (t >= a && t <= d) return { z: t < b ? smoother(seg(t, a, b)) : t > c ? 1 - smoother(seg(t, c, d)) : 1, s, hold: c };
  }
  return { z: 0, s: S_BASE };
}

// 光标的平滑轨迹：1.2 秒的三角窗加权平均，并略微提前（镜头像摄影师一样预判光标去向）。
function followPoint(t) {
  let ax = 0, ay = 0, n = 0;
  for (let k = -24; k <= 24; k++) {
    const w = 1 - Math.abs(k) / 25;
    const [x, y] = cursorPos(t + 0.2 + k * FOLLOW_WIN / 48, CUR_WIN);
    ax += x * w; ay += y * w; n += w;
  }
  return [ax / n, ay / n];
}

// 镜头：画面中心对准窗口里的点 f，缩放 s。
// 全景时 f 是窗口中心（画面略偏下）；推近时 f 渐变到平滑后的光标位置，倍率在对数空间插值，
// 这样推拉的“感知速度”是均匀的。f 预先软夹紧到目标倍率下窗口能盖满画面的范围，过程中无需硬夹紧。
const CAM_CACHE = new Map();
function camera(t) {
  const key = t.toFixed(4);
  if (CAM_CACHE.has(key)) return CAM_CACHE.get(key);
  const { z, s: sMax, hold } = zoomAt(t);
  const s = Math.exp(lerp(Math.log(S_BASE), Math.log(sMax), z));
  let fx = WIN_W / 2, fy = WIN_H / 2;
  if (z > 0) {
    // 拉远时不再追光标（光标此刻往往正快速移向下一个按钮），只平稳地退回全景。
    // 跟随时间在 hold 之后指数减速（起点导数为 1），速度连续，不会突然刹车。
    const tf = t <= hold ? t : hold + 0.3 * (1 - Math.exp(-(t - hold) / 0.3));
    const [cx, cy] = followPoint(tf);
    const hx = 960 / sMax, hy = 540 / sMax;
    fx = lerp(fx, softClamp(cx, hx, WIN_W - hx), z);
    fy = lerp(fy, softClamp(cy, hy, WIN_H - hy), z);
  }
  const cy = 540 + 50 * (1 - z);
  const cam = { x: 960 - fx * s, y: cy - fy * s, s };
  if (CAM_CACHE.size > 4000) CAM_CACHE.clear();
  CAM_CACHE.set(key, cam);
  return cam;
}

// 窗口入场/退场：围绕中心缩放，轻微上浮，伴随淡入。
function renderWindow(t, cam) {
  const e = EASE.ios(seg(t, WIN_IN, WIN_IN + 1.1));
  const x = 1 - EASE.cam(seg(t, WIN_OUT[0], WIN_OUT[1]));
  const k = e * x;
  const grow = lerp(0.9, 1, e) * lerp(0.94, 1, x);
  const s = cam.s * grow;
  const cx = cam.x + WIN_W * cam.s / 2, cy = cam.y + WIN_H * cam.s / 2;
  const on = put(win, { x: cx - WIN_W * s / 2, y: cy - WIN_H * s / 2 + (1 - e) * 36 + (1 - x) * 16, s, o: Math.min(1, k * 1.6), b: (1 - x) * 10 });
  if (!on) return false;

  for (const { s: st, el } of STATE_EL) fadeImg(el, EASE.std(seg(t, st.t, st.t + st.d)));

  // 逐字打字：每个字符都是真实页面的截图条带，只显示最新一张。
  const idx = t < TYPE_START ? 0 : clamp(Math.floor((t - TYPE_START) / TYPE_STEP) + 1, 1, TYPE_N);
  const stripOp = t < TYPE_START ? 0 : 1 - seg(t, TYPE_END - 0.15, TYPE_END);
  STRIPS.forEach((el, i) => fadeImg(el, i === idx ? stripOp : 0));

  // 站内提醒卡片：从右侧滑入，按 iOS 弹层曲线落定。
  const ti = EASE.ios(seg(t, TOAST.in, TOAST.in + 0.75));
  const to = 1 - EASE.std(seg(t, TOAST.out - 0.3, TOAST.out));
  const ok = put(toastEl, { x: (1 - ti) * 64, y: (1 - ti) * -10, s: lerp(0.94, 1, ti), o: ti * to });
  if (ok) toastEl.style.transformOrigin = '100% 0';
  return true;
}

// 登录卡片：开场徽章缩到卡片标志上时，卡片从标志处展开。
function renderCard(t) {
  const inK = EASE.ios(seg(t, CARD.in, CARD.in + 0.9));
  const outK = EASE.cam(seg(t, CARD.out, CARD.out + 0.6));
  const pr = EASE.std(seg(t, beat(14) - 0.08, beat(14) + 0.02)) * (1 - EASE.std(seg(t, beat(14) + 0.05, beat(14) + 0.4)));
  put(card, { x: CARD.x, y: CARD.y + (1 - inK) * 18 + outK * 20, s: lerp(0.94, 1, inK) * lerp(1, 0.9, outK), o: Math.min(1, inK * 1.5) * (1 - outK), b: outK * 8 });
  card.style.transformOrigin = `${CARD.logo[0] - CARD.x}px ${CARD.logo[1] - CARD.y}px`;
  // 输入过程：占位 → “小” → “小满”
  const m = EASE.std(seg(t, 5.85, 5.95)) * (1 - EASE.std(seg(t, 6.25, 6.35)));
  const b = EASE.std(seg(t, 6.25, 6.35));
  cardM.style.opacity = m.toFixed(3);
  cardB.style.opacity = b.toFixed(3);
  cardP.style.opacity = (pr * 0.22).toFixed(3);
}

function renderCursor(t, cam) {
  const inStage = t >= CUR_STAGE_VIS[0][0] && t < CUR_STAGE_VIS[0][1];
  const inWin = CUR_WIN_VIS.find(([a, b]) => t >= a && t < b);
  if (!inStage && !inWin) { vis($('#cursor'), false); return; }
  let x, y, o = 1;
  if (inStage) {
    [x, y] = cursorPos(t, CUR_STAGE);
    o = EASE.std(seg(t, CUR_STAGE_VIS[0][0], CUR_STAGE_VIS[0][0] + 0.4)) * (1 - EASE.std(seg(t, CUR_STAGE_VIS[0][1] - 0.4, CUR_STAGE_VIS[0][1])));
  } else {
    const [wx, wy] = cursorPos(t, CUR_WIN);
    x = cam.x + wx * cam.s; y = cam.y + wy * cam.s;
    o = EASE.std(seg(t, inWin[0], inWin[0] + 0.4)) * (1 - EASE.std(seg(t, inWin[1] - 0.4, inWin[1])));
  }
  let press = 0, rip = 0, ripO = 0;
  for (const c of CLICKS) {
    press = Math.max(press, EASE.std(seg(t, c - 0.08, c)) * (1 - EASE.std(seg(t, c + 0.02, c + 0.18))));
    const r = seg(t, c, c + 0.55);
    if (r > 0 && r < 1) { rip = EASE.out(r); ripO = 0.8 * (1 - r); }
  }
  // 推近时光标也跟着放大一点，和界面比例协调
  const cs = inWin ? lerp(1, 1.35, seg(cam.s, S_BASE, 1.8)) : 1;
  put($('#cursor'), { x, y, s: cs * (1 - press * 0.1), o });
  const rp = $('#ripple');
  rp.style.opacity = ripO.toFixed(3);
  rp.style.transform = `scale(${(0.3 + rip * 1.5).toFixed(3)})`;
}
