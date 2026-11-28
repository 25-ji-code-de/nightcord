// 两种导出共用同一时间轴和 1920×1080 CSS 舞台，只改变采样密度与编码质量。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const here = path => fileURLToPath(new URL(path, import.meta.url));
export const VIEWPORT = { width: 1920, height: 1080 };
const timeline = vm.createContext({ document: {}, Math });
for (const file of ['lib.js', 'data.js']) {
  vm.runInContext(readFileSync(here(`../scene/${file}`), 'utf8'), timeline);
}
export const { FPS, DURATION } = vm.runInContext('({ FPS, DURATION: DUR })', timeline);
export const TOTAL_FRAMES = Math.round(FPS * DURATION);

const PROFILES = {
  preview: { scale: 1, captureScale: 2, workers: 8, bitrate: '24M', maxrate: '36M', bufsize: '72M', audioBitrate: '256k', level: '4.2', preset: 'slow' },
  final: { scale: 2, captureScale: 4, workers: 2, bitrate: '80M', maxrate: '120M', bufsize: '240M', audioBitrate: '320k', level: '5.2', preset: 'veryslow' },
};

export function getProfile(name = process.env.DEMO_PROFILE || 'preview') {
  if (!Object.hasOwn(PROFILES, name)) throw new Error(`未知导出版本：${name}；请选择 preview 或 final。`);
  const settings = PROFILES[name];
  const sceneUrl = new URL('../scene/index.html', import.meta.url);
  sceneUrl.searchParams.set('profile', name);
  return {
    ...settings, name,
    width: VIEWPORT.width * settings.scale, height: VIEWPORT.height * settings.scale,
    buildDir: here(`../build/${name}/`),
    shotsDir: here(`../build/${name}/shots/`), assetsDir: here(`../build/${name}/assets/`),
    framesDir: here(`../frames/${name}/`), sceneUrl: sceneUrl.href,
    output: here(`../../nightcord-demo-${name === 'final' ? '4k' : 'preview'}.mp4`),
  };
}
