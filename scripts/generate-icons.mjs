#!/usr/bin/env node
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team
 *
 * 生成 PWA / favicon 图标。几何与 icons/nightcord-mark.svg 保持一致。
 *
 * 画法分两类：
 *   - any（favicon、icon-192/512）：圆形底 + 透明四角 —— 浏览器标签、快捷方式按圆形呈现
 *   - maskable：满幅方形底 —— 不预切圆角，交给系统按实际遮罩裁切
 *
 * apple-touch-icon.png 不在这里生成：iOS 主屏用设计提供的液态玻璃稿（见 OUTPUTS 注释）。
 *
 * 用法：node scripts/generate-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'icons');

/** 设计坐标系边长；图标里的所有几何都以它为基准。 */
export const CANVAS = 1024;

const PURPLE = [153, 80, 154]; // #99509A
const WHITE = [255, 255, 255];

/** 月牙 mark：外圆减内圆，再加两只眼睛（even-odd）。 */
export const MARK = {
  outer: { x: 533.3333, y: 512, r: 341.3333 },
  inner: { x: 618.6667, y: 512, r: 256 },
  eyes: [
    { x: 533.3333, y: 512, r: 42.6667 },
    { x: 704, y: 512, r: 42.6667 },
  ],
};

const inCircle = (x, y, c) => (x - c.x) ** 2 + (y - c.y) ** 2 <= c.r ** 2;

const inMark = (x, y) =>
  MARK.eyes.some((eye) => inCircle(x, y, eye)) ||
  (inCircle(x, y, MARK.outer) && !inCircle(x, y, MARK.inner));

/** shape: 'circle' 满幅圆底；'square' 满幅方底（交给系统遮罩）。 */
const inBackground = (x, y, shape) =>
  shape === 'square' ? true : inCircle(x, y, { x: 512, y: 512, r: 512 });

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** 行过滤器统一用 0（None），让 test/pwa.test.mjs 能直接解出像素。 */
function encodePng(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 渲染一张图标。SS×SS 超采样后按覆盖率取色，边缘自然抗锯齿。
 */
export function renderIcon(size, shape) {
  const SS = 4;
  const total = SS * SS;
  const scale = CANVAS / size;
  const stride = 1 + size * 4;
  const raw = Buffer.alloc(size * stride);

  for (let py = 0; py < size; py++) {
    const row = py * stride;
    for (let px = 0; px < size; px++) {
      let bgHits = 0;
      let markHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * scale;
          const y = (py + (sy + 0.5) / SS) * scale;
          if (!inBackground(x, y, shape)) continue;
          bgHits++;
          if (inMark(x, y)) markHits++;
        }
      }
      const o = row + 1 + px * 4;
      const markMix = markHits / total;
      raw[o] = Math.round(PURPLE[0] * (1 - markMix) + WHITE[0] * markMix);
      raw[o + 1] = Math.round(PURPLE[1] * (1 - markMix) + WHITE[1] * markMix);
      raw[o + 2] = Math.round(PURPLE[2] * (1 - markMix) + WHITE[2] * markMix);
      raw[o + 3] = Math.round((bgHits / total) * 255);
    }
  }

  return encodePng(size, raw);
}

/** favicon.svg：圆形底 + 月牙 mark，与 PNG 同源。 */
export function renderSvg() {
  const d = `
    M${MARK.outer.x + MARK.outer.r} ${MARK.outer.y} A${MARK.outer.r} ${MARK.outer.r} 0 1 1 ${MARK.outer.x - MARK.outer.r} ${MARK.outer.y} A${MARK.outer.r} ${MARK.outer.r} 0 0 1 ${MARK.outer.x + MARK.outer.r} ${MARK.outer.y} Z
    M${MARK.inner.x + MARK.inner.r} ${MARK.inner.y} A${MARK.inner.r} ${MARK.inner.r} 0 1 1 ${MARK.inner.x - MARK.inner.r} ${MARK.inner.y} A${MARK.inner.r} ${MARK.inner.r} 0 0 1 ${MARK.inner.x + MARK.inner.r} ${MARK.inner.y} Z
    ${MARK.eyes
      .map(
        (eye) =>
          `M${eye.x + eye.r} ${eye.y} A${eye.r} ${eye.r} 0 1 1 ${eye.x - eye.r} ${eye.y} A${eye.r} ${eye.r} 0 0 1 ${eye.x + eye.r} ${eye.y} Z`,
      )
      .join('\n    ')}`;
  return `<!--
  SPDX-License-Identifier: AGPL-3.0-only
  Copyright (C) 2025 The 25-ji-code-de Team

  Nightcord favicon — 圆形紫底 + 月牙 mark（源：icons/nightcord-mark.svg v4）
  由 scripts/generate-icons.mjs 生成，勿手改。
-->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <circle cx="512" cy="512" r="512" fill="#99509A"/>
  <path fill="#ffffff" fill-rule="evenodd" d="${d}"/>
</svg>
`;
}

/** 全部产物：文件名 → { size, shape }。
 *  apple-touch-icon.png（180×180 液态玻璃稿）由设计提供，不走生成器，勿在此处覆盖。 */
export const OUTPUTS = {
  'favicon-32.png': { size: 32, shape: 'circle' },
  'icon-192.png': { size: 192, shape: 'circle' },
  'icon-512.png': { size: 512, shape: 'circle' },
  'icon-maskable-512.png': { size: 512, shape: 'square' },
};

export function generateAll() {
  const files = new Map();
  for (const [name, { size, shape }] of Object.entries(OUTPUTS)) {
    files.set(name, renderIcon(size, shape));
  }
  files.set('favicon.svg', Buffer.from(renderSvg(), 'utf8'));
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [name, data] of generateAll()) {
    writeFileSync(join(outDir, name), data);
    console.log(`icons/${name}  ${data.length} B`);
  }
}
