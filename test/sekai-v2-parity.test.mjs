/*
 * Copyright (C) 2025-2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * SEKAI v2 分词规则的一致性。
 *
 * 本仓此前有**三处各自实现**的「这段文本是不是一个 v2 token」判断：
 *
 *   sekai-renderer.js  tokenizeV2 —— 手写扫描器，按规范 §3.3 校验 Type
 *   ui-manager.js      markdown 保护路径的正则 —— 不校验 Type
 *   ui-manager.js      getPlainText 的正则 —— 同上
 *
 * 于是同一段文本在两条路径上被判成不同的东西：
 *
 *   <$SEKAI:123:x>   渲染器：Type 不以字母开头 → 畸形 → 按 §10.1 当纯文本显示
 *                    ui-manager：形状对上了 → 当作 token → 复制/引用时整段删掉
 *
 * 也就是**屏幕上看得见，复制不出来**（issue #2）。
 *
 * 修法是让 Type 的形状只有一个来源：`SekaiRenderer.V2_TYPE_SOURCE`。
 * 这批测试盯的就是"两条路径对同一段文本给出同一个答案"。
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

/**
 * 在 Node 里加载浏览器全局风格的脚本。
 *
 * 本仓的文件都以 `window.X = X` 结尾，没有模块系统。这里搭一个最小的
 * window 壳把它们跑起来 —— 只取需要的部分，不模拟 DOM。
 */
let SekaiRenderer;

before(() => {
  const src = read('sekai-renderer.js');
  const shim = {
    window: {},
    document: { createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }) },
    DOMPurify: undefined,
  };
  const fn = new Function(
    'window',
    'document',
    'DOMPurify',
    `${src}\nreturn window.SekaiRenderer;`,
  );
  SekaiRenderer = fn(shim.window, shim.document, shim.DOMPurify);
  assert.ok(SekaiRenderer, 'sekai-renderer.js 没有挂上 window.SekaiRenderer');
});

/** issue #2 里列的分歧用例，加几个正例。 */
const CASES = [
  // [输入, 渲染器是否认为它是合法 token]
  ['<$SEKAI:Stamp::stamp0042>', true],
  ['<$SEKAI:Format:enc=base64:aGk=>', true],
  ['<$SEKAI:X-Vendor:a=b:c>', true],
  ['<$SEKAI:123:x>', false],
  ['<$SEKAI::>', false],
  ['<$SEKAI:-Bad:x>', false],
  ['<$SEKAI:Stamp>', false],
];

/**
 * **仅仅因为 Type 不合规**而被拒的输入 —— 其余部分完全合规。
 *
 * issue #2 列的那 4 个用例其实都被**后续检查**兜住了，跟 Type 校验无关：
 *
 *   <$SEKAI:123:x>   只有一个冒号 → 被当成多行开标签 → 没有正文 → 拒
 *   <$SEKAI:Stamp>   Type 后面不是 ':' → 拒
 *   <$SEKAI::>       / <$SEKAI:-Bad:x>  同样会被后面拒掉
 *
 * 所以拿它们做「Type 校验有没有生效」的证据是不成立的 ——
 * 把 Type 校验整个删掉，这 4 个照样被拒。这是反向验证逼出来的：
 * 我第一版就是这么写的，破坏之后测试全绿。
 *
 * 下面这些才是真正的证据：`Type::payload>` 结构完全合规，只有 Type 不合规。
 */
const TYPE_ONLY_REJECTS = [
  '<$SEKAI:1Bad::payload>',
  '<$SEKAI:-Bad::payload>',
  '<$SEKAI:_x::payload>',
  '<$SEKAI:9::payload>',
  '<$SEKAI:a b::payload>',
];

describe('Type 的形状只有一个来源', () => {
  test('SekaiRenderer 对外暴露 V2_TYPE_SOURCE', () => {
    assert.equal(typeof SekaiRenderer.V2_TYPE_SOURCE, 'string');
    assert.ok(SekaiRenderer.V2_TYPE_SOURCE.length > 0);
  });

  test('它就是规范 §3.3 的 ALPHA *(ALPHA / DIGIT / "-")', () => {
    const re = new RegExp(`^(?:${SekaiRenderer.V2_TYPE_SOURCE})$`);
    for (const ok of ['Stamp', 'X-Vendor', 'A', 'a1-b2']) {
      assert.ok(re.test(ok), `${ok} 应当合法`);
    }
    for (const bad of ['', '123', '-Bad', '1A', '_x', 'a b']) {
      assert.ok(!re.test(bad), `${bad} 应当非法`);
    }
  });

  test('ui-manager 不再自己写 v2 token 正则', () => {
    /*
     * 直接扫源码：改回硬编码的 `<\$SEKAI:[^>\n]*>` 会让这条转红。
     * 只测行为的话，改回去也可能因为别的原因照样通过。
     */
    const src = read('ui-manager.js');
    const hardcoded = [...src.matchAll(/\/<\\\$SEKAI:\[\^[>\\n]+\]\*>/g)];
    assert.deepEqual(
      hardcoded.map((m) => m[0]),
      [],
      'ui-manager 里还有硬编码的 v2 token 正则',
    );
    assert.match(src, /SekaiRenderer\.V2_TYPE_SOURCE/, 'ui-manager 应当引用唯一来源');
  });
});

describe('两条路径对同一段文本给出同一个答案', () => {
  /** 渲染器认为整段文本是一个 token（而不是纯文本回退）。 */
  function rendererSaysToken(text) {
    const r = new SekaiRenderer({ useDOMPurify: false });
    const tokens = r.tokenizeV2(text);
    return tokens.length === 1 && tokens[0].type !== 'text';
  }

  /** ui-manager 的正则认为它是 token（这里按修复后的形状复现）。 */
  function uiManagerSaysToken(text) {
    const re = new RegExp(`<\\$SEKAI:${SekaiRenderer.V2_TYPE_SOURCE}:[^>\\n]*>`, 'g');
    const m = text.match(re);
    return !!m && m.length === 1 && m[0] === text;
  }

  for (const [input, expected] of CASES) {
    test(`${JSON.stringify(input)} → ${expected ? '合法 token' : '畸形，当纯文本'}`, () => {
      assert.equal(rendererSaysToken(input), expected, '渲染器的判断');
      assert.equal(uiManagerSaysToken(input), expected, 'ui-manager 的判断');
    });
  }

  for (const input of TYPE_ONLY_REJECTS) {
    test(`${JSON.stringify(input)} 仅因 Type 不合规被拒`, () => {
      // 结构完全合规（Type::payload>），唯一的问题就是 Type
      assert.equal(rendererSaysToken(input), false, '渲染器应当拒绝');
      assert.equal(uiManagerSaysToken(input), false, 'ui-manager 应当同样拒绝');

      // 换成合法 Type，同样的结构就该通过 —— 证明拒绝确实来自 Type
      const fixed = input.replace(/<\$SEKAI:[^:]*/, '<$SEKAI:Good');
      assert.equal(rendererSaysToken(fixed), true, `${fixed} 应当合法`);
    });
  }

  test('修复前的宽松正则会在这些用例上与渲染器分歧', () => {
    /*
     * 把旧正则放回来，确认它确实会误判 —— 否则上面那些用例可能
     * 只是碰巧通过，说明不了这次修复有意义。
     */
    const loose = /<\$SEKAI:[^>\n]*>/g;
    const diverged = CASES.filter(([input, expected]) => {
      const m = input.match(loose);
      const looseSaysToken = !!m && m.length === 1 && m[0] === input;
      return looseSaysToken !== expected;
    });
    assert.deepEqual(
      diverged.map(([i]) => i),
      ['<$SEKAI:123:x>', '<$SEKAI::>', '<$SEKAI:-Bad:x>', '<$SEKAI:Stamp>'],
      '旧正则应当在这 4 个用例上与渲染器不一致',
    );
  });
});

describe('畸形 token 按规范 §10.1 当纯文本', () => {
  for (const [input, isToken] of CASES) {
    if (isToken) continue;
    test(`${JSON.stringify(input)} 原样保留`, () => {
      const r = new SekaiRenderer({ useDOMPurify: false });
      const tokens = r.tokenizeV2(input);
      const rebuilt = tokens.map((t) => (t.type === 'text' ? t.content : null)).join('');
      assert.equal(rebuilt, input, '拼回来应当与原文逐字相同');
    });
  }
});
