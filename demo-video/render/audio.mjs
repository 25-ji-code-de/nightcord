// 音轨：只用 demo-video/reference.mp4 的配乐，不加任何音效（48kHz 立体声）。
// 画面时长与配乐一致（scene/data.js 的 DUR），音乐自身在 57.8 秒收住，这里只补一个极短的尾部淡出。
import { readFileSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const out = here('../build/audio.wav');
mkdirSync(here('../build/'), { recursive: true });

// 在沙箱里执行 lib.js + data.js，直接拿到画面用的时长。
const ctx = vm.createContext({ document: {}, Math });
for (const f of ['../scene/lib.js', '../scene/data.js']) vm.runInContext(readFileSync(here(f), 'utf8'), ctx);
const DUR = vm.runInContext('DUR', ctx);

execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', here('../reference.mp4'), '-vn',
  '-af', `aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:${DUR},apad=whole_dur=${DUR},afade=t=out:st=${(DUR - 0.3).toFixed(2)}:d=0.3`,
  '-ar', '48000', '-ac', '2', out], { stdio: 'inherit' });
console.log('ok', out, Math.round(statSync(out).size / 1024), 'KB，时长', DUR, '秒');
