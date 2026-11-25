/* SPDX-License-Identifier: AGPL-3.0-only */
import { DurableObject } from 'cloudflare:workers';
import { allowedOrigin, type ChatEnv } from '../guest';
import type { Profile } from '../identity';
import { PushDelivery, pushConfigured } from '../push';
import { account, authenticate, available, boolean, DMError, fail, mode, object, positive, reply, sequence, type Snapshot } from './protocol';

type Entry = { id: string; snapshot: string; version: number; read_seq: number; read_incoming: number; hidden: number };
type Session = { ownerId: string; expiresAt: number; deadline: number; authAt?: number; busy?: boolean; closed?: boolean };

export class UserInbox extends DurableObject<ChatEnv> {
  private push: PushDelivery | null;
  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);
    const hadPush = ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='push_devices'").toArray().length;
    this.push = pushConfigured(env) || hadPush ? new PushDelivery(ctx.storage.sql, env) : null;
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS dm_owner (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, revision INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS dm_conversations (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, version INTEGER NOT NULL, read_seq INTEGER NOT NULL DEFAULT 0, read_incoming INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS dm_requests (peer TEXT PRIMARY KEY, created_at INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS dm_requests_time ON dm_requests(created_at)');
  }
  private owner(id: string) {
    account(id);
    const existing = this.ctx.storage.sql.exec<{ owner: string }>('SELECT owner FROM dm_owner WHERE id=1').toArray()[0];
    if (!existing) this.ctx.storage.sql.exec('INSERT INTO dm_owner VALUES(1,?,0)', id);
    else if (existing.owner !== id) fail('not_found', 404);
  }
  private revision() { return this.ctx.storage.sql.exec<{ revision: number }>('SELECT revision FROM dm_owner WHERE id=1').toArray()[0]?.revision || 0; }
  private entry(id: string) { return this.ctx.storage.sql.exec<Entry>('SELECT * FROM dm_conversations WHERE id=?', id).toArray()[0]; }
  private view(row: Entry) {
    const snapshot: Snapshot = JSON.parse(row.snapshot);
    const hidden = !!row.hidden;
    return { ...snapshot, hidden, readSeq: row.read_seq, readIncoming: row.read_incoming, unread: hidden ? 0 : Math.max(0, snapshot.incoming - row.read_incoming) };
  }
  private changed(id: string, silent: boolean) {
    this.ctx.storage.sql.exec('UPDATE dm_owner SET revision=revision+1 WHERE id=1');
    // Account metadata only: never broadcast message bodies or the peer's preferences.
    let text: string | undefined;
    for (const ws of this.ctx.getWebSockets()) {
      const session = ws.deserializeAttachment() as Session;
      if (session.closed) continue;
      if (mode(this.env) === 'off' || (session.expiresAt && session.expiresAt <= Date.now())) { this.close(ws, 4001, 'Authentication required'); continue; }
      if (!session.expiresAt) continue;
      text ??= JSON.stringify({ type: 'dm:changed', id, revision: this.revision(), silent, conversation: this.view(this.entry(id)!) });
      try { ws.send(text); } catch { this.close(ws); }
    }
  }
  async apply(snapshot: Snapshot) {
    await this.ctx.storage.transaction(async () => {
      this.owner(snapshot.ownerId);
      const existing = this.entry(snapshot.id);
      if (existing && existing.version >= snapshot.version) return;
      this.ctx.storage.sql.exec('INSERT INTO dm_conversations(id,snapshot,version) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot,version=excluded.version',
        snapshot.id, JSON.stringify(snapshot), snapshot.version);
      this.changed(snapshot.id, !!existing?.hidden);
      const previous: Snapshot | undefined = existing ? JSON.parse(existing.snapshot) : undefined;
      if (!existing?.hidden && !snapshot.refuseIncoming && snapshot.state !== 'rejected' && snapshot.incoming > (previous?.incoming || 0)) this.push?.enqueue(snapshot);
      if (snapshot.refuseIncoming || snapshot.state === 'rejected') this.push?.cancel(snapshot.id);
      // Persist the wakeup with the delivery record; waitUntil alone cannot
      // recover an outbox left behind by an eviction between the two writes.
      if (this.push) await this.schedule();
    });
  }
  async pushSettings(actor: Profile, enabled: boolean, input: Record<string, unknown>) {
    const result = await reply(() => {
      if (!actor.authenticated) return fail('login_required', 401);
      this.owner(actor.id);
      const push = this.push;
      if (!push) return enabled ? fail('push_unavailable', 503) : { enabled: false };
      return this.ctx.storage.transactionSync(() => push.manage(enabled, input));
    });
    await this.scheduleExpiry();
    return { status: result.status, code: String(result.data.code || ''), enabled: result.data.enabled === true, pausedUntil: Number(result.data.pausedUntil || 0) };
  }
  async handle(actor: Profile, action: string, input: Record<string, unknown>, snapshot?: Snapshot) {
    return reply(async () => {
      available(this.env, action === 'reserve');
      if (!actor.authenticated) return fail('login_required', 401);
      // Only the HTTP router supplies this fourth RPC argument, from DirectRoom.
      if (snapshot) {
        if (snapshot.ownerId !== actor.id || snapshot.id !== input.id) return fail('not_found', 404);
        await this.apply(snapshot);
      } else this.owner(actor.id);
      if (action === 'reserve') {
        const peer = account(input.peerId);
        return this.ctx.storage.transactionSync(() => {
          if (this.ctx.storage.sql.exec('SELECT 1 FROM dm_requests WHERE peer=?', peer).toArray().length) return {};
          const now = Date.now();
          const dayStart = Math.floor((now + 28800000) / 86400000) * 86400000 - 28800000;
          const count = (since: number) => this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM dm_requests WHERE created_at>=?', since).one().n;
          if (count(now - 3600000) >= positive(this.env.DM_REQUESTS_HOUR, 10) || count(dayStart) >= positive(this.env.DM_REQUESTS_DAY, 30)) return fail('request_rate_limited', 429);
          this.ctx.storage.sql.exec('INSERT INTO dm_requests VALUES(?,?)', peer, now);
          return {};
        });
      }
      if (action === 'list') {
        const cursor = typeof input.cursor === 'string' ? input.cursor : '';
        const limit = Math.min(100, positive(input.limit, 50));
        const rows = this.ctx.storage.sql.exec<Entry>('SELECT * FROM dm_conversations WHERE id>? ORDER BY id LIMIT ?', cursor, limit + 1).toArray();
        return { conversations: rows.slice(0, limit).map(row => this.view(row)), next: rows.length > limit ? rows[limit - 1].id : null, revision: this.revision() };
      }
      if (typeof input.id !== 'string') return fail('not_found', 404);
      const row = this.entry(input.id);
      if (!row) return fail('not_found', 404);
      if (action === 'get') return { conversation: this.view(row), revision: this.revision() };
      if (action === 'hide') {
        this.ctx.storage.transactionSync(() => {
          const hidden = boolean(input.hidden);
          if (Number(hidden) !== row.hidden) {
            this.ctx.storage.sql.exec('UPDATE dm_conversations SET hidden=? WHERE id=?', Number(hidden), row.id);
            if (hidden) this.push?.cancel(row.id);
            this.changed(row.id, true);
          }
        });
      } else if (action === 'read') {
        // The HTTP router supplies a checkpoint verified by DirectRoom, never client counts.
        const seq = sequence(input.seq), incoming = sequence(input.incoming);
        if (seq > row.read_seq) {
          this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec('UPDATE dm_conversations SET read_seq=?,read_incoming=MAX(read_incoming,?) WHERE id=?', seq, incoming, row.id);
            if (incoming >= (JSON.parse(row.snapshot) as Snapshot).incoming) this.push?.cancel(row.id);
            this.changed(row.id, true);
          });
        }
      } else return fail('not_found', 404);
      return { conversation: this.view(this.entry(row.id)!), revision: this.revision() };
    });
  }
  async fetch(request: Request): Promise<Response> {
    if (!allowedOrigin(request, this.env) || mode(this.env) === 'off') return new Response('Unavailable', { status: 403 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const owner = account(new URL(request.url).searchParams.get('account'));
    this.owner(owner);
    if (this.ctx.getWebSockets().length >= 32) return new Response('Too many connections', { status: 429 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ ownerId: owner, expiresAt: 0, deadline: Date.now() + 15000 } satisfies Session);
    await this.scheduleExpiry();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const initial = ws.deserializeAttachment() as Session;
    if (initial.closed) return;
    if (typeof raw !== 'string' || raw.length > 8192 || initial.busy) { this.close(ws, 4001, 'Invalid authentication'); return; }
    ws.serializeAttachment({ ...initial, busy: true });
    try {
      available(this.env);
      if (!initial.expiresAt && initial.deadline <= Date.now()) return this.close(ws, 4001, 'Authentication required');
      let input: Record<string, unknown>;
      try { input = object(JSON.parse(raw)); } catch { return this.close(ws, 4001, 'Invalid authentication'); }
      if (input.type !== 'auth') return this.close(ws, 4001, 'Authentication required');
      if (initial.authAt && Date.now() - initial.authAt < 1000) {
        if (initial.expiresAt > Date.now()) return;
        return this.close(ws, 1013, 'Please retry later');
      }
      ws.serializeAttachment({ ...initial, busy: true, authAt: Date.now() });
      const verified = await authenticate(this.env, input.accessToken);
      if ((ws.deserializeAttachment() as Session).closed) return;
      if (verified.user.id !== initial.ownerId) return this.close(ws, 4001, 'Authentication required');
      ws.serializeAttachment({ ownerId: verified.user.id, expiresAt: verified.expiresAt, deadline: verified.expiresAt, authAt: Date.now(), busy: false } satisfies Session);
      ws.send(JSON.stringify({ type: 'dm:ready', user: verified.user, expiresAt: verified.expiresAt, revision: this.revision(), mode: mode(this.env) }));
      await this.scheduleExpiry();
    } catch (error) {
      try { ws.send(JSON.stringify({ type: 'dm:error', code: error instanceof DMError ? error.code : 'dm_unavailable' })); } catch { /* Disconnected. */ }
      this.close(ws, error instanceof DMError && error.status === 401 ? 4001 : 1013, 'Authentication required');
    } finally {
      const session = ws.deserializeAttachment() as Session;
      ws.serializeAttachment({ ...session, busy: false });
    }
  }
  private close(ws: WebSocket, code = 1000, reason = '') {
    const session = ws.deserializeAttachment() as Session;
    ws.serializeAttachment({ ...session, closed: true });
    try { ws.close(code, reason); } catch { /* Already disconnected. */ }
  }
  async webSocketClose(ws: WebSocket) { this.close(ws); await this.scheduleExpiry(); }
  async webSocketError(ws: WebSocket) { this.close(ws, 1011); await this.scheduleExpiry(); }
  private async scheduleExpiry() {
    await this.ctx.storage.transaction(() => this.schedule());
  }
  private async schedule() {
    const deadlines = this.ctx.getWebSockets().map(ws => ws.deserializeAttachment() as Session).filter(session => !session.closed).map(session => session.deadline);
    const alarm = await this.ctx.storage.getAlarm();
    const pushDue = this.push?.next() ?? null;
    if (pushDue !== null) deadlines.push(pushDue);
    if (deadlines.length) {
      const next = Math.max(Date.now() + 100, Math.min(...deadlines));
      // Track the actual earliest deadline: retaining old lease alarms creates
      // an extra wakeup every renewal, without saving writes for one device.
      if (alarm !== next) await this.ctx.storage.setAlarm(next);
    } else if (alarm !== null) await this.ctx.storage.deleteAlarm();
  }
  async alarm() {
    for (const ws of this.ctx.getWebSockets()) {
      const session = ws.deserializeAttachment() as Session;
      if (!session.closed && (mode(this.env) === 'off' || session.deadline <= Date.now())) this.close(ws, 4001, 'Authentication required');
    }
    await this.push?.drain();
    await this.scheduleExpiry();
  }
}
