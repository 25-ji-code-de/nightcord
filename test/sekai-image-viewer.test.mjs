/*
 * Copyright (C) 2025-2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../sekai-image-viewer.js', import.meta.url), 'utf8');

class Element {
  constructor(tagName = 'DIV') {
    this.tagName = tagName;
    this.style = {};
    this.listeners = new Map();
    this.children = new Map();
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name)
    };
  }

  appendChild() {}
  closest() { return null; }

  querySelector(selector) {
    if (!this.children.has(selector)) {
      this.children.set(selector, new Element(selector === '.sekai-viewer-image' ? 'IMG' : 'DIV'));
    }
    return this.children.get(selector);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1000, height: 800 };
  }

  dispatch(type, properties = {}) {
    const event = {
      target: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
      ...properties
    };
    for (const handler of this.listeners.get(type) || []) handler(event);
    return event;
  }
}

const point = (x = 500, y = 400, identifier = 0) => ({ clientX: x, clientY: y, identifier });

function createFixture() {
  let now = 1700000000000;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const document = new Element();
  document.body = new Element('BODY');
  document.createElement = tag => new Element(tag.toUpperCase());
  const window = new Element();
  vm.runInNewContext(source, {
    window, document, URL, Date: ClockDate,
    setTimeout: () => 1,
    clearTimeout() {}
  });
  const viewer = window.sekaiImageViewer;
  viewer.open('https://example.test/image.png');

  function emit(type, touches, changedTouches = touches) {
    return viewer.container.dispatch(type, { touches, changedTouches, target: viewer.image });
  }

  function advance(ms) { now += ms; }

  function tap(x = 500, y = 400) {
    emit('touchstart', [point(x, y)]);
    advance(40);
    return emit('touchend', [], [point(x, y)]);
  }

  function doubleTap() {
    tap();
    advance(100);
    return tap();
  }

  function mouse(type, properties = {}) {
    return viewer.container.dispatch(type, { target: viewer.image, clientX: 500, clientY: 400, ...properties });
  }

  return { viewer, emit, advance, tap, doubleTap, mouse };
}

describe('image viewer touch and mouse gestures', () => {
  test('touch double tap zooms once and cancels the browser default', () => {
    const { viewer, doubleTap } = createFixture();
    const event = doubleTap();
    assert.equal(viewer.scale, 2.5);
    assert.equal(event.defaultPrevented, true);
  });

  test('a compatibility mouse double click cannot undo a touch double tap', () => {
    const { viewer, doubleTap, mouse } = createFixture();
    doubleTap();
    mouse('mousedown', { sourceCapabilities: { firesTouchEvents: true } });
    assert.equal(viewer.isDragging, false);
    mouse('dblclick', { sourceCapabilities: { firesTouchEvents: true } });
    assert.equal(viewer.scale, 2.5);
  });

  test('compatibility double clicks are ignored when sourceCapabilities is unavailable', () => {
    const { viewer, doubleTap, mouse, advance } = createFixture();
    doubleTap();
    advance(100);
    mouse('dblclick');
    assert.equal(viewer.scale, 2.5);
  });

  test('a second touch double tap resets a zoomed image', () => {
    const { viewer, doubleTap, advance } = createFixture();
    doubleTap();
    advance(500);
    doubleTap();
    assert.equal(viewer.scale, 1);
  });

  test('small finger jitter does not turn a zoomed double tap into a drag', () => {
    const { viewer, tap, emit, advance } = createFixture();
    viewer.setScale(2.5);
    tap();
    advance(100);
    emit('touchstart', [point()]);
    emit('touchmove', [point(503, 402)]);
    advance(40);
    emit('touchend', [], [point(503, 402)]);
    assert.equal(viewer.scale, 1);
  });

  test('desktop double clicks still toggle zoom', () => {
    const { viewer, mouse } = createFixture();
    mouse('dblclick');
    assert.equal(viewer.scale, 2.5);
    mouse('dblclick');
    assert.equal(viewer.scale, 1);
  });

  test('an identified real mouse works immediately after touch input', () => {
    const { viewer, doubleTap, mouse } = createFixture();
    doubleTap();
    mouse('dblclick', { sourceCapabilities: { firesTouchEvents: false } });
    assert.equal(viewer.scale, 1);
  });

  test('mouse double clicks work after the compatibility event window', () => {
    const { viewer, doubleTap, mouse, advance } = createFixture();
    doubleTap();
    advance(1000);
    mouse('dblclick');
    assert.equal(viewer.scale, 1);
  });

  test('a swipe returning to its starting point cannot count as a tap', () => {
    const { viewer, tap, emit, advance } = createFixture();
    tap();
    advance(100);
    emit('touchstart', [point()]);
    emit('touchmove', [point(600)]);
    emit('touchmove', [point()]);
    emit('touchend', [], [point()]);
    assert.equal(viewer.scale, 1);
  });

  test('a long press followed by one tap cannot trigger double tap zoom', () => {
    const { viewer, tap, emit, advance } = createFixture();
    emit('touchstart', [point()]);
    advance(800);
    emit('touchend', [], [point()]);
    tap();
    assert.equal(viewer.scale, 1);
  });

  test('pinch zoom stays in place when both fingers lift', () => {
    const { viewer, emit } = createFixture();
    emit('touchstart', [point(450)]);
    emit('touchstart', [point(450), point(550, 400, 1)]);
    emit('touchmove', [point(400), point(600, 400, 1)]);
    emit('touchend', [point(400)], [point(600, 400, 1)]);
    emit('touchend', [], [point(400)]);
    assert.equal(viewer.scale, 2);
  });

  test('a delayed final pinch release cannot become the first half of a double tap', () => {
    const { viewer, emit, advance, tap } = createFixture();
    emit('touchstart', [point()]);
    emit('touchstart', [point(), point(600, 400, 1)]);
    emit('touchmove', [point(450), point(650, 400, 1)]);
    emit('touchmove', [point(), point(600, 400, 1)]);
    emit('touchend', [point()], [point(600, 400, 1)]);
    advance(500);
    emit('touchend', [], [point()]);
    tap();
    assert.equal(viewer.scale, 1);
  });

  test('pinch zoom follows the moving midpoint', () => {
    const { viewer, emit } = createFixture();
    viewer.setScale(2);
    emit('touchstart', [point(450), point(550, 400, 1)]);
    emit('touchmove', [point(550), point(750, 400, 1)]);
    assert.equal(viewer.scale, 4);
    assert.equal(viewer.translateX, 150);
  });

  test('both fingers can pan without changing their distance', () => {
    const { viewer, emit } = createFixture();
    viewer.setScale(2);
    emit('touchstart', [point(450), point(550, 400, 1)]);
    emit('touchmove', [point(500), point(600, 400, 1)]);
    assert.equal(viewer.scale, 2);
    assert.equal(viewer.translateX, 50);
  });

  test('the remaining finger can drag immediately after a pinch', () => {
    const { viewer, emit } = createFixture();
    viewer.setScale(2);
    emit('touchstart', [point(450), point(550, 400, 1)]);
    emit('touchmove', [point(400), point(600, 400, 1)]);
    emit('touchend', [point(400)], [point(600, 400, 1)]);
    const before = viewer.translateX;
    emit('touchmove', [point(460)]);
    assert.equal(viewer.translateX - before, 60);
  });

  test('a cancelled pinch does not swallow the next double tap', () => {
    const { viewer, emit, doubleTap } = createFixture();
    emit('touchstart', [point(450), point(550, 400, 1)]);
    emit('touchcancel', [], [point(450), point(550, 400, 1)]);
    doubleTap();
    assert.equal(viewer.scale, 2.5);
  });

  test('reopening the viewer clears a pending tap', () => {
    const { viewer, tap } = createFixture();
    tap();
    viewer.close();
    viewer.open('https://example.test/another.png');
    tap();
    assert.equal(viewer.scale, 1);
  });
});
