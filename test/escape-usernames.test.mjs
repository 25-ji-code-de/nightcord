/*
 * Nightcord - A modern, modular real-time chat application
 * Copyright (C) 2025 The 25-ji-code-de Team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * 用户名不得原样进 innerHTML。
 *
 * ── 这批测试的由来 ──────────────────────────────────────────────
 *
 * 消息正文一直是安全的：渲染前过 `DOMPurify.sanitize`，作者名用
 * `textContent` 写。但**用户名**在另外两处是拼进 `innerHTML` 的：
 *
 *     ui-manager.js      语音成员列表   <span ...>${user.name}</span>
 *     ui-autocomplete.js @ 补全列表     <div data-name="${u.name}">
 *
 * 名字来自 SEKAI Pass 的 `name` / `preferred_username` claim，
 * 而 Pass 那边只校验长度（`validateDisplayName`，≤ 50 字符）。
 * `"><img src=x onerror=alert(1)>` 是 29 个字符。
 *
 * 补全那处更糟：载荷会闭合 `data-name="`，直接逃出属性上下文。
 *
 * ── 方法 ────────────────────────────────────────────────────────
 *
 * 不手抄模板。从源文件里**原样抠出**那几段模板字面量求值 —— 我手抄正则
 * 出过事（storage-worker 那次把 U+00A0 抄成普通空格，得出一个看起来很像
 * 真的但不存在的漏洞），从此探针的输入一律来自文件本身。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

/** 与 sekai-escape.js 里那份等价的实现，用来给抠出来的模板求值。 */
function loadEscapeHtml() {
  const src = read('sekai-escape.js');
  const global = {};
  new Function('window', src)(global);
  assert.equal(typeof global.escapeHtml, 'function', 'sekai-escape.js 没有挂上 escapeHtml');
  return global.escapeHtml;
}

/**
 * 从源码里抠出含 `anchor` 的那段模板字面量并求值。
 *
 * 注意要**往前**找起始反引号 —— anchor 在模板内部。第一版写成往后找，
 * 抠到的是结束反引号之后的一段代码，于是「没注入」是假阴性。
 * 下面那条断言就是为了挡住这种情况。
 */
function evalTemplate(source, anchor, vars, thisArg = null) {
  const at = source.indexOf(anchor);
  assert.ok(at !== -1, `源码里找不到锚点：${anchor}`);

  const start = source.lastIndexOf('`', at);
  assert.ok(start !== -1, '往前找不到模板起始反引号');

  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === '`') break;
    i++;
  }
  const body = source.slice(start, i + 1);
  assert.ok(
    body.includes(anchor),
    `抠出来的模板不含锚点，这次求值无效：\n${body.slice(0, 120)}`,
  );

  const names = Object.keys(vars);
  const fn = new Function('escapeHtml', ...names, `return ${body};`);
  return fn.call(thisArg, loadEscapeHtml(), ...names.map((n) => vars[n]));
}

/** 逃逸载荷：闭合属性 + 起一个会执行的标签。 */
const PAYLOAD = '"><img src=x onerror=alert(1)>';

describe('sekai-escape.js', () => {
  const escapeHtml = loadEscapeHtml();

  test('五个字符都覆盖', () => {
    assert.equal(
      escapeHtml(`&<>"'`),
      '&amp;&lt;&gt;&quot;&#39;',
    );
  });

  test('`&` 最先替换，实体不会被二次转义', () => {
    // 若 & 放在最后，`<` 会先变成 `&lt;`，再被转成 `&amp;lt;`
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  });

  test('null / undefined 变空串，不渲染出字面量 "undefined"', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });

  test('非字符串照样处理', () => {
    assert.equal(escapeHtml(42), '42');
    assert.equal(escapeHtml(false), 'false');
  });

  test('普通名字不被改动', () => {
    assert.equal(escapeHtml('ナギ'), 'ナギ');
    assert.equal(escapeHtml('K-2024'), 'K-2024');
  });
});

describe('语音成员列表（ui-manager.js）', () => {
  const src = read('ui-manager.js');

  test('恶意昵称不会注入标记', () => {
    const html = evalTemplate(src, 'class="voice-user-info"', {
      user: { name: PAYLOAD, avatar: 'A', color: 'c1' },
    });
    assert.ok(
      !html.includes('<img src=x onerror=alert(1)>'),
      `载荷原样进入了 HTML：\n${html}`,
    );
    assert.ok(html.includes('&lt;img'), '没有看到转义后的形式');
  });

  test('正常昵称照常显示', () => {
    const html = evalTemplate(src, 'class="voice-user-info"', {
      user: { name: 'ナギ', avatar: 'ナ', color: 'c3' },
    });
    assert.ok(html.includes('ナギ'), '正常名字被弄丢了');
    assert.ok(html.includes('class="avatar c3"'), '颜色类被弄丢了');
  });
});

describe('@ 补全列表（ui-autocomplete.js）', () => {
  const src = read('ui-autocomplete.js');

  test('恶意昵称不会逃出 data-name 属性', () => {
    const html = evalTemplate(src, 'class="mention-item" data-name=', {
      u: { name: PAYLOAD, avatar: 'A', color: 'c1', status: 'online' },
    });
    assert.ok(
      !html.includes('<img src=x onerror=alert(1)>'),
      `载荷原样进入了 HTML：\n${html}`,
    );
    assert.doesNotMatch(
      html.replace(/\s+/g, ' '),
      /data-name="[^"]*"><img/,
      '载荷闭合了 data-name 属性',
    );
  });

  test('正常昵称仍然进得了 data-name（补全功能不能坏）', () => {
    const html = evalTemplate(src, 'class="mention-item" data-name=', {
      u: { name: 'ナギ', avatar: 'ナ', color: 'c1', status: 'online' },
    });
    assert.match(html, /data-name="ナギ"/);
  });

  test('贴纸项也转义（数据来自远端 JSON）', () => {
    const html = evalTemplate(src, 'class="mention-item sticker-autocomplete-item"', {
      s: { code: PAYLOAD, url: PAYLOAD, label: PAYLOAD, category: PAYLOAD },
    }, { getCategoryLabel: (category) => category });
    assert.ok(
      !html.includes('<img src=x onerror=alert(1)>'),
      `载荷原样进入了 HTML：\n${html}`,
    );
  });
});

describe('加载顺序', () => {
  /*
   * escapeHtml 是全局函数，脚本标签排在用它的脚本之后的话，
   * 页面会在渲染成员列表时抛 ReferenceError —— 列表整个不出来。
   * 这不是静默失败，但也不该发生。
   */
  const html = read('index.html');

  test('sekai-escape.js 排在所有使用者之前', () => {
    const at = (f) => html.indexOf(`/${f}"`);
    const escapeAt = at('sekai-escape.js');
    assert.ok(escapeAt >= 0, 'index.html 没有引入 sekai-escape.js');
    for (const consumer of ['ui-manager.js', 'ui-autocomplete.js']) {
      const c = at(consumer);
      assert.ok(c >= 0, `index.html 没有引入 ${consumer}`);
      assert.ok(escapeAt < c, `sekai-escape.js 必须排在 ${consumer} 之前`);
    }
  });
});

describe('没有新的裸用户名插值', () => {
  /*
   * 上面几条盯的是已知的几处。这条扫全仓，防止以后新写的模板又漏。
   */
  const NAMEY = /\b(user\.name|u\.name|msg\.user|username|displayName)\b/;
  const FILES = ['ui-manager.js', 'ui-autocomplete.js', 'sekai-renderer.js', 'nightcord.js'];

  for (const file of FILES) {
    test(file, () => {
      const src = read(file);
      const bad = [];

      for (let i = 0; i < src.length; i++) {
        if (src[i] !== '`' || (i > 0 && src[i - 1] === '\\')) continue;
        let j = i + 1;
        const interps = [];
        while (j < src.length) {
          if (src[j] === '\\') {
            j += 2;
            continue;
          }
          if (src[j] === '`') break;
          if (src[j] === '$' && src[j + 1] === '{') {
            let d = 1;
            let k = j + 2;
            while (k < src.length && d > 0) {
              if (src[k] === '{') d++;
              else if (src[k] === '}') d--;
              if (d === 0) break;
              k++;
            }
            interps.push({ expr: src.slice(j + 2, k).replace(/\s+/g, ' ').trim(), at: j });
            j = k + 1;
            continue;
          }
          j++;
        }
        const body = src.slice(i + 1, j);
        if (/<[a-zA-Z/]/.test(body)) {
          for (const it of interps) {
            if (!NAMEY.test(it.expr)) continue;
            if (/escapeHtml\(|DOMPurify\.sanitize\(/.test(it.expr)) continue;
            bad.push(`第 ${src.slice(0, it.at).split('\n').length} 行：\${${it.expr.slice(0, 60)}}`);
          }
        }
        i = j;
      }

      assert.deepEqual(bad, [], `${file} 里有裸的用户名插值：\n  ${bad.join('\n  ')}`);
    });
  }

  test('扫描器确实在工作（不是空跑）', () => {
    // ui-autocomplete.js 里现在应当有若干处**已转义**的 u.name
    const src = read('ui-autocomplete.js');
    const escaped = [...src.matchAll(/escapeHtml\(u\.name\)/g)].length;
    assert.ok(escaped >= 2, `只找到 ${escaped} 处 escapeHtml(u.name)，扫描目标可能已改名`);
  });
});
