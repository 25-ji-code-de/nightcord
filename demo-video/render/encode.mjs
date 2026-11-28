// 只编码已完成的对应版本帧序列；供 encode.sh 和 export.mjs 共用。
import { accessSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getProfile, here, FPS, DURATION, TOTAL_FRAMES } from './config.mjs';
import { checkFrames } from './check_frames.mjs';

export function checkEncoder(profile) {
  const encoders = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
  const has = name => new RegExp(`\\b${name}\\b`).test(encoders);
  if (has('libx264')) return 'libx264';
  if (profile.name === 'preview' && has('libopenh264')) return 'libopenh264';
  throw new Error(profile.name === 'final'
    ? '4K 最终版需要带 libx264 的 ffmpeg；请安装后重试。'
    : 'ffmpeg 需要 libx264 或 libopenh264 编码器。');
}

export function encode(profile, output = profile.output) {
  const codec = checkEncoder(profile);
  checkFrames(profile);
  accessSync(here('../build/audio.wav'));
  const target = resolve(output);
  // 完成并验证后再替换目标文件；编码失败保留此前成片。
  const temporary = `${target}.encoding.mp4`;
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-stats', '-xerror', '-y',
    '-framerate', String(FPS), '-start_number', '0', '-i', join(profile.framesDir, 'f%05d.png'),
    '-i', here('../build/audio.wav'),
    '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p',
    '-c:v', codec, '-profile:v', 'high',
    // 限制参考帧数量，避免 slow/veryslow 的默认值超出所声明 H.264 level 的解码缓冲上限。
    ...(codec === 'libx264' ? ['-preset', profile.preset, '-level:v', profile.level, '-refs', '4'] : []),
    '-b:v', profile.bitrate, '-maxrate', profile.maxrate, '-bufsize', profile.bufsize, '-g', String(FPS * 2),
    '-frames:v', String(TOTAL_FRAMES), '-t', String(DURATION),
    '-c:a', 'aac', '-b:a', profile.audioBitrate, '-ar', '48000',
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-movflags', '+faststart', temporary,
  ], { stdio: 'inherit' });
  const probe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,profile,width,height,r_frame_rate,pix_fmt,duration,nb_frames,bit_rate:format=duration,size,bit_rate',
    '-of', 'json', temporary,
  ], { encoding: 'utf8' }));
  const video = probe.streams.find(stream => stream.codec_type === 'video');
  const audio = probe.streams.find(stream => stream.codec_type === 'audio');
  const [rateNum, rateDen] = (video?.r_frame_rate || '').split('/').map(Number);
  const videoDuration = Number(video?.duration), audioDuration = Number(audio?.duration);
  if (!video || video.codec_name !== 'h264' || video.pix_fmt !== 'yuv420p' || video.width !== profile.width || video.height !== profile.height
    || rateNum / rateDen !== FPS || Number(video.nb_frames) !== TOTAL_FRAMES || !Number.isFinite(videoDuration) || Math.abs(videoDuration - DURATION) > 1 / FPS
    || audio?.codec_name !== 'aac' || !Number.isFinite(audioDuration) || Math.abs(audioDuration - DURATION) > 0.1) {
    throw new Error(`编码结果的规格、帧数或音轨不符，请检查 ${temporary}。`);
  }
  renameSync(temporary, target);
  console.log(JSON.stringify(probe, null, 2));
  console.log(`完成：${target}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const profile = getProfile(['preview', 'final'].includes(args[0]) ? args.shift() : undefined);
  if (args.length > 1) throw new Error('用法：node render/encode.mjs [preview|final] [输出.mp4]');
  // 保持旧 encode.sh 的相对路径语义：以 demo-video/ 为基准。
  encode(profile, args[0] ? resolve(here('../'), args[0]) : profile.output);
}
