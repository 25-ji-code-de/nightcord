// 混音：配乐用 demo-video/reference.mp4 的音轨，再叠上仓库自带的原创提示音（48kHz 立体声）。
// 提示音时刻按旧时间轴书写，经 scene/data.js 里的 W() 映射到新时间轴，与画面保持同步。
import { readFileSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const root = here('../../');
const out = here('../build/audio.wav');
mkdirSync(here('../build/'), { recursive: true });

// 在沙箱里执行 lib.js + data.js，直接拿到画面用的时间轴。
const ctx = vm.createContext({ document: {}, Math });
for (const f of ['../scene/lib.js', '../scene/data.js']) vm.runInContext(readFileSync(here(f), 'utf8'), ctx);
const { W, DUR } = vm.runInContext('({ W, DUR })', ctx);

// (文件, 旧时间轴上的时刻 s, 音量 dB)
const CUES = [
  ['se_nightcord_enter.mp3', 9.55, -8],   // 进入房间
  ['se_notify_online.mp3', 10.3, -16],    // 成员上线
  ['se_notify_message.mp3', 15.62, -10],  // 发出消息后收到回传
  ['se_notify_reply.mp3', 17.95, -10],    // 被回复
  ['se_notify_mention.mp3', 18.35, -9],   // 被提及
  ['se_notify_online.mp3', 28.45, -13],   // 语音成员出现
];

const inputs = ['-i', here('../reference.mp4')];
const filters = [
  // 配乐：原曲 58 秒处自然结束，片尾再补一个短淡出
  `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:${DUR},afade=t=out:st=${(DUR - 1.4).toFixed(2)}:d=1.3[bgm]`,
];
const labels = ['[bgm]'];
CUES.forEach(([name, at, db], i) => {
  inputs.push('-i', root + name);
  const ms = Math.round(W(at) * 1000);
  filters.push(`[${i + 1}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${db}dB,adelay=${ms}|${ms}[c${i}]`);
  labels.push(`[c${i}]`);
});
filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=first,alimiter=limit=0.95[mix]`);

execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', filters.join(';'),
  '-map', '[mix]', '-ar', '48000', '-ac', '2', out], { stdio: 'inherit' });
console.log('ok', out, Math.round(statSync(out).size / 1024), 'KB');
console.log('提示音时刻', CUES.map(c => W(c[1]).toFixed(2)).join(' '));
