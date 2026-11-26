/* SPDX-License-Identifier: AGPL-3.0-only */
import { DurableObject } from 'cloudflare:workers';
import { allowedOrigin, type ChatEnv } from '../guest';
import type { Profile } from '../identity';
import { authenticate, available, fail, hash, identifier, object, reply, settings, summary, visibilityAllowed, type State, type Visibility } from './protocol';
import { RoomStore } from './schema';
import { manage, memberPage, requireMember } from './membership';
import { history, send } from './messages';
import { RoomDelivery, type Session } from './delivery';
import type { Creation } from './directory';
export class ManagedRoom extends DurableObject<ChatEnv> {
  private store: RoomStore;
  private delivery: RoomDelivery;
  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env); this.store = new RoomStore(ctx.storage); this.delivery = new RoomDelivery(ctx, env, this.store);
    if (this.store.exists()) this.store.initializeVisibility();
  }
  async initialize(actor: Profile, creation: Creation) {
    const result = await reply(async () => {
      available(this.env, true);
      if (!actor.authenticated || creation.account_id !== actor.id || this.ctx.id.toString() !== this.env.MANAGED_ROOMS.idFromName(creation.room_id).toString()) return fail('not_found', 404);
      await this.ctx.storage.transaction(async () => {
        if (this.store.exists()) return;
        this.store.initialize();
        const s: State = { ...settings(JSON.parse(creation.payload)), id: creation.room_id, ownerId: actor.id, status: 'active',
          revision: 1, publicationVersion: 0, createdAt: Date.now(), lastSeq: 0, bytes: 0, quotaDay: '', sentToday: 0 };
        this.store.sql.exec("INSERT INTO members VALUES(?,?,'active',1,?,0)", actor.id, JSON.stringify(actor), Date.now());
        this.store.publish(s); this.store.save(s); this.store.reference(s, this.store.member(actor.id)!);
        this.store.audit(actor.id, 'create'); await this.delivery.schedule();
      });
      await this.delivery.drain();
      return { ...(this.store.require(actor.id) ? manage(this.store, actor, 'get', {}) : { roomId: creation.room_id, role: null }), syncing: this.pending() };
    });
    return { status: result.status, json: JSON.stringify(result.data) };
  }
  private pending() { return !!this.store.sql.exec('SELECT 1 FROM outbox LIMIT 1').toArray().length; }
  async handle(actor: Profile, action: string, input: Record<string, unknown>) {
    const result = await reply(async () => {
      available(this.env, !['get', 'preview', 'members', 'invites', 'leave', 'remove', 'ban', 'unban', 'archive', 'revoke'].includes(action));
      if (!actor.authenticated || !this.store.exists()) return fail('not_found', 404);
      let secret = '', digest = '';
      if (action === 'invite') { secret = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''); digest = await hash(secret); }
      if (action === 'accept' || action === 'preview') {
        if (typeof input.secret !== 'string' || !/^[a-f0-9]{64}$/.test(input.secret)) return fail('invite_unavailable', 404);
        digest = await hash(input.secret);
      }
      let value: Record<string, unknown> = {};
      await this.ctx.storage.transaction(async () => {
        value = manage(this.store, actor, action, input, digest);
        if (this.pending()) await this.delivery.schedule();
      });
      this.revokeConnections();
      if (action === 'update') this.syncVisibilityAccess();
      this.broadcast({ type: 'presence', online: this.online() });
      if (!['get', 'preview', 'members', 'invites'].includes(action)) {
        this.broadcast({ type: 'changed', room: summary(this.store.state()) });
        await this.delivery.drain();
        // After external I/O, recheck access and return the latest authoritative view.
        if (this.store.require(actor.id)) value = { ...value, ...manage(this.store, actor, 'get', {}) };
        else value = { role: null };
      }
      return { ...value, ...(secret ? { secret } : {}), syncing: this.pending() };
    });
    if (result.status === 200 && result.data.syncing && ['update', 'archive'].includes(action)) result.status = 202;
    return { status: result.status, json: JSON.stringify(result.data) };
  }
  directPeer(actorId: string, peerId: string): Profile | null {
    if (!this.store.exists() || actorId === peerId || !this.store.require(actorId)) return null;
    const peer = this.store.require(peerId); return peer ? JSON.parse(peer.profile) : null;
  }
  async fetch(request: Request) {
    if (!allowedOrigin(request, this.env)) return new Response('Forbidden', { status: 403 });
    if (!this.store.exists() || !['on', 'read-only'].includes(this.env.ROOMS_MODE || '')) return new Response('Unavailable', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Upgrade required', { status: 426 });
    if (this.ctx.getWebSockets().length >= 64) return new Response('Room full', { status: 429 });
    const pair = new WebSocketPair(); this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ user: null, expiresAt: Date.now() + 10000 } satisfies Session);
    await this.ctx.storage.transaction(() => this.delivery.schedule());
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  private close(ws: WebSocket, code = 4003) {
    const s = ws.deserializeAttachment() as Session; s.closed = true; ws.serializeAttachment(s);
    try { ws.close(code, 'Room access ended'); } catch {}
  }
  private revokeConnections() {
    for (const ws of this.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session;
      if (!s.closed && (s.expiresAt <= Date.now() || (s.user && !this.store.require(s.user.id)))) this.close(ws, s.expiresAt <= Date.now() ? 4001 : 4003);
    }
  }
  private online() {
    return [...new Set(this.ctx.getWebSockets().map(ws => ws.deserializeAttachment() as Session)
      .filter(s => !s.closed && s.user && s.expiresAt > Date.now() && this.store.require(s.user.id)
        && this.store.visibility(s.user.id) === 'online').map(s => s.user!.id))];
  }
  private sessionFrame(ws: WebSocket, input: Record<string, unknown> = {}, includeHistory = true) {
    const s = ws.deserializeAttachment() as Session, user = s.user!;
    const state = this.store.state(), blocked = !this.store.visibilityAllowed(user.id);
    s.visibilityBlocked = blocked; ws.serializeAttachment(s);
    const own = { room: summary(state), role: state.ownerId === user.id ? 'owner' : 'member', user,
      visibility: this.store.visibility(user.id), authExpiresAt: s.expiresAt };
    if (blocked) return { ...own, type: 'room:visibility-required' };
    return { ...own, type: 'ready', online: this.online(), latestSeq: state.lastSeq,
      ...(includeHistory ? { ...history(this.store, user, input), ...memberPage(this.store, user, { view: 'roster' }) } : {}) };
  }
  private syncVisibilityAccess() {
    for (const ws of this.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session;
      if (s.closed || !s.user || s.expiresAt <= Date.now() || !this.store.require(s.user.id)) continue;
      // Keep the saved preference. Disallowed identities receive only a private consent frame.
      if (!this.store.visibilityAllowed(s.user.id) || s.visibilityBlocked) {
        try { ws.send(JSON.stringify(this.sessionFrame(ws))); } catch { this.close(ws); }
      }
    }
  }
  private broadcast(value: unknown) {
    const encoded = JSON.stringify(value);
    for (const ws of this.ctx.getWebSockets()) {
      const s = ws.deserializeAttachment() as Session;
      if (s.closed || !s.user || s.expiresAt <= Date.now() || !this.store.require(s.user.id) || !this.store.visibilityAllowed(s.user.id)) continue;
      try { ws.send(encoded); } catch { this.close(ws); }
    }
  }
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let requestId: string | undefined;
    const result = await reply(async () => {
      available(this.env);
      if (typeof raw !== 'string' || raw.length > 8192) return fail('invalid_frame');
      let input: Record<string, unknown>; try { input = object(JSON.parse(raw)); } catch { return fail('invalid_frame'); }
      requestId = identifier(input.requestId);
      let s = ws.deserializeAttachment() as Session;
      if (s.closed || s.expiresAt <= Date.now()) { this.close(ws, 4001); return fail('login_required', 401); }
      if (input.type === 'auth') {
        if (s.busy || (s.authAt && Date.now() - s.authAt < 1000)) return fail('rate_limited', 429);
        s.busy = true; s.authAt = Date.now(); ws.serializeAttachment(s);
        let identity;
        try { identity = await authenticate(this.env, input.accessToken); }
        finally { s = ws.deserializeAttachment() as Session; s.busy = false; ws.serializeAttachment(s); }
        if (s.closed || s.expiresAt <= Date.now() || (s.user && s.user.id !== identity.user.id)) return fail('login_required', 401);
        requireMember(this.store, identity.user);
        if (this.ctx.getWebSockets().filter(other => { const a = other.deserializeAttachment() as Session; return other !== ws && !a.closed && a.expiresAt > Date.now() && a.user?.id === identity.user.id; }).length >= 3) return fail('connection_limit', 429);
        const renewal = !!s.user;
        s.user = identity.user; s.expiresAt = identity.expiresAt; ws.serializeAttachment(s);
        await this.ctx.storage.transaction(() => this.delivery.schedule());
        s = ws.deserializeAttachment() as Session;
        if (s.closed || s.expiresAt <= Date.now()) return fail('login_required', 401);
        requireMember(this.store, identity.user);
        if (!renewal) this.broadcast({ type: 'presence', online: this.online() });
        return this.sessionFrame(ws, input, !renewal || !!s.visibilityBlocked);
      }
      if (!s.user) return fail('login_required', 401);
      requireMember(this.store, s.user);
      if (input.type === 'room:visibility') {
        if (typeof input.visibility !== 'string' || !['online', 'offline', 'hidden'].includes(input.visibility)) return fail('invalid_visibility');
        if (!await this.env.LIMITERS.getByName('room-visibility:' + s.user.id).check()) return fail('rate_limited', 429);
        s = ws.deserializeAttachment() as Session;
        if (s.closed || !s.user || s.expiresAt <= Date.now()) return fail('login_required', 401);
        requireMember(this.store, s.user);
        const policy = this.store.state().visibilityPolicy;
        if (!visibilityAllowed(policy, input.visibility as Visibility)) return fail('visibility_not_allowed', 403);
        if (!this.store.visibilityAllowed(s.user.id) && input.confirmPolicy !== policy) return fail('visibility_confirmation_required', 409);
        this.store.sql.exec('INSERT INTO room_visibility VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET visibility=excluded.visibility', s.user.id, String(input.visibility));
        this.syncVisibilityAccess();
        const value = { type: 'room:visibility', userId: s.user.id, visibility: input.visibility };
        for (const other of this.ctx.getWebSockets()) {
          const peer = other.deserializeAttachment() as Session;
          if (other !== ws && !peer.closed && peer.expiresAt > Date.now() && peer.user?.id === s.user.id) {
            try { other.send(JSON.stringify(value)); } catch { this.close(other); }
          }
        }
        this.broadcast({ type: 'presence', online: this.online(), members: this.store.visibleMembers(), silent: true });
        return value;
      }
      if (!this.store.visibilityAllowed(s.user.id)) return fail('visibility_confirmation_required', 409);
      if (input.type === 'send') {
        const saved = send(this.store, this.env, s.user, input);
        if (!saved.duplicate) this.broadcast({ type: 'message', message: saved.message });
        return { type: 'ack', message: saved.message };
      }
      if (input.type === 'history' || input.type === 'members') {
        if (s.readAt && s.readAt > Date.now() - 100) return fail('rate_limited', 429);
        s.readAt = Date.now(); ws.serializeAttachment(s);
        return { type: input.type, ...(input.type === 'history' ? history(this.store, s.user, input) : memberPage(this.store, s.user, input)) };
      }
      return fail('invalid_frame');
    });
    try { ws.send(JSON.stringify({ ...result.data, requestId, ...(result.status === 200 ? {} : { type: 'error' }) })); } catch {}
    if ([401, 404].includes(result.status)) this.close(ws, result.status === 401 ? 4001 : 4003);
  }
  async alarm() {
    if (!this.store.exists()) return;
    this.revokeConnections(); this.broadcast({ type: 'presence', online: this.online() }); await this.delivery.drain();
  }
  async webSocketClose(ws: WebSocket) { this.close(ws, 1000); this.broadcast({ type: 'presence', online: this.online() }); await this.ctx.storage.transaction(() => this.delivery.schedule()); }
  async webSocketError(ws: WebSocket) { await this.webSocketClose(ws); }
}
