/* SPDX-License-Identifier: AGPL-3.0-only */
import type { ChatEnv } from './guest';
import type { Profile } from './identity';
import { fail, object } from './messaging/protocol';
import { pushConfigured } from './push';
import { SekaiParser } from '../../js/renderer/parser.js';

export const validPushRoom = (room: unknown): room is string => typeof room === 'string' && /^(?:[a-z0-9-]{1,32}|[a-f0-9]{64}|r_[a-f0-9]{32})$/.test(room);
export type RoomPushPreferences = { message: boolean; reply: boolean; mention: boolean; everyone: boolean; pausedUntil: number };
type Watch = { endpoint: string; device: string; owner: string; room: string; name: string; preferences: string; expires_at: number; next_at: number };
type Pending = Watch & { due: number; attempts: number; queued_at: number };
export async function pushDeviceKey(endpoint: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))), n => n.toString(16).padStart(2, '0')).join('');
}
export function roomPushPreferences(value: unknown): RoomPushPreferences {
  const input = object(value);
  for (const key of ['message', 'reply', 'mention', 'everyone']) if (typeof input[key] !== 'boolean') fail('invalid_request');
  if (!Number.isSafeInteger(input.pausedUntil) || Number(input.pausedUntil) < 0) fail('invalid_pause');
  return { message: input.message === true, reply: input.reply === true, mention: input.mention === true,
    everyone: input.everyone === true, pausedUntil: Number(input.pausedUntil) };
}

/** Room-local, bounded batches. Device secrets remain solely in UserInbox. */
export class RoomPush {
  private active = false;
  private initialized = false;
  private work: Promise<void> | null = null;
  private budget = { day: '', attempts: 0 };
  private parser = new SekaiParser();
  constructor(private ctx: DurableObjectState, private env: ChatEnv,
    private allowed: (owner: string) => boolean, private readers: () => Set<string>) {
    this.initialized = !!ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='room_push_watch'").toArray().length;
    if (this.initialized) {
      this.refresh();
      this.budget = this.sql.exec<{ day: string; attempts: number }>('SELECT day,attempts FROM room_push_budget WHERE id=1').toArray()[0] || this.budget;
    }
  }
  private get sql() { return this.ctx.storage.sql; }
  private refresh() { this.active = !!this.sql.exec('SELECT 1 FROM room_push_watch LIMIT 1').toArray().length; }
  private initialize() {
    if (this.initialized) return;
    this.sql.exec('CREATE TABLE room_push_watch (endpoint TEXT PRIMARY KEY, device TEXT NOT NULL, owner TEXT NOT NULL, room TEXT NOT NULL, name TEXT NOT NULL, preferences TEXT NOT NULL, expires_at INTEGER NOT NULL, next_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE room_push_pending (endpoint TEXT PRIMARY KEY, due INTEGER NOT NULL, attempts INTEGER NOT NULL, queued_at INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX room_push_due ON room_push_pending(due)');
    this.sql.exec('CREATE TABLE room_push_budget (id INTEGER PRIMARY KEY CHECK(id=1), day TEXT NOT NULL, attempts INTEGER NOT NULL)');
    this.initialized = true;
  }
  read(owner: string, device: string) {
    if (this.active) this.sql.exec('DELETE FROM room_push_pending WHERE endpoint IN (SELECT endpoint FROM room_push_watch WHERE owner=? AND device=?)', owner, device);
  }
  manage(actor: Profile, room: string, endpoint: string, device: string, prefs: RoomPushPreferences) {
    if (!actor.authenticated || !this.allowed(actor.id)) return fail('not_found', 404);
    const enabled = prefs.message || prefs.reply || prefs.mention || prefs.everyone;
    if (enabled && !pushConfigured(this.env)) fail('push_unavailable', 503);
    if (!this.initialized && !enabled) return;
    this.initialize();
    this.sql.exec('DELETE FROM room_push_watch WHERE expires_at<=?', Date.now());
    const existing = this.sql.exec<Watch>('SELECT * FROM room_push_watch WHERE endpoint=?', endpoint).toArray()[0];
    if (existing && existing.owner !== actor.id) fail('invalid_subscription');
    if (!enabled) this.sql.exec('DELETE FROM room_push_watch WHERE endpoint=?', endpoint);
    else {
      if (!existing && this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM room_push_watch').one().n >= 256) fail('room_push_limit', 409);
      this.sql.exec(`INSERT INTO room_push_watch VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(endpoint) DO UPDATE SET
        name=excluded.name,preferences=excluded.preferences,expires_at=excluded.expires_at`,
      endpoint, device, actor.id, room, actor.displayName, JSON.stringify(prefs), Date.now() + 90 * 86400000);
    }
    this.sql.exec('DELETE FROM room_push_pending WHERE endpoint=?', endpoint);
    this.refresh();
  }
  enqueue(sender: string, text: string, lookupReply: (id: number) => string | undefined, replyTo?: number) {
    if (!this.active || !pushConfigured(this.env)) return false;
    if (this.budget.day === new Date().toISOString().slice(0, 10) && this.budget.attempts >= 500) return false;
    const now = Date.now();
    // Already pending endpoints are excluded: a burst creates one write, not one per message.
    const watches = this.sql.exec<Watch>(`SELECT w.* FROM room_push_watch w LEFT JOIN room_push_pending p USING(endpoint)
      WHERE p.endpoint IS NULL AND w.owner!=? AND w.expires_at>?`, sender, now).toArray();
    if (!watches.length) return false;
    const reading = this.readers();
    // Parse once per message, and never interpret quoted/code examples as mentions.
    const clean = text.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/`[^`\n]*`|^\s*>.*$/gm, '');
    const mentions = new Set<string>(), replies = new Set<string>(); let everyone = false;
    const addReply = (id: number) => { if (Number.isSafeInteger(id) && id > 0) { const owner = lookupReply(id); if (owner) replies.add(owner); } };
    if (replyTo) addReply(replyTo);
    let plain = '';
    for (const part of this.parser.tokenize(clean)) {
      if (part.type === 'text') { plain += part.content.replace(/https?:\/\/[^\s<>]+/g, '') + ' '; continue; }
      if (part.version === 2 && part.sekaiType === 'mention') {
        const kind = (part.desc.type || 'user').toLowerCase();
        if (kind === 'all') everyone = true;
        else if (kind === 'user') mentions.add(part.payload);
      } else if (part.sekaiType === 'reply' || part.sekaiType === 're') addReply(Number(part.payload));
    }
    const named = (name: string) => !!name && new RegExp('(^|[\\s\\p{P}\\p{S}])@' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}_-])', 'iu').test(plain);
    everyone ||= named('everyone');
    let added = false;
    for (const watch of watches) {
      const prefs: RoomPushPreferences = JSON.parse(watch.preferences);
      if (prefs.pausedUntil > now || reading.has(watch.owner + '\n' + watch.device)) continue;
      const mention = mentions.has(watch.owner) || named(watch.name), reply = replies.has(watch.owner);
      if (!(mention && prefs.mention || reply && prefs.reply || everyone && prefs.everyone || !mention && !reply && !everyone && prefs.message)) continue;
      this.sql.exec('INSERT OR IGNORE INTO room_push_pending VALUES(?,?,0,?)', watch.endpoint, Math.max(now + 15000, watch.next_at), now);
      added = true;
    }
    return added;
  }
  next(): number | null {
    return this.initialized ? this.sql.exec<{ due: number | null }>('SELECT MIN(due) AS due FROM room_push_pending').one().due : null;
  }
  async schedule() {
    const next = this.next();
    if (next === null) return;
    const old = await this.ctx.storage.getAlarm();
    if (old === null || old > next) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
  }
  drain() {
    if (!this.initialized) return Promise.resolve();
    if (this.work) return this.work;
    this.work = this.run().finally(() => { this.work = null; }); return this.work;
  }
  private async run() {
    if (!pushConfigured(this.env)) { this.sql.exec('DELETE FROM room_push_pending'); return; }
    this.sql.exec('DELETE FROM room_push_watch WHERE expires_at<=?', Date.now());
    this.sql.exec('DELETE FROM room_push_pending WHERE endpoint NOT IN (SELECT endpoint FROM room_push_watch)');
    const rows = this.sql.exec<Pending>('SELECT w.*,p.due,p.attempts,p.queued_at FROM room_push_pending p JOIN room_push_watch w USING(endpoint) WHERE p.due<=? ORDER BY p.due LIMIT 8', Date.now()).toArray();
    for (const task of rows) {
      // Earlier network sends can yield to a pause, read, or unsubscribe. Re-read
      // the task before each send instead of using a stale prefetched batch.
      const row = this.sql.exec<Pending>('SELECT w.*,p.due,p.attempts,p.queued_at FROM room_push_pending p JOIN room_push_watch w USING(endpoint) WHERE p.endpoint=? AND p.queued_at=?', task.endpoint, task.queued_at).toArray()[0];
      if (!row) continue;
      const discard = () => this.sql.exec('DELETE FROM room_push_pending WHERE endpoint=? AND queued_at=?', row.endpoint, row.queued_at);
      if (!this.allowed(row.owner)) { this.sql.exec('DELETE FROM room_push_watch WHERE endpoint=?', row.endpoint); discard(); continue; }
      if (this.readers().has(row.owner + '\n' + row.device) || JSON.parse(row.preferences).pausedUntil > Date.now() || row.queued_at < Date.now() - 3600000) { discard(); continue; }
      const day = new Date().toISOString().slice(0, 10);
      if (this.budget.day !== day) this.budget = { day, attempts: 0 };
      if (this.budget.attempts >= 500) { this.sql.exec('DELETE FROM room_push_pending'); break; }
      // Reserve before external I/O; retries count toward the same daily ceiling.
      this.budget.attempts++;
      this.sql.exec('INSERT INTO room_push_budget VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET day=excluded.day,attempts=excluded.attempts', day, this.budget.attempts);
      let result = 'retry';
      try { result = await this.env.DM_INBOXES.getByName(row.owner).sendRoomPush(row.owner, row.endpoint, row.room); } catch { /* Bounded durable retry. */ }
      if (result === 'gone') this.sql.exec('DELETE FROM room_push_watch WHERE endpoint=?', row.endpoint);
      if (result !== 'retry' || row.attempts >= 2) {
        discard(); this.sql.exec('UPDATE room_push_watch SET next_at=? WHERE endpoint=?', Date.now() + 60000, row.endpoint);
      } else this.sql.exec('UPDATE room_push_pending SET attempts=attempts+1,due=? WHERE endpoint=? AND queued_at=?', Date.now() + 60000 * 2 ** row.attempts, row.endpoint, row.queued_at);
    }
    this.refresh(); await this.schedule();
  }
}
