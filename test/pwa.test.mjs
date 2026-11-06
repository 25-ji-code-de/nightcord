/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import { inflateSync } from 'node:zlib';

import { generateAll } from '../scripts/generate-icons.mjs';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const read = (path) => readFileSync(join(root, path), 'utf8');

/** 从 sw.js 中取出 PRECACHE；handler 里的 caches/fetch 不会被执行。 */
function loadPrecache() {
  const source = read('sw.js');
  const sandbox = {
    self: { addEventListener() {} },
    console,
  };
  vm.runInNewContext(`${source}\n;globalThis.__precache = PRECACHE;`, sandbox);
  return sandbox.__precache;
}

/** 读取 PNG 的 IHDR 宽高。 */
function pngSize(path) {
  const buf = readFileSync(join(root, path));
  assert.equal(buf.toString('ascii', 1, 4), 'PNG', `${path} 不是 PNG`);
  assert.equal(buf.toString('ascii', 12, 16), 'IHDR', `${path} 缺少 IHDR`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const decoded = new Map();

/** 解出 8 位 RGBA PNG 的像素，支持全部五种行过滤器。 */
function pngDecode(path) {
  if (decoded.has(path)) return decoded.get(path);
  const buf = readFileSync(join(root, path));
  assert.equal(buf.toString('ascii', 1, 4), 'PNG', `${path} 不是 PNG`);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  assert.equal(buf[24], 8, `${path} 应为 8 位色深`);
  assert.equal(buf[25], 6, `${path} 应为 RGBA`);

  const idat = [];
  for (let off = 8; off < buf.length; ) {
    const length = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + length));
    off += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const data = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base];
    const line = raw.subarray(base + 1, base + 1 + stride);
    const cur = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev ? prev[i] : 0;
      const upLeft = prev && i >= bpp ? prev[i - bpp] : 0;
      let value = line[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      else assert.equal(filter, 0, `${path} 未知 filter ${filter}`);
      cur[i] = value & 0xff;
    }
  }

  const image = { width, height, data };
  decoded.set(path, image);
  return image;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function pngPixel(path, x, y) {
  const { width, data } = pngDecode(path);
  const offset = (y * width + x) * 4;
  return [...data.subarray(offset, offset + 4)];
}

/** 四个角坐标。 */
function corners(path) {
  const { width, height } = pngDecode(path);
  return [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];
}

const manifest = JSON.parse(read('manifest.json'));
const html = read('index.html');

describe('PWA manifest', () => {
  test('声明了安装所需字段', () => {
    assert.equal(manifest.id, '/');
    assert.equal(manifest.name, 'Nightcord');
    assert.equal(manifest.short_name, 'Nightcord');
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.lang, 'zh-CN');
    assert.equal(manifest.theme_color, '#50476a');
    assert.equal(manifest.background_color, '#50476a');
  });

  test('图标尺寸与 manifest 声明一致', () => {
    const icons = manifest.icons || [];
    const byPurpose = (purpose) => icons.filter((icon) => icon.purpose === purpose);
    const any = byPurpose('any');
    assert.ok(any.some((icon) => icon.sizes === '192x192'), '缺少 192 图标');
    assert.ok(any.some((icon) => icon.sizes === '512x512'), '缺少 512 图标');
    assert.ok(byPurpose('maskable').some((icon) => icon.sizes === '512x512'), '缺少 maskable 图标');

    for (const icon of icons) {
      assert.match(icon.src, /^\/icons\//);
      assert.equal(icon.type, 'image/png');
      const file = icon.src.replace(/^\//, '');
      assert.ok(existsSync(join(root, file)), `${file} 不存在`);
      const [width, height] = icon.sizes.split('x').map(Number);
      assert.deepEqual(pngSize(file), { width, height }, `${file} 尺寸与 sizes 不符`);
    }
  });

  test('apple-touch-icon 为 180×180', () => {
    assert.deepEqual(pngSize('icons/apple-touch-icon.png'), { width: 180, height: 180 });
  });
});

describe('图标形状', () => {
  test('any 图标用圆形底，四角透明', () => {
    for (const path of ['icons/favicon-32.png', 'icons/icon-192.png', 'icons/icon-512.png']) {
      const { width, height } = pngDecode(path);
      for (const [x, y] of corners(path)) {
        assert.equal(pngPixel(path, x, y)[3], 0, `${path} (${x},${y}) 应透明：默认图标必须是圆形`);
      }
      assert.equal(pngPixel(path, width >> 1, height >> 1)[3], 255, `${path} 圆心应不透明`);
    }
  });

  test('maskable 为满幅方形，圆角交给系统遮罩', () => {
    const path = 'icons/icon-maskable-512.png';
    for (const [x, y] of corners(path)) {
      assert.deepEqual(pngPixel(path, x, y), [153, 80, 154, 255], `${path} (${x},${y}) 应为满幅紫底`);
    }
  });

  test('apple-touch 为满幅不透明的液态玻璃稿', () => {
    const path = 'icons/apple-touch-icon.png';
    const [first, ...rest] = corners(path).map(([x, y]) => pngPixel(path, x, y));
    assert.equal(first[3], 255, '四角必须不透明，圆角交给 iOS 遮罩');
    for (const corner of rest) {
      assert.deepEqual(corner.slice(0, 3), first.slice(0, 3), '底色应均匀');
    }
  });

  test('favicon.svg 与 PNG 同源（圆形底）', () => {
    const svg = read('icons/favicon.svg');
    assert.match(svg, /<circle cx="24" cy="24" r="24" fill="#99509A"\/>/);
    assert.doesNotMatch(svg, /<rect/);
  });

  test('磁盘上的图标与 scripts/generate-icons.mjs 生成结果一致', () => {
    for (const [name, expected] of generateAll()) {
      const actual = readFileSync(join(root, 'icons', name));
      // Windows 检出的 SVG 是 CRLF，比较前统一换行
      const same = name.endsWith('.svg')
        ? actual.toString('utf8').replace(/\r\n/g, '\n') === expected.toString('utf8')
        : actual.equals(expected);
      assert.ok(same, `icons/${name} 已过期，请运行 node scripts/generate-icons.mjs`);
    }
  });
});

describe('index.html PWA 声明', () => {
  test('manifest 与图标链接', () => {
    assert.match(html, /<link rel="manifest" href="\/manifest\.json">/);
    assert.match(html, /<link rel="icon" href="\/icons\/favicon\.svg" type="image\/svg\+xml">/);
    assert.match(html, /<link rel="icon" href="\/icons\/favicon-32\.png" sizes="32x32" type="image\/png">/);
    assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png" sizes="180x180">/);
  });

  test('iOS 独立窗口 meta', () => {
    assert.match(html, /<meta name="mobile-web-app-capable" content="yes">/);
    assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
    assert.match(html, /<meta name="apple-mobile-web-app-title" content="Nightcord">/);
    assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black">/);
    assert.doesNotMatch(html, /black-translucent/);
    assert.match(html, /<meta name="theme-color" content="#50476a">/);
    assert.doesNotMatch(html, /viewport-fit=cover/);
  });

  test('pwa.js 在 version-checker.js 之前加载', () => {
    const pwaAt = html.indexOf('<script src="/pwa.js"></script>');
    const checkerAt = html.indexOf('<script src="/version-checker.js"></script>');
    assert.ok(pwaAt > -1, '缺少 pwa.js');
    assert.ok(checkerAt > -1, '缺少 version-checker.js');
    assert.ok(pwaAt < checkerAt, 'pwa.js 必须先于 version-checker.js');
  });
});

describe('Service Worker 预缓存', () => {
  const precache = loadPrecache();

  test('包含应用外壳，且不含禁止缓存的资源', () => {
    assert.ok(precache.includes('/'), '必须预缓存 /（/index.html 会 308）');
    for (const forbidden of ['/index.html', '/sw.js', '/version.json']) {
      assert.ok(!precache.includes(forbidden), `不应预缓存 ${forbidden}`);
    }
    for (const path of precache) {
      assert.match(path, /^\//, `${path} 必须是同源绝对路径`);
      assert.doesNotMatch(path, /^\/se_/, '音频不预缓存');
    }
  });

  test('无重复项', () => {
    assert.equal(new Set(precache).size, precache.length);
  });

  test('每个预缓存路径都能在磁盘上找到', () => {
    for (const path of precache) {
      const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
      assert.ok(existsSync(join(root, file)), `${path} 在仓库中不存在（SPA 回退会返回 HTML 而不报错）`);
    }
  });

  test('覆盖 index.html 中的全部本地脚本与样式', () => {
    const assets = new Set();
    for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
      assets.add(match[1]);
    }
    for (const match of html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)) {
      assets.add(match[1]);
    }
    assert.ok(assets.size > 20, 'index.html 资源解析异常');
    for (const asset of assets) {
      assert.ok(precache.includes(asset), `${asset} 没有加入 PRECACHE`);
    }
  });
});

describe('Service Worker 缓存策略', () => {
  const source = read('sw.js');

  test('放行版本检查、API、Range、音频、no-store', () => {
    assert.match(source, /url\.pathname === '\/version\.json'/);
    assert.match(source, /startsWith\('\/api\/'\)/);
    assert.match(source, /headers\.has\('range'\)/);
    assert.match(source, /destination === 'audio'/);
    assert.match(source, /request\.cache === 'no-store'/);
    assert.match(source, /url\.origin !== self\.location\.origin/);
  });

  test('install 不自动 skipWaiting，只有消息才激活新 SW', () => {
    const installAt = source.indexOf("addEventListener('install'");
    const activateAt = source.indexOf("addEventListener('activate'");
    assert.ok(installAt > -1 && activateAt > installAt);
    assert.doesNotMatch(source.slice(installAt, activateAt), /skipWaiting/);
    assert.match(source, /data\.type === 'SKIP_WAITING'/);
    assert.match(source, /clients\.claim\(\)/);
  });

  test('写入缓存前校验 Content-Type（防 SPA 回退污染）', () => {
    assert.match(source, /isCacheable\(/);
    assert.match(source, /content-type/);
  });
});

describe('pwa.js 与 version-checker 的衔接', () => {
  test('pwa.js 注册根作用域 SW', () => {
    const source = read('pwa.js');
    assert.match(source, /register\('\/sw\.js', \{ scope: '\/', updateViaCache: 'none' \}\)/);
    assert.match(source, /activatePendingUpdate/);
    assert.match(source, /SKIP_WAITING/);
  });

  test('version-checker 仍以 no-store 轮询，并优先走 PWA 刷新入口', () => {
    const source = read('version-checker.js');
    assert.match(source, /cache: 'no-store'/);
    assert.match(source, /NightcordPWA/);
    assert.match(source, /activatePendingUpdate/);
    assert.match(source, /location\.reload\(\)/);
  });
});
