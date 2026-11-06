/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import test from 'node:test';
import { guestSession, verifyGuest, allowedOrigin } from '../src/guest.ts';

const origin = 'https://nightcord.de5.net';
const secret = 'ac'.repeat(32);
const env = { GUEST_SIGNING_KEY: secret, CHAT_ALLOWED_ORIGINS: origin };
const request = cookie => new Request('https://chat.nightcord.de5.net/api/guest/session', { method: 'POST', headers: { Cookie: cookie || '', Origin: origin } });
function credential(uuid, issued, expires, key = secret) {
  const kid = createHash('sha256').update(Buffer.from(key, 'hex')).digest('hex').slice(0, 16);
  const payload = `v1.${kid}.${uuid}.${issued}.${expires}`;
  return `__Host-nightcord_guest=${payload}.${createHmac('sha256', Buffer.from(key, 'hex')).update('nightcord-chat/guest/v1\n' + payload).digest('hex')}`;
}

test('signed cookie is private, host-only, stable, and cannot be claimed with a public ID', async () => {
  const response = await guestSession(request(), env, origin);
  const header = response.headers.get('set-cookie');
  const identity = await response.json();
  assert.match(header, /^__Host-nightcord_guest=/);
  for (const value of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=15552000']) assert.ok(header.includes(value));
  assert.ok(!header.includes('Domain='));
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(identity).sort(), ['expiresAt', 'id']);
  const cookie = header.split(';')[0];
  assert.equal((await verifyGuest(request(cookie), env)).id, identity.id);
  const reused = await guestSession(request(cookie), env, origin);
  assert.deepEqual(await reused.json(), identity);
  assert.equal(reused.headers.get('set-cookie'), null);
  assert.equal(await verifyGuest(request(`__Host-nightcord_guest=${identity.id}`), env), null);
  const parts = cookie.split('.');
  for (const index of [0, 1, 2, 3, 4, 5]) {
    const forged = [...parts];
    forged[index] = forged[index].replace(/[a-f0-9]/, c => c === 'a' ? 'b' : 'a');
    assert.equal(await verifyGuest(request(forged.join('.')), env), null);
  }
  assert.equal(await verifyGuest(request(`${cookie}; ${cookie}`), env), null);
});

test('renewal and key rotation preserve ID; expired, future and excessive lifetime claims fail', async () => {
  const uuid = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const old = credential(uuid, now - 179 * 86400, now + 86400);
  const rotated = { ...env, GUEST_SIGNING_KEY: 'bc'.repeat(32), GUEST_PREVIOUS_SIGNING_KEY: secret };
  const response = await guestSession(request(old), rotated, origin);
  assert.equal((await response.json()).id, `guest:${uuid}`);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal((await verifyGuest(request(cookie), rotated)).id, `guest:${uuid}`);
  assert.equal(await verifyGuest(request(cookie), env), null);
  for (const [issued, expires] of [[now - 100, now - 1], [now + 120, now + 300], [now, now + 181 * 86400]]) {
    assert.equal(await verifyGuest(request(credential(uuid, issued, expires)), env), null);
  }
  const fresh = await guestSession(request(credential(uuid, now - 100, now - 1)), env, origin);
  assert.notEqual((await fresh.json()).id, `guest:${uuid}`);
});

test('Origin allowlist rejects subdomains, null, missing and lookalike origins', () => {
  assert.equal(allowedOrigin(request(), env), origin);
  for (const value of ['https://evil.example', 'https://evil.nightcord.de5.net', origin + '.evil.example', 'null', '']) {
    const req = new Request('https://chat.nightcord.de5.net', { headers: value ? { Origin: value } : {} });
    assert.equal(allowedOrigin(req, env), null);
  }
});

test('guest initialization fails closed without a valid signing key', async () => {
  for (const value of [undefined, '', 'short', 'zz'.repeat(32)]) {
    await assert.rejects(guestSession(request(), { ...env, GUEST_SIGNING_KEY: value }, origin), /not configured/);
  }
});

test('local development reissues the same identity with cross-site cookie mode', async () => {
  const first = await guestSession(request(), env, origin);
  const cookie = first.headers.get('set-cookie').split(';')[0];
  const local = await guestSession(request(cookie), env, 'http://localhost:8000');
  assert.equal((await local.json()).id, (await first.clone().json()).id);
  assert.match(local.headers.get('set-cookie'), /SameSite=None/);
});
