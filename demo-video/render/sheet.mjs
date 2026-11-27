// 把 build/preview/ 里指定时刻的静帧拼成一张联系表，便于一次检查多帧。
// 用法：node render/sheet.mjs 输出.png 1.5 7.8 13.9 ...
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../build/preview/', import.meta.url));
const [out, ...times] = process.argv.slice(2);
const cols = 4, rows = Math.ceil(times.length / cols);
const inputs = times.flatMap(t => ['-i', `${dir}t${Number(t).toFixed(2).padStart(6, '0')}.png`]);
const scale = times.map((_, i) => `[${i}]scale=640:-1,drawtext=text='${times[i]}':x=8:y=8:fontsize=28:fontcolor=yellow:box=1:boxcolor=black@0.6[v${i}]`).join(';');
const pad = Array.from({ length: rows * cols - times.length }, (_, k) => `color=black:s=640x360:d=1[p${k}]`).join(';');
const all = [...times.map((_, i) => `[v${i}]`), ...Array.from({ length: rows * cols - times.length }, (_, k) => `[p${k}]`)];
const layout = all.map((_, i) => `${(i % cols) * 640}_${Math.floor(i / cols) * 360}`).join('|');
const fc = [scale, pad].filter(Boolean).join(';') + ';' + all.join('') + `xstack=inputs=${all.length}:layout=${layout}`;
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', fc, '-frames:v', '1', out], { stdio: 'inherit' });
console.log('ok', out);
