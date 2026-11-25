/* SPDX-License-Identifier: AGPL-3.0-only */
import * as webpush from 'web-push';
import { corsHeaders, type ChatEnv } from './guest';
import { authenticate, bearer, body, fail, object, reply } from './messaging/protocol';
import type { Snapshot } from './dm/protocol';

export interface PushSecrets { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string }
type Device = { endpoint: string; subscription: string; paused_until: number; expires_at: number };
type Pending = { endpoint: string; conversation: string; owner: string; version: number; attempts: number; due: number; expires_at: number };
export function pushConfigured(env: ChatEnv) {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT && env.DM_MODE === 'on');
}
// Only browser push services are valid destinations; arbitrary URLs would enable SSRF.
function endpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return fail('invalid_subscription');
  let url: URL;
  try { url = new URL(value); } catch { return fail('invalid_subscription'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
      !(url.hostname === 'fcm.googleapis.com' || url.hostname === 'updates.push.services.mozilla.com' ||
        url.hostname === 'web.push.apple.com' || /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname))) return fail('invalid_subscription');
  return url.href;
}
export async function subscription(value: unknown): Promise<webpush.PushSubscription> {
  const input = object(value), keys = object(input.keys), target = endpoint(input.endpoint);
  if (typeof keys.p256dh !== 'string' || !/^[\w-]{87}$/.test(keys.p256dh) ||
      typeof keys.auth !== 'string' || !/^[\w-]{22}$/.test(keys.auth)) return fail('invalid_subscription');
  try {
    await crypto.subtle.importKey('raw', Uint8Array.from(atob(keys.p256dh.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)),
      { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  } catch { return fail('invalid_subscription'); }
  return { endpoint: target, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}
export async function pushRoute(request: Request, env: ChatEnv, origin: string) {
  const headers = { ...corsHeaders(origin), 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  const path = new URL(request.url).pathname;
  if (path === '/api/push/config' && request.method === 'GET') {
    return Response.json({ enabled: pushConfigured(env), publicKey: pushConfigured(env) ? env.VAPID_PUBLIC_KEY : null }, { headers });
  }
  const result = await reply(async () => {
    if (request.method !== 'POST') return fail('method_not_allowed', 405);
    if (!['/api/push/subscribe', '/api/push/unsubscribe'].includes(path)) return fail('not_found', 404);
    const { user } = await authenticate(env, bearer(request));
    if (!await env.LIMITERS.getByName('push:' + user.id).check()) return fail('rate_limited', 429);
    const input = await body(request);
    if (path.endsWith('/subscribe')) {
      if (!pushConfigured(env)) return fail('push_unavailable', 503);
      input.subscription = await subscription(input.subscription);
    } else input.endpoint = endpoint(input.endpoint);
    const value = await env.DM_INBOXES.getByName(user.id).pushSettings(user, path.endsWith('/subscribe'), input);
    if (value.status !== 200) return fail(value.code, value.status);
    return { enabled: value.enabled, pausedUntil: value.pausedUntil };
  });
  return Response.json(result.data, { status: result.status, headers });
}
/** Shares the inbox's alarm. Push delivery never blocks message acknowledgement. */
export class PushDelivery {
  constructor(private sql: SqlStorage, private env: ChatEnv) {
    sql.exec('CREATE TABLE IF NOT EXISTS push_devices (endpoint TEXT PRIMARY KEY, subscription TEXT NOT NULL, paused_until INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS push_outbox (endpoint TEXT NOT NULL, conversation TEXT NOT NULL, owner TEXT NOT NULL, version INTEGER NOT NULL, attempts INTEGER NOT NULL, due INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(endpoint,conversation))');
    if (!pushConfigured(env)) sql.exec('DELETE FROM push_outbox');
  }
  manage(enabled: boolean, input: Record<string, unknown>) {
    const now = Date.now();
    this.sql.exec('DELETE FROM push_devices WHERE expires_at<=?', now);
    if (!enabled) { this.remove(String(input.endpoint)); return { enabled: false }; }
    if (!pushConfigured(this.env)) return fail('push_unavailable', 503);
    const value = input.subscription as webpush.PushSubscription, paused = input.pausedUntil ?? 0;
    if (typeof paused !== 'number' || !Number.isSafeInteger(paused) || paused < 0 || paused > now + 86400000) return fail('invalid_pause');
    const exists = this.sql.exec('SELECT 1 FROM push_devices WHERE endpoint=?', value.endpoint).toArray().length;
    if (!exists && this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM push_devices').one().n >= 8) return fail('too_many_devices', 409);
    this.sql.exec('INSERT INTO push_devices VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription,paused_until=excluded.paused_until,expires_at=excluded.expires_at',
      value.endpoint, JSON.stringify(value), paused, now + 90 * 86400000);
    if (paused > now) this.sql.exec('DELETE FROM push_outbox WHERE endpoint=?', value.endpoint);
    return { enabled: true, pausedUntil: paused };
  }
  private remove(target: string) {
    this.sql.exec('DELETE FROM push_devices WHERE endpoint=?', target);
    this.sql.exec('DELETE FROM push_outbox WHERE endpoint=?', target);
  }
  cancel(conversation: string) { this.sql.exec('DELETE FROM push_outbox WHERE conversation=?', conversation); }
  enqueue(snapshot: Snapshot) {
    if (!pushConfigured(this.env)) return;
    const now = Date.now();
    this.sql.exec(`INSERT INTO push_outbox SELECT endpoint,?,?,?,0,?,? FROM push_devices WHERE expires_at>? AND paused_until<=?
      ON CONFLICT(endpoint,conversation) DO UPDATE SET version=excluded.version,attempts=0,expires_at=excluded.expires_at`,
      snapshot.id, snapshot.ownerId, snapshot.version, now + 2000, now + 3600000, now, now);
  }
  next() { return this.sql.exec<{ due: number | null }>('SELECT MIN(due) AS due FROM push_outbox').one().due; }
  async drain() {
    if (!pushConfigured(this.env)) { this.sql.exec('DELETE FROM push_outbox'); return; }
    const rows = this.sql.exec<Pending>('SELECT * FROM push_outbox WHERE due<=? LIMIT 8', Date.now()).toArray();
    await Promise.allSettled(rows.map(async row => {
      const device = this.sql.exec<Device>('SELECT * FROM push_devices WHERE endpoint=?', row.endpoint).toArray()[0];
      const discard = () => this.sql.exec('DELETE FROM push_outbox WHERE endpoint=? AND conversation=? AND version=?', row.endpoint, row.conversation, row.version);
      if (!device || device.expires_at <= Date.now() || device.paused_until > Date.now() || row.expires_at <= Date.now()) { discard(); return; }
      let status = 0;
      try {
        const details = webpush.generateRequestDetails(JSON.parse(device.subscription), JSON.stringify({
          type: 'dm', ownerId: row.owner, conversation: row.conversation,
        }), { TTL: Math.max(1, Math.ceil((row.expires_at - Date.now()) / 1000)), urgency: 'normal',
          vapidDetails: { subject: this.env.VAPID_SUBJECT!, publicKey: this.env.VAPID_PUBLIC_KEY!, privateKey: this.env.VAPID_PRIVATE_KEY! } });
        const response = await fetch(details.endpoint, { method: 'POST', headers: details.headers, body: new Uint8Array(details.body!),
          redirect: 'manual', signal: AbortSignal.timeout(10000) });
        status = response.status;
        await response.body?.cancel();
      } catch { /* Retry without logging endpoint or key material. */ }
      if (status === 404 || status === 410) { this.remove(row.endpoint); return; }
      if ((status >= 200 && status < 400) || (status >= 400 && status < 500 && status !== 429) || row.attempts >= 4) { discard(); return; }
      this.sql.exec('UPDATE push_outbox SET attempts=attempts+1,due=? WHERE endpoint=? AND conversation=? AND version=?',
        Date.now() + 30000 * 2 ** row.attempts, row.endpoint, row.conversation, row.version);
      console.warn(JSON.stringify({ event: 'push_retry', status, attempts: row.attempts + 1 }));
    }));
  }
}
