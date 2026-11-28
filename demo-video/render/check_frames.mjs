// 只读帧文件头，检查序列完整性与真实像素尺寸；不启动浏览器或编码器。
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getProfile, FPS, DURATION, TOTAL_FRAMES } from './config.mjs';

export function checkFrames(profile) {
  const manifest = JSON.parse(readFileSync(join(profile.framesDir, 'render.json'), 'utf8'));
  const expected = { profile: profile.name, width: profile.width, height: profile.height, fps: FPS, duration: DURATION, total: TOTAL_FRAMES, format: 'png' };
  for (const [key, value] of Object.entries(expected)) {
    if (manifest[key] !== value) throw new Error(`帧配置不匹配：${key}，请重新渲染 ${profile.name}。`);
  }
  const files = readdirSync(profile.framesDir).filter(file => /^f\d+\.png$/.test(file));
  if (files.length !== TOTAL_FRAMES) throw new Error(`应有 ${TOTAL_FRAMES} 帧，实际 ${files.length} 帧；请完成渲染后再编码。`);
  for (let i = 0; i < TOTAL_FRAMES; i++) {
    const file = join(profile.framesDir, `f${String(i).padStart(5, '0')}.png`);
    const header = Buffer.alloc(24);
    const fd = openSync(file, 'r');
    let size;
    try { size = readSync(fd, header, 0, header.length, 0); }
    finally { closeSync(fd); }
    if (size !== header.length || statSync(file).size <= header.length || header.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || header.toString('ascii', 12, 16) !== 'IHDR' || header.readUInt32BE(16) !== profile.width || header.readUInt32BE(20) !== profile.height) {
      throw new Error(`帧格式或尺寸不符：${file}；需要 ${profile.width}×${profile.height} PNG。`);
    }
  }
  console.log(`帧检查通过：${TOTAL_FRAMES} 张 ${profile.width}×${profile.height} PNG。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) checkFrames(getProfile(process.argv[2]));
