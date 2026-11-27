// 窗口、镜头、光标、登录卡片、打字与提醒卡片。

function fadeImg(el, o) {
  if (o <= 0.002) { if (el._on !== false) { el.style.display = 'none'; el._on = false; } return; }
  if (el._on !== true) { el.style.display = 'block'; el._on = true; }
  el.style.opacity = o >= 0.999 ? '' : o.toFixed(4);
}

function camera(t) {
  const [x, y, s] = track(t, CAM, EASE.cam);
  return { x, y, s };
}

// 窗口入场/退场：围绕中心缩放，轻微上浮，伴随淡入。
function renderWindow(t, cam) {
  const e = EASE.ios(seg(t, WIN_IN, WIN_IN + 1.25));
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
  const stripOp = t < TYPE_START ? 0 : 1 - seg(t, 15.5, 15.75);
  STRIPS.forEach((el, i) => fadeImg(el, i === idx ? stripOp : 0));

  // 站内提醒卡片：从右侧滑入，按 iOS 弹层曲线落定。
  const ti = EASE.ios(seg(t, TOAST.in, TOAST.in + 0.75));
  const to = 1 - EASE.std(seg(t, TOAST.out - 0.35, TOAST.out));
  const ok = put(toastEl, { x: (1 - ti) * 64, y: (1 - ti) * -10, s: lerp(0.94, 1, ti), o: ti * to });
  if (ok) toastEl.style.transformOrigin = '100% 0';
  return true;
}

function renderCard(t) {
  const inK = EASE.ios(seg(t, 5.0, 6.2));
  const outK = EASE.cam(seg(t, 9.0, 9.65));
  const pr = EASE.std(seg(t, 8.82, 8.92)) * (1 - EASE.std(seg(t, 8.95, 9.35)));
  put(card, { x: lerp(64, 0, inK) + outK * -50, y: (1 - inK) * 30 + outK * 20, s: lerp(0.92, 1, inK) * lerp(1, 0.9, outK), o: inK * (1 - outK), b: outK * 8 });
  card.style.transformOrigin = '50% 50%';
  // 输入过程：占位 → “小” → “小满”
  const m = EASE.std(seg(t, 7.35, 7.45)) * (1 - EASE.std(seg(t, 7.95, 8.05)));
  const b = EASE.std(seg(t, 7.95, 8.05));
  cardM.style.opacity = m.toFixed(3);
  cardB.style.opacity = b.toFixed(3);
  // 点击“进入”时按钮闪一下高光
  cardP.style.opacity = (pr * 0.22).toFixed(3);
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

function renderCursor(t, cam) {
  const inStage = t >= CUR_STAGE_VIS[0][0] && t < CUR_STAGE_VIS[0][1];
  const inWin = CUR_WIN_VIS.find(([a, b]) => t >= a && t < b);
  if (!inStage && !inWin) { vis($('#cursor'), false); return; }
  let x, y, o = 1;
  if (inStage) {
    [x, y] = cursorPos(t, CUR_STAGE);
    o = EASE.std(seg(t, CUR_STAGE_VIS[0][0], CUR_STAGE_VIS[0][0] + 0.5));
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
  put($('#cursor'), { x, y, s: 1 - press * 0.1, o });
  const rp = $('#ripple');
  rp.style.opacity = ripO.toFixed(3);
  rp.style.transform = `scale(${(0.3 + rip * 1.5).toFixed(3)})`;
}
