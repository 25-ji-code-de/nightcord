/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025-2026 The 25-ji-code-de Team
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

class SimpleEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) || []) fn(event);
  }
}

class FakeBlob extends Blob {
  constructor(size, type = 'application/octet-stream') {
    super(['x'], { type });
    this.fakeSize = size;
  }

  get size() {
    return this.fakeSize;
  }

  slice(start, end) {
    return new FakeBlob(Math.max(0, end - start), this.type);
  }
}

class FakeXMLHttpRequest {
  static calls = [];
  static responses = [];

  constructor() {
    this.upload = new SimpleEventTarget();
    this.events = new SimpleEventTarget();
    this.headers = {};
    this.status = 0;
    this.responseText = '';
    this.responseHeaders = {};
    this.timeout = 0;
  }

  addEventListener(type, fn) {
    this.events.addEventListener(type, fn);
  }

  open(method, url) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name, value) {
    this.headers[name] = value;
  }

  getResponseHeader(name) {
    const lower = String(name).toLowerCase();
    for (const [key, value] of Object.entries(this.responseHeaders)) {
      if (key.toLowerCase() === lower) return value;
    }
    return null;
  }

  send(body) {
    FakeXMLHttpRequest.calls.push({ method: this.method, url: this.url, headers: this.headers, body });
    const next = FakeXMLHttpRequest.responses.shift() || { status: 204 };
    setImmediate(() => {
      const total = typeof body?.size === 'number' ? body.size : 1;
      this.upload.dispatch('progress', { lengthComputable: true, loaded: total, total });
      this.upload.dispatch('load');
      this.status = next.status;
      this.responseText = next.body === undefined ? '' : JSON.stringify(next.body);
      this.responseHeaders = next.headers || {};
      this.events.dispatch('load');
    });
  }
}

function loadService(fetchImpl) {
  const sandbox = {
    Blob,
    FormData,
    XMLHttpRequest: FakeXMLHttpRequest,
    console,
    fetch: fetchImpl,
    setImmediate,
    setInterval,
    clearInterval,
    Error,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    String,
    URL,
    window: {},
  };
  vm.runInNewContext(readFileSync(join(root, 'file-upload-service.js'), 'utf8'), sandbox, {
    filename: 'file-upload-service.js',
  });
  return sandbox.window.FileUploadService;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  FakeXMLHttpRequest.calls = [];
  FakeXMLHttpRequest.responses = [];
});

describe('FileUploadService upload endpoint selection', () => {
  test('uses direct init, upload gateway POST, and complete for normal files', async () => {
    const fetchCalls = [];
    const FileUploadService = loadService(async (url, init) => {
      fetchCalls.push({ url: String(url), init, body: JSON.parse(init.body) });
      if (String(url).endsWith('/v2/upload/init')) {
        return jsonResponse({
          uuid: '11111111-1111-4111-8111-111111111111',
          upload: {
            url: 'https://upload.example.com/',
            method: 'POST',
            fields: { key: 'AttachFiles/sekai/u1', policy: 'P' },
          },
          complete_token: 'COMPLETE',
        });
      }
      if (String(url).endsWith('/v2/upload/complete')) {
        return jsonResponse({
          uuid: '11111111-1111-4111-8111-111111111111',
          type: 'image/png',
          size: 1,
          name: 'photo.png',
          kind: 'image',
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    FakeXMLHttpRequest.responses.push({ status: 204 });

    const service = new FileUploadService({ baseUrl: 'https://storage.example.com' });
    const progress = [];
    const result = await service.upload(new FakeBlob(1024, 'image/png'), 'photo.png', (p) => progress.push(p), {
      kind: 'image',
      w: 640,
      h: 360,
    });

    assert.equal(result.key, result.uuid);
    assert.deepEqual(fetchCalls.map((call) => new URL(call.url).pathname), [
      '/v2/upload/init',
      '/v2/upload/complete',
    ]);
    assert.equal(fetchCalls[0].body.kind, 'image');
    assert.equal(fetchCalls[0].body.w, 640);
    assert.equal(FakeXMLHttpRequest.calls[0].method, 'POST');
    assert.equal(FakeXMLHttpRequest.calls[0].url, 'https://upload.example.com/');
    assert.equal(progress.at(-1), 100);
  });

  test('uses multipart for files above the single direct-upload ceiling', async () => {
    const fetchCalls = [];
    const FileUploadService = loadService(async (url, init) => {
      const body = JSON.parse(init.body);
      fetchCalls.push({ url: String(url), init, body });
      const path = new URL(String(url)).pathname;
      if (path === '/v2/upload/multipart/init') {
        assert.equal(init.headers.Authorization, 'Bearer AT');
        return jsonResponse({
          uuid: '22222222-2222-4222-8222-222222222222',
          part_size: 500000000,
          part_count: 2,
          recommended_concurrency: 2,
          multipart_token: 'MULTIPART',
        });
      }
      if (path === '/v2/upload/multipart/parts') {
        assert.deepEqual(body.part_numbers, [1, 2]);
        return jsonResponse({
          parts: body.part_numbers.map((partNumber) => ({
            part_number: partNumber,
            upload: { method: 'PUT', url: `https://upload.example.com/part-${partNumber}` },
          })),
        });
      }
      if (path === '/v2/upload/multipart/complete') {
        assert.deepEqual(body.parts, [
          { part_number: 1, etag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' },
          { part_number: 2, etag: '"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' },
        ]);
        return jsonResponse({
          uuid: '22222222-2222-4222-8222-222222222222',
          type: 'application/octet-stream',
          size: 819200.1,
          name: 'large.bin',
          kind: 'file',
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    FakeXMLHttpRequest.responses.push(
      { status: 200, headers: { ETag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' } },
      { status: 200, headers: { ETag: '"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' } },
    );

    const service = new FileUploadService({
      baseUrl: 'https://storage.example.com',
      getAccessToken: async () => 'AT',
    });
    const file = new FakeBlob(FileUploadService.DIRECT_UPLOAD_MAX_BYTES + 1);
    const progress = [];
    const result = await service.upload(file, 'large.bin', (p) => progress.push(p), { kind: 'file' });

    assert.equal(result.key, result.uuid);
    assert.deepEqual(fetchCalls.map((call) => new URL(call.url).pathname), [
      '/v2/upload/multipart/init',
      '/v2/upload/multipart/parts',
      '/v2/upload/multipart/complete',
    ]);
    assert.deepEqual(FakeXMLHttpRequest.calls.map((call) => call.method), ['PUT', 'PUT']);
    assert.equal(progress.at(-1), 100);
  });

  test('does not send file bytes when direct initialization is unavailable', async () => {
    const fetchCalls = [];
    const FileUploadService = loadService(async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return jsonResponse({ error: 'Direct upload is not configured' }, 501);
    });
    const service = new FileUploadService({ baseUrl: 'https://storage.example.com' });
    await assert.rejects(
      service.upload(new FakeBlob(12, 'text/plain'), 'note.txt'),
      /Direct upload is not configured/,
    );

    assert.equal(fetchCalls.length, 1);
    assert.equal(new URL(fetchCalls[0].url).pathname, '/v2/upload/init');
    assert.equal(FakeXMLHttpRequest.calls.length, 0);
  });

  test('UI no longer hard-caps uploads at 95 MiB', () => {
    const src = readFileSync(join(root, 'ui-manager.js'), 'utf8');
    assert.doesNotMatch(src, /95\s*\*\s*1024\s*\*\s*1024/);
    assert.match(src, /fileUploadService\.multipartMaxUploadBytes/);
  });
});
