/* SPDX-License-Identifier: AGPL-3.0-only */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const importFunction = (path) => import(`data:text/javascript;base64,${Buffer.from(read(path)).toString('base64')}`);
const { onRequest: middleware } = await importFunction('functions/_middleware.js');

function directives(policy) {
  return Object.fromEntries(policy.split(';').map(part => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name, values];
  }).filter(([name]) => name));
}

async function htmlResponse(headers = {}, source = '<script src="/boot.js"></script>') {
  const request = new Request('https://nightcord.de5.net/auth/callback?code=private', { headers });
  let forwarded;
  const response = await middleware({
    request,
    next: async (input) => {
      forwarded = input;
      return new Response(source, { headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "script-src 'unsafe-inline'",
        'ETag': '"old"',
        'Last-Modified': 'Wed, 04 Nov 2026 00:00:00 GMT',
        'X-Asset': 'retained',
      } });
    },
  });
  return { response, forwarded, request };
}

describe('HTML CSP and Cloudflare compatibility', () => {
  test('each response gets a fresh 128-bit nonce in both policies', async () => {
    const responses = await Promise.all(Array.from({ length: 12 }, () => htmlResponse()));
    const nonces = responses.map(({ response }) => {
      const policy = directives(response.headers.get('Content-Security-Policy'));
      const reportOnly = directives(response.headers.get('Content-Security-Policy-Report-Only'));
      const nonce = policy['script-src'].find(value => value.startsWith("'nonce-"));
      assert.equal(Buffer.from(nonce.slice(7, -1), 'base64').length, 16);
      assert.deepEqual(policy['script-src'], reportOnly['script-src']);
      for (const value of ["'self'", 'https://static.cloudflareinsights.com', 'https://ajax.cloudflare.com']) {
        assert.ok(policy['script-src'].includes(value));
      }
      for (const value of ["'unsafe-inline'", "'unsafe-eval'", 'https:', '*', 'data:', 'blob:']) {
        assert.ok(!policy['script-src'].includes(value));
      }
      assert.deepEqual(policy['script-src-attr'], ["'none'"]);
      assert.deepEqual(policy['worker-src'], ["'self'"]);
      assert.deepEqual(reportOnly['style-src'], ["'self'", "'unsafe-inline'"]);
      assert.ok(reportOnly['connect-src'].includes("'self'"), 'automatic Analytics posts to /cdn-cgi/rum');
      assert.ok(reportOnly['connect-src'].includes('https://id.nightcord.de5.net'), 'OAuth token/userinfo/JWKS');
      assert.equal(policy['default-src'], undefined, 'external message media is still observational');
      return nonce;
    });
    assert.equal(new Set(nonces).size, responses.length);
  });

  test('preserves body without authorizing injected script markup', async () => {
    const html = '<script src="/boot.js"></script><script>window.injected=1</script><img onerror="window.injected=2">';
    const { response } = await htmlResponse({}, html);
    assert.equal(await response.text(), html);
    assert.equal(response.headers.get('X-Asset'), 'retained');
    assert.equal(response.headers.get('Reporting-Endpoints'), 'csp="https://nightcord.de5.net/csp-report"');
    const policy = directives(response.headers.get('Content-Security-Policy'));
    assert.deepEqual(policy['report-uri'], ['/csp-report']);
    assert.deepEqual(policy['report-to'], ['csp']);
  });

  test('avoids 304 nonce mismatches and shared HTTP caching', async () => {
    const { response, forwarded, request } = await htmlResponse({ 'If-None-Match': 'old', 'If-Modified-Since': 'yesterday' });
    assert.ok(request.headers.has('If-None-Match'), 'do not mutate the incoming request');
    assert.ok(!forwarded.headers.has('If-None-Match'));
    assert.ok(!forwarded.headers.has('If-Modified-Since'));
    assert.ok(!response.headers.has('ETag'));
    assert.ok(!response.headers.has('Last-Modified'));
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(response.headers.get('Cloudflare-CDN-Cache-Control'), 'no-store');
    for (const header of ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy']) {
      assert.ok(response.headers.has(header), `${header} must survive Pages Functions`);
    }
  });

  test('passes redirects and non-HTML assets through', async () => {
    for (const response of [
      new Response(null, { status: 308, headers: { Location: '/' } }),
      new Response('let ok = 1;', { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' } }),
    ]) {
      assert.equal(await middleware({ request: new Request('https://nightcord.de5.net/'), next: async () => response }), response);
    }
  });

  test('static fallback keeps the same script sources and base restrictions', async () => {
    const { response } = await htmlResponse();
    const name = 'Content-Security-Policy';
    const staticPolicy = read('_headers').split(/\r?\n/).find(line => line.trim().startsWith(`${name}:`)).trim().slice(name.length + 1);
    const live = directives(response.headers.get(name));
    live['script-src'] = live['script-src'].filter(value => !value.startsWith("'nonce-"));
    for (const htmlOnly of ['script-src-attr', 'report-uri', 'report-to']) delete live[htmlOnly];
    assert.deepEqual(live, directives(staticPolicy));
    assert.doesNotMatch(read('_headers'), /^\s*Content-Security-Policy-Report-Only:/m, 'HTML owns the complete policy and reporting endpoints');
  });
});

describe('CSP reporting receiver', () => {
  async function receive(payload, contentType = 'application/csp-report', init = {}) {
    const entries = [];
    const sandbox = { Request, Response, URL, TextDecoder, Uint8Array, RangeError, SyntaxError, console: { warn: line => entries.push(JSON.parse(line)) } };
    vm.runInNewContext(read('functions/csp-report.js').replace('export async function onRequest', 'async function onRequest'), sandbox);
    const request = new Request('https://nightcord.de5.net/csp-report', {
      method: 'POST', headers: { 'Content-Type': contentType },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload), ...init,
    });
    const response = await sandbox.onRequest({ request });
    return { response, entries };
  }

  test('legacy reports arrive with URL secrets, samples and policies removed', async () => {
    const { response, entries } = await receive({ 'csp-report': {
      'document-uri': 'https://nightcord.de5.net/auth/callback?code=secret#token',
      'blocked-uri': 'https://example.com/script.js?secret=yes#fragment',
      'effective-directive': 'script-src-elem', disposition: 'enforce',
      'script-sample': 'private message', 'original-policy': "nonce-secret", referrer: 'secret',
    } });
    assert.equal(response.status, 204);
    assert.deepEqual(entries, [{ event: 'csp-violation', documentUrl: 'https://nightcord.de5.net/auth/callback', directive: 'script-src-elem', blockedUrl: 'https://example.com/script.js', disposition: 'enforce' }]);
  });

  test('Reporting API batches and inline violations arrive', async () => {
    const { response, entries } = await receive([
      { type: 'csp-violation', body: { documentURL: 'https://nightcord.de5.net/', blockedURL: 'inline', effectiveDirective: 'script-src-attr', disposition: 'report' } },
      { type: 'deprecation', body: { message: 'not a CSP report' } },
      { type: 'csp-violation', body: { documentURL: 'https://elsewhere.test/', effectiveDirective: 'script-src' } },
      { type: 'csp-violation', body: { documentURL: 'inline', effectiveDirective: 'script-src' } },
    ], 'application/reports+json');
    assert.equal(response.status, 204);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].blockedUrl, 'inline');
    assert.equal(entries[0].disposition, 'report');
  });

  test('rejects invalid JSON, media types, methods, oversized bodies and batches', async () => {
    for (const [body, type, init, status] of [
      ['{', 'application/json', {}, 400],
      ['{}', 'text/plain', {}, 415],
      ['x'.repeat(16385), 'application/json', {}, 413],
      [Array.from({ length: 21 }, () => ({})), 'application/reports+json', {}, 413],
      ['{}', 'application/json', { method: 'PUT' }, 405],
    ]) {
      const { response, entries } = await receive(body, type, init);
      assert.equal(response.status, status);
      assert.deepEqual(entries, []);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
  });
});

describe('application CSP prerequisites', () => {
  const html = read('index.html').replace(/<!--[\s\S]*?-->/g, '');
  test('active scripts use existing same-origin files, including startup', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
    assert.ok(scripts.length > 10);
    for (const [, attributes, body] of scripts) {
      const src = /\bsrc\s*=\s*"([^\"]+)"/i.exec(attributes)?.[1];
      assert.match(src ?? '', /^\/(?!\/)/, `inline/cross-origin script: ${attributes}`);
      assert.equal(body.trim(), '');
      read(src.slice(1));
    }
    assert.match(html, /<script src="\/boot\.js"><\/script>/);
    assert.ok(html.indexOf('/nightcord.js') < html.indexOf('/boot.js'));
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(html, /\bnonce\s*=/i, 'a static nonce provides no protection');
  });

  test('startup preserves normal and test rooms', () => {
    for (const [search, expected] of [['', undefined], ['?test', 'nightcord-test']]) {
      let room;
      let calls = 0;
      vm.runInNewContext(read('boot.js'), { Nightcord: class { init(value) { room = value; calls++; } }, URLSearchParams, location: { search } });
      assert.equal(room, expected);
      assert.equal(calls, 1);
    }
  });

  test('browser scripts do not rely on eval or inline event attributes', () => {
    const files = readdirSync(root).filter(name => name.endsWith('.js') && !['purify.js', 'pangu.js'].includes(name));
    for (const file of files) {
      const source = read(file);
      assert.doesNotMatch(source, /\beval\s*\(|\bnew\s+Function\s*\(|\bset(?:Timeout|Interval)\s*\(\s*['"`]/, file);
      assert.doesNotMatch(source, /\bsetAttribute\s*\(\s*['"`]on[a-z]+['"`]/i, file);
      assert.doesNotMatch(source, /<[^>]+\son[a-z]+\s*=\s*['"]/i, file);
    }
  });

  test('Pages routes run middleware for HTML and reports while excluding static assets', () => {
    const routes = JSON.parse(read('_routes.json'));
    const matches = (pattern, path) => new RegExp(`^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(path);
    const invokes = path => routes.include.some(rule => matches(rule, path)) && !routes.exclude.some(rule => matches(rule, path));
    for (const path of ['/', '/auth/callback', '/index.html', '/unknown-route', '/csp-report']) assert.ok(invokes(path), path);
    for (const path of ['/boot.js', '/sw.js', '/css/renderer.css', '/vendor/sekai-auth.global.js', '/icons/icon-192.png', '/cdn-cgi/rum', '/version.json']) assert.ok(!invokes(path), path);
  });
});
