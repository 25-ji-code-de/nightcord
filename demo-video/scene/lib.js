// 缓动与小工具。所有画面都是时间 t 的纯函数，保证逐帧渲染可复现。
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const seg = (t, a, b) => clamp((t - a) / (b - a));
const lerp = (a, b, x) => a + (b - a) * x;
const $ = s => document.querySelector(s);

function bez(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = t => ((ax * t + bx) * t + cx) * t;
  const sy = t => ((ay * t + by) * t + cy) * t;
  const dx = t => (3 * ax * t + 2 * bx) * t + cx;
  return x => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-6) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) { if (sx(t) < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return sy(t);
  };
}

// ios：iOS 弹层曲线，用于入场；cam：对称缓入缓出，用于镜头；std：Material 标准曲线。
const EASE = {
  ios: bez(.32, .72, 0, 1),
  cam: bez(.65, 0, .35, 1),
  std: bez(.4, 0, .2, 1),
  out: bez(.16, 1, .3, 1),
  lin: x => x,
};

function mk(tag, cls, html, parent) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html != null) el.innerHTML = html;
  if (parent) parent.appendChild(el);
  return el;
}

function vis(el, on, d = 'block') {
  if (el._on === on) return;
  el._on = on;
  el.style.display = on ? d : 'none';
}

// 只改外观，不改 display：用于逐字出现的行内元素，避免排版塌陷。
function set(el, o = {}) {
  const op = o.o == null ? 1 : o.o;
  el.style.opacity = op >= 0.999 ? '' : op.toFixed(4);
  el.style.transform = `translate3d(${(o.x || 0).toFixed(2)}px,${(o.y || 0).toFixed(2)}px,0)` + (o.s != null && o.s !== 1 ? ` scale(${o.s.toFixed(5)})` : '');
  el.style.filter = o.b > 0.05 ? `blur(${o.b.toFixed(2)}px)` : '';
}

// 统一设置位移、缩放、透明度与模糊；不可见时直接 display:none 省掉合成。
function put(el, o = {}) {
  const op = o.o == null ? 1 : o.o;
  if (op <= 0.002) { vis(el, false); return false; }
  vis(el, true);
  el.style.opacity = op >= 0.999 ? '' : op.toFixed(4);
  const tr = `translate3d(${(o.x || 0).toFixed(2)}px,${(o.y || 0).toFixed(2)}px,0)`
    + (o.s != null && o.s !== 1 ? ` scale(${o.s.toFixed(5)})` : '')
    + (o.r ? ` rotate(${o.r.toFixed(3)}deg)` : '');
  el.style.transform = tr;
  el.style.filter = o.b > 0.05 ? `blur(${o.b.toFixed(2)}px)` : '';
  return true;
}

// 按关键帧在 [t_i, t_{i+1}] 内用 ease 插值；v 是数字数组。
function track(t, keys, ease = EASE.cam) {
  if (t <= keys[0].t) return keys[0].v.slice();
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v.slice();
  let i = 0;
  while (t >= keys[i + 1].t) i++;
  const p = (keys[i].e || ease)(seg(t, keys[i].t, keys[i + 1].t));
  return keys[i].v.map((a, k) => lerp(a, keys[i + 1].v[k], p));
}
