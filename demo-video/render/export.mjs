// 在渲染环境运行：node demo-video/render/export.mjs preview|final
// 不传参数只导出 preview；final 必须显式指定，供预览确认后手动启动。
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { getProfile, here, FPS } from './config.mjs';
import { checkEncoder, encode } from './encode.mjs';

if (process.argv.length > 3) throw new Error('用法：node demo-video/render/export.mjs [preview|final]');
const profile = getProfile(process.argv[2] || 'preview');
const workers = Number(process.env.DEMO_WORKERS ?? profile.workers);
if (!Number.isInteger(workers) || workers < 1 || workers > 32) throw new Error('DEMO_WORKERS 必须为 1–32 的整数。');
checkEncoder(profile); // 先检查编码依赖，避免逐帧渲染完成后才发现缺少编码器。
const env = { ...process.env, DEMO_PROFILE: profile.name };
const run = file => execFileSync(process.execPath, [here(file)], { env, stdio: 'inherit' });
console.log(`开始导出 ${profile.name}：${profile.width}×${profile.height} / ${FPS} fps，输出 ${profile.output}`);
run('../capture/shoot.mjs');
run('../capture/prep_assets.mjs');
run('./audio.mjs');
// 只清理本版本可重新生成的帧；避免旧渲染和中断任务的帧混入本次成片。
mkdirSync(profile.framesDir, { recursive: true });
for (const file of readdirSync(profile.framesDir)) {
  if (/^f\d+\.png$/.test(file) || file === 'render.json') unlinkSync(join(profile.framesDir, file));
}
run('./frames.mjs');
encode(profile);
if (profile.name === 'preview') console.log('预览版已完成。确认画面后，再手动运行 node demo-video/render/export.mjs final。');
