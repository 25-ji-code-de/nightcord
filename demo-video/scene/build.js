// 构建 DOM：一次性创建所有元素，之后每帧只改样式。
const svgNS = 'http://www.w3.org/2000/svg';
function svg(tag, parent, attrs = {}) {
  const el = document.createElementNS(svgNS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  parent.appendChild(el);
  return el;
}
function img(src, parent) {
  const el = mk('img', null, null, parent);
  el.src = src;
  el.style.display = 'none';
  return el;
}

// 圆角矩形路径，从顶边中点顺时针画一圈。w = h = 2r 时就是圆，所以矩形和圆之间可以连续变形。
function rrect(x, y, w, h, r) {
  const f = v => v.toFixed(2);
  const A = (ex, ey) => `A${f(r)} ${f(r)} 0 0 1 ${f(ex)} ${f(ey)}`;
  return `M${f(x + w / 2)} ${f(y)}H${f(x + w - r)}${A(x + w, y + r)}V${f(y + h - r)}${A(x + w - r, y + h)}`
    + `H${f(x + r)}${A(x, y + h - r)}V${f(y + r)}${A(x + r, y)}Z`;
}
const circ = (cx, cy, r) => rrect(cx - r, cy - r, 2 * r, 2 * r, r);

// 字标：逐字母分组，便于逐个入场
const wmEl = $('#wm');
const wmSvg = svg('svg', wmEl, { viewBox: '0 0 1084 216' });
const wmRoot = svg('g', wmSvg, { transform: 'translate(0 4)' });
const LETTERS = WORDMARK.map(w => {
  const g = svg('g', wmRoot);
  svg('path', g, { d: w.d, transform: w.transform });
  return g;
});

// 徽章：外轮廓（可在手机矩形与圆之间变形）、内圆、双眼，各自描线；填充层是同一几何的 evenodd 实心月牙。
const badgeSvg = $('#badge');
const badgeG = svg('g', badgeSvg);
const BADGE = {
  fill: svg('path', badgeG, { class: 'fill' }),
  outer: svg('path', badgeG, { pathLength: 1 }),
  inner: svg('path', badgeG, { pathLength: 1 }),
  eyes: [svg('path', badgeG), svg('path', badgeG)],
};

// 窗口：真实前端截图的叠放
const win = $('#win');
const STATE_EL = STATES.map(s => ({ s, el: img(`../shots/${s.src}.png`, win) }));
const toastEl = mk('img', null, null, win);
toastEl.src = '../assets/toast.png';
// 行内样式：#win img 的通用规则（整窗尺寸）优先级更高，不能靠 id 选择器覆盖。
const TOAST_CSS = `left:${TOAST.x}px;top:${TOAST.y}px;width:${TOAST.w}px;height:${TOAST.h}px;filter:drop-shadow(0 14px 26px rgba(0,0,0,.4))`;
toastEl.style.cssText = `position:absolute;z-index:5;display:none;${TOAST_CSS}`;
const STRIPS = [];
for (let i = 0; i <= TYPE_N; i++) {
  const el = img(`../shots/strip-${i}.png`, win);
  el.style.cssText = `display:none;left:${STRIP.x}px;top:${STRIP.y}px;width:${STRIP.w}px;height:${STRIP.h}px`;
  STRIPS.push(el);
}

// 登录卡片
const card = $('#card');
const cardB = $('#card-b'), cardP = $('#card-press');
const cardM = mk('img', null, null, card);
cardM.src = '../assets/card-chooser-typed-1.png';
cardM.style.opacity = 0;
card.insertBefore(cardM, cardB);

// 手机：第一部（聊天）在上层，合并时第二部收到它身后。
const PH = ['mobile-chat', 'mobile-drawer'].map((name, i) => {
  const el = mk('div', 'phone', null, $('#phones'));
  el.style.zIndex = 2 - i;
  const scr = mk('div', 'scr', null, el);
  mk('img', null, null, scr).src = `../shots/${name}.png`;
  mk('i', 'isl', null, scr);
  return el;
});

// 线条层：间奏的波浪线与画框，以及手机入场前的轮廓。
const linesSvg = $('#lines');
const LINE_EL = {};
for (const id of ['w0', 'w1', 'w2', 'frame', 'p0', 'p1']) LINE_EL[id] = svg('path', linesSvg, { pathLength: 1 });
PHONE.x.forEach((x, i) => LINE_EL['p' + i].setAttribute('d', rrect(x, PHONE.y, PHONE.w, PHONE.h, PHONE.r)));

// 局部特写：每张是一份完整的 1440x900 窗口，再按镜头裁切放大。
const MONT_EL = MONTAGE.map(m => {
  const box = mk('div', 'mshot', null, $('#mont'));
  mk('img', null, null, box).src = `../shots/${m.src}.png`;
  if (m.toast) {
    const ti = mk('img', null, null, box);
    ti.src = '../assets/toast.png';
    ti.style.cssText = TOAST_CSS;
  }
  return { m, box };
});

// 等所有图片加载完成。隐藏元素的 decode() 在 Chromium 里可能拒绝，所以改用 load 事件。
const loaded = i => i.complete && i.naturalWidth > 0 ? Promise.resolve() : new Promise((ok, no) => {
  i.addEventListener('load', ok, { once: true });
  i.addEventListener('error', () => no(new Error('图片加载失败：' + i.src)), { once: true });
});
window.READY = document.fonts.ready.then(() => Promise.all([...document.images].map(loaded))).then(() => true);
