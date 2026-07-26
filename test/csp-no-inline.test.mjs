/*
 * Nightcord - A modern, modular real-time chat application
 * Copyright (C) 2025 The 25-ji-code-de Team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * `script-src 'self'` 已进入**强制生效**的 CSP —— 全站不得再有内联脚本。
 *
 * ── 为什么要收紧 ────────────────────────────────────────────────
 *
 * `script-src` 带 `'unsafe-inline'` 时，`<img src=x onerror=…>` 这种注入进
 * `innerHTML` 的**内联事件处理器照样执行**。也就是说：刚修掉的那个用户名
 * XSS（见 `sekai-escape.js`），即使 CSP 从 Report-Only 转正也拦不住。
 *
 * 去掉 `'unsafe-inline'` 之后浏览器直接拒绝执行 —— 这是第二道防线。
 * 只有一道的话，下次谁在某个模板里漏了转义，就又是全通。
 *
 * ── 为什么这批测试必须存在 ──────────────────────────────────────
 *
 * 强制生效的 CSP 与代码之间没有任何自动关联：谁哪天在 index.html 里加一个
 * `<script>alert(1)</script>`，本地开发一切正常（本地没有 _headers），
 * 上线之后那段脚本被浏览器拒绝执行 —— **可能就是白屏，而且没人知道为什么**。
 *
 * 所以这里把 CSP 的四条前提逐条钉住。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const rawHtml = read('index.html');
/** 剥掉 HTML 注释 —— 注释掉的 <script> 不会执行，CSP 不管它。 */
const html = rawHtml.replace(/<!--[\s\S]*?-->/g, '');

/** 仓里所有自己写的 js（排除 vendored 的第三方）。 */
function ownScripts() {
  return execSync('git ls-files "*.js"', { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !/pangu|purify/.test(f))
    .filter((f) => !f.startsWith('test/'));
}

describe('_headers 里的 CSP', () => {
  const headers = read('_headers');
  const enforced = /\n\s*Content-Security-Policy:\s*([^\n]+)/.exec(headers)?.[1] ?? '';

  test('找得到强制生效的那条（否则下面几条是空跑）', () => {
    assert.ok(enforced, '_headers 里没有 Content-Security-Policy');
  });

  test('script-src 在强制生效那条里', () => {
    assert.match(enforced, /script-src 'self'/, 'script-src 还留在 Report-Only 里');
  });

  test('强制生效那条不含 unsafe-inline / unsafe-eval', () => {
    assert.doesNotMatch(enforced, /unsafe-inline/, "强制策略里还有 'unsafe-inline'");
    assert.doesNotMatch(enforced, /unsafe-eval/, "强制策略里有 'unsafe-eval'");
  });

  test('Report-Only 的 script-src 与强制那条一致', () => {
    // 两条不一致的话，Report-Only 收集到的违规与实际拦截的对不上
    const ro = /Content-Security-Policy-Report-Only:\s*([^\n]+)/.exec(headers)?.[1] ?? '';
    assert.ok(ro, '找不到 Report-Only 那条');
    assert.match(ro, /script-src 'self';/, 'Report-Only 的 script-src 仍带 unsafe-inline');
  });

  test('style-src 的 unsafe-inline 保留在 Report-Only 里（这是有意的）', () => {
    /*
     * style="" 属性还有若干处，且样式注入的危害远小于脚本注入。
     * 这条钉住「有意保留」这个决定，免得被当成漏改而顺手删掉 ——
     * 删了会让页面样式塌掉。
     */
    const ro = /Content-Security-Policy-Report-Only:\s*([^\n]+)/.exec(headers)?.[1] ?? '';
    assert.match(ro, /style-src 'self' 'unsafe-inline'/);
  });
});

describe('前提一：没有内联 <script> 块', () => {
  test('index.html 里所有 <script> 都带 src', () => {
    const inline = [];
    for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
      if (!/\bsrc\s*=/.test(m[1])) {
        const line = html.slice(0, m.index).split('\n').length;
        inline.push(`第 ${line} 行：<script${m[1]}>`);
      }
    }
    assert.deepEqual(
      inline,
      [],
      '内联 <script> 会被强制生效的 CSP 拒绝执行（很可能是白屏）：\n  ' + inline.join('\n  '),
    );
  });

  test('确实扫到了 script 标签（不是空跑）', () => {
    const all = [...html.matchAll(/<script\b/gi)].length;
    assert.ok(all >= 10, `只扫到 ${all} 个 <script>，正则多半写错了`);
  });

  test('启动脚本确实存在且被引入', () => {
    // 它是从内联块挪出来的；漏引的话页面什么都不会发生
    assert.match(html, /<script src="\/boot\.js"><\/script>/);
    assert.match(read('boot.js'), /new Nightcord\(\)/);
    assert.match(read('boot.js'), /nightcord\.init\(/);
  });
});

describe('前提二：没有内联事件处理器', () => {
  test('index.html 里没有 on*= 属性', () => {
    const found = [...html.matchAll(/\son([a-z]+)\s*=\s*["'][^"']*["']/gi)].map((m) => m[0].trim());
    assert.deepEqual(found, [], `这些内联处理器会被 CSP 拒绝：${found.join(', ')}`);
  });

  test('js 里没有用 setAttribute 绕过去写 on*', () => {
    // `el.setAttribute('onclick', …)` 与写在 HTML 里等价，同样被 CSP 拦
    for (const rel of ownScripts()) {
      const src = read(rel);
      const m = /setAttribute\(\s*['"`]on[a-z]+['"`]/i.exec(src);
      assert.equal(m, null, `${rel} 用 setAttribute 写了内联处理器：${m?.[0]}`);
    }
  });

  test('模板字符串里没有拼出 on*= 处理器', () => {
    /*
     * 拼进 innerHTML 的 `<button onclick="...">` 同样是内联处理器。
     * 这是最容易漏的一种 —— 它不在 HTML 文件里，grep index.html 看不见。
     */
    const bad = [];
    for (const rel of ownScripts()) {
      const src = read(rel);
      for (const m of src.matchAll(/\son(click|error|load|change|input|submit|mouseover)\s*=\s*["'][^"']/gi)) {
        bad.push(`${rel}:${src.slice(0, m.index).split('\n').length}  ${m[0].trim()}`);
      }
    }
    assert.deepEqual(bad, [], '这些拼出来的内联处理器会被 CSP 拒绝：\n  ' + bad.join('\n  '));
  });
});

describe('前提三：没有 eval 一类的动态求值', () => {
  test('没有 eval / new Function / 字符串形式的 setTimeout', () => {
    const bad = [];
    for (const rel of ownScripts()) {
      const src = read(rel);
      for (const m of src.matchAll(/\beval\(|new Function\(|set(Timeout|Interval)\(\s*['"`]/g)) {
        bad.push(`${rel}:${src.slice(0, m.index).split('\n').length}  ${m[0]}`);
      }
    }
    assert.deepEqual(bad, [], "这些需要 'unsafe-eval'：\n  " + bad.join('\n  '));
  });

  test('确实扫到了文件（不是空跑）', () => {
    assert.ok(ownScripts().length >= 8, `只扫到 ${ownScripts().length} 个 js 文件`);
  });
});

describe('前提四：所有脚本都是同源的', () => {
  test('没有跨域的 <script src>', () => {
    const external = [...html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/gi)]
      .map((m) => m[1])
      .filter((src) => !src.startsWith('/'));
    assert.deepEqual(
      external,
      [],
      `script-src 'self' 会拒绝这些跨域脚本：${external.join(', ')}`,
    );
  });

  test('没有动态创建 script 元素', () => {
    for (const rel of ownScripts()) {
      assert.doesNotMatch(
        read(rel),
        /createElement\(\s*['"`]script['"`]/i,
        `${rel} 动态创建了 script —— 来源要确认是同源`,
      );
    }
  });
});
