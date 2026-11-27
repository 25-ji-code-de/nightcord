// 检查镜头是否平滑：逐帧计算镜头的位移/缩放速度与加速度，列出最大值和加速度突变最大的几帧。
// 用法：node render/camcheck.mjs [起始秒] [结束秒]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const ctx = vm.createContext({ Math, Map, document: { querySelector: () => null } });
for (const f of ['lib.js', 'data.js']) vm.runInContext(readFileSync(here('../scene/' + f), 'utf8'), ctx);
// render-b.js 依赖 DOM 的部分只在函数体里，顶层只定义函数，可以直接执行。
vm.runInContext(readFileSync(here('../scene/render-b.js'), 'utf8'), ctx);
const camera = vm.runInContext('camera', ctx);

const FPS = 60;
const t0 = Number(process.argv[2] ?? 8), t1 = Number(process.argv[3] ?? 34);
// 用画面中心对应的窗口点 + 对数缩放描述镜头，单位：舞台像素
const pts = [];
for (let i = Math.round(t0 * FPS); i <= Math.round(t1 * FPS); i++) {
  const t = i / FPS, c = camera(t);
  pts.push({ t, x: (960 - c.x) / c.s, y: (540 - c.y) / c.s, ls: Math.log(c.s), s: c.s });
}
const d = (a, b, k) => (b[k] - a[k]) * FPS;
const v = [], acc = [];
for (let i = 1; i < pts.length; i++) {
  const s = pts[i].s;
  v.push({ t: pts[i].t, vx: d(pts[i - 1], pts[i], 'x') * s, vy: d(pts[i - 1], pts[i], 'y') * s, vz: d(pts[i - 1], pts[i], 'ls') });
}
for (let i = 1; i < v.length; i++) {
  acc.push({ t: v[i].t, a: Math.hypot(v[i].vx - v[i - 1].vx, v[i].vy - v[i - 1].vy) * FPS, az: (v[i].vz - v[i - 1].vz) * FPS });
}
const jerk = [];
for (let i = 1; i < acc.length; i++) jerk.push({ t: acc[i].t, j: Math.abs(acc[i].a - acc[i - 1].a) * FPS, jz: Math.abs(acc[i].az - acc[i - 1].az) * FPS });
const max = (arr, f) => arr.reduce((m, x) => Math.max(m, f(x)), 0);
console.log('最大平移速度 px/s', max(v, x => Math.hypot(x.vx, x.vy)).toFixed(0), ' 最大缩放速度 ln/s', max(v, x => Math.abs(x.vz)).toFixed(3));
console.log('最大平移加速度 px/s²', max(acc, x => x.a).toFixed(0), ' 最大缩放加速度', max(acc, x => Math.abs(x.az)).toFixed(3));
const top = [...jerk].sort((a, b) => b.j - a.j).slice(0, 6);
console.log('平移加加速度最大的帧', top.map(x => `${x.t.toFixed(2)}s:${x.j.toFixed(0)}`).join('  '));
const topz = [...jerk].sort((a, b) => b.jz - a.jz).slice(0, 6);
console.log('缩放加加速度最大的帧', topz.map(x => `${x.t.toFixed(2)}s:${x.jz.toFixed(2)}`).join('  '));
