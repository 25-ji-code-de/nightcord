// 构建 DOM：一次性创建所有元素，之后每帧只改样式。
const IMGS = [];
function img(src, parent, cls) {
  const el = mk('img', cls, null, parent);
  el.src = src;
  el.style.display = 'none';
  IMGS.push(el);
  return el;
}

// 字标：逐字母分组，便于书写式入场
const wmEl = $('#wm');
const svgNS = 'http://www.w3.org/2000/svg';
const wmSvg = document.createElementNS(svgNS, 'svg');
wmSvg.setAttribute('viewBox', '0 0 1084 216');
const wmRoot = document.createElementNS(svgNS, 'g');
wmRoot.setAttribute('transform', 'translate(0 4)');
wmSvg.appendChild(wmRoot);
const LETTERS = WORDMARK.map(w => {
  const g = document.createElementNS(svgNS, 'g');
  const p = document.createElementNS(svgNS, 'path');
  p.setAttribute('d', w.d);
  p.setAttribute('transform', w.transform);
  g.appendChild(p);
  wmRoot.appendChild(g);
  return g;
});
wmEl.appendChild(wmSvg);
// 月牙符号的描边：先用线条勾出轮廓，再填充实色（参考视频的线条感）。
const wmStroke = document.createElementNS(svgNS, 'path');
wmStroke.setAttribute('d', WORDMARK[0].d);
wmStroke.setAttribute('transform', WORDMARK[0].transform);
wmStroke.setAttribute('pathLength', '1');
wmStroke.setAttribute('class', 'stroke');
LETTERS[0].appendChild(wmStroke);

// 标题：逐字拆开，每个字独立入场
const HLS = HL.map(h => {
  const box = mk('div', 'hl', null, $('#hls'));
  box.style.cssText = `left:${h.x}px;top:${h.y}px;width:${h.w}px;text-align:${h.al}`;
  const chars = [], lines = [];
  h.lines.forEach((line, li) => {
    const ln = mk('div', 'ln' + (li === h.g ? ' g' : ''), null, box);
    ln.style.fontSize = h.size + 'px';
    lines.push(ln);
    [...line].forEach(ch => chars.push(mk('span', 'c', ch, ln)));
  });
  let sub = null;
  if (h.sub) {
    sub = mk('div', 'sub', h.sub, box);
    sub.style.fontSize = h.ss + 'px';
  }
  return { h, box, chars, sub, lines };
});

// 渐变文字：每个字符各自一份背景，用偏移拼成连续渐变（字符带 transform，不能让父级裁切）。
function layoutGradient() {
  for (const item of HLS) {
    item.box.style.display = 'block';
    for (const ln of item.lines) {
      if (!ln.classList.contains('g')) continue;
      const w = ln.scrollWidth;
      const left0 = ln.getBoundingClientRect().left;
      for (const c of ln.children) {
        c.style.backgroundSize = `${w}px 100%`;
        c.style.backgroundPosition = `${-(c.getBoundingClientRect().left - left0)}px 0`;
      }
    }
    item.box.style.display = 'none';
    item.box._on = false;
  }
}

// 窗口：真实前端截图的叠放
const win = $('#win');
const STATE_EL = STATES.map(s => ({ s, el: img(`../shots/${s.src}.png`, win) }));
const toastEl = mk('img', null, null, win);
toastEl.id = 'toast';
toastEl.src = '../assets/toast.png';
// 行内样式：#win img 的通用规则（整窗尺寸）优先级更高，不能靠 #toast 覆盖。
toastEl.style.cssText = 'position:absolute;left:1045.5px;top:72px;width:377.5px;height:131.5px;z-index:5;display:none;filter:drop-shadow(0 18px 30px rgba(0,0,0,.45))';
IMGS.push(toastEl);
const STRIPS = [];
for (let i = 0; i <= TYPE_N; i++) {
  const el = img(`../shots/strip-${i}.png`, win);
  el.style.cssText = `display:none;left:${STRIP.x}px;top:${STRIP.y}px;width:${STRIP.w}px;height:${STRIP.h}px`;
  STRIPS.push(el);
}

// 登录卡片
const card = $('#card');
const cardA = $('#card-a'), cardB = $('#card-b'), cardP = $('#card-press');
const cardM = mk('img', null, null, card);
cardM.src = '../assets/card-chooser-typed-1.png';
cardM.style.opacity = 0;
card.insertBefore(cardM, cardB);
IMGS.push(cardA, cardB, cardM);

// 手机
const PH = ['mobile-chat', 'mobile-drawer'].map(name => {
  const el = mk('div', 'phone', null, $('#phones'));
  const scr = mk('div', 'scr', null, el);
  const im = mk('img', null, null, scr);
  im.src = `../shots/${name}.png`;
  IMGS.push(im);
  mk('i', 'isl', null, scr);
  return el;
});

// 功能标签
const CHIP_EL = CHIPS.map(text => mk('div', 'chip', text, $('#chips')));

// 线条层：间奏的波浪线与手机轮廓。
const linesSvg = $('#lines');
const LINE_EL = {};
for (const id of ['w0', 'w1', 'w2', 'p0', 'p1']) {
  const p = document.createElementNS(svgNS, 'path');
  p.setAttribute('pathLength', '1');
  linesSvg.appendChild(p);
  LINE_EL[id] = p;
}
// 圆角矩形路径，从顶边中点顺时针画一圈。
function rrect(x, y, w, h, r) {
  const cx = x + w / 2;
  return 'M' + cx + ' ' + y + 'H' + (x + w - r) + 'A' + r + ' ' + r + ' 0 0 1 ' + (x + w) + ' ' + (y + r)
    + 'V' + (y + h - r) + 'A' + r + ' ' + r + ' 0 0 1 ' + (x + w - r) + ' ' + (y + h)
    + 'H' + (x + r) + 'A' + r + ' ' + r + ' 0 0 1 ' + x + ' ' + (y + h - r)
    + 'V' + (y + r) + 'A' + r + ' ' + r + ' 0 0 1 ' + (x + r) + ' ' + y + 'Z';
}
LINE_EL.p0.setAttribute('d', rrect(1000, 120, 392, 820, 64));
LINE_EL.p1.setAttribute('d', rrect(1420, 156, 392, 820, 64));

// 第二次高潮的局部特写：每张是一份完整的 1440x900 窗口，再按镜头裁切放大。
const MONT_EL = MONTAGE.map(m => {
  const box = mk('div', 'mshot', null, $('#mont'));
  const im = mk('img', null, null, box);
  im.src = '../shots/' + m.src + '.png';
  if (m.toast) {
    const ti = mk('img', null, null, box);
    ti.src = '../assets/toast.png';
    ti.style.cssText = 'left:1045.5px;top:72px;width:377.5px;height:131.5px;filter:drop-shadow(0 18px 30px rgba(0,0,0,.45))';
  }
  return { m, box };
});

// 等所有图片加载完成。隐藏元素的 decode() 在 Chromium 里可能拒绝，所以改用 load 事件。
const allImgs = [...document.images];
const loaded = i => i.complete && i.naturalWidth > 0 ? Promise.resolve() : new Promise((ok, no) => {
  i.addEventListener('load', ok, { once: true });
  i.addEventListener('error', () => no(new Error('图片加载失败：' + i.src)), { once: true });
});
window.READY = document.fonts.ready
  .then(() => Promise.all(allImgs.map(loaded)))
  .then(() => { layoutGradient(); return true; });
