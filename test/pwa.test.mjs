/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import vm from 'node:vm';

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
