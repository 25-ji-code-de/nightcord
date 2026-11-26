/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2026 The 25-ji-code-de Team
 * Compatible with cloudflare/workers-chat-demo; identity is verified server-side.
 */
import { DurableObject } from 'cloudflare:workers';
import { AUTH_LEASE_MS, guestProfile, ISSUER, profileFromUserInfo, type Profile } from './identity';
import { allowedOrigin, corsHeaders, guestSession, verifyGuest, type ChatEnv, type GuestIdentity } from './guest';
import { isMobileRequest } from './device';
import { configuration, readJson, record, VoiceError } from './voice/protocol';
import { roomsRoute } from './rooms/routes';
export { ManagedRoom } from './rooms/room';
import { dmRoute } from './dm/routes';
import { pushRoute } from './push';
import { RoomPush, pushDeviceKey, type RoomPushPreferences } from './room-push';
import { reply } from './messaging/protocol';
export { VoiceRoom } from './voice/room';
export { VoiceQuota } from './voice/quota';
export { DirectRoom } from './dm/room';
export { UserInbox } from './dm/inbox';

const HISTORY_LIMIT = 100;
const STORED_MESSAGE_LIMIT = 1000;
interface Session {
  limiterId: string;
  user: Profile | null;
  authExpiresAt: number;
  isMobile?: boolean;
  guest?: GuestIdentity | null;
  userLimiterId?: string;
  busy?: boolean;
  closed?: boolean;
  connectionId?: string;
  roomName?: string;
  voiceTicketAt?: number;
  voiceUsed?: boolean;
  pushDevice?: string;
  pushViewing?: boolean;
}
type StoredMessage = { name: string; message: string; timestamp: number; profile: string };
type ChatMessage = { name: string; message: string; timestamp: number; user: Profile };
type Visibility = 'online' | 'offline' | 'hidden';
type Presence = { joined: string; user: Profile; silent?: boolean } | { quit: string; userId: string; silent?: boolean }
  | { type: 'profile'; user: Profile } | { type: 'room:members'; users: Profile[] };

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({ service: 'nightcord-chat', status: 'ok', identity: 'sekai-pass' }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const origin = allowedOrigin(request, env);
    if (!origin) return response('Origin is not allowed', 403);
    if (url.pathname.startsWith('/api/push/')) return pushRoute(request, env, origin);
    if (url.pathname === '/api/rooms' || url.pathname.startsWith('/api/rooms/') || url.pathname === '/api/me/rooms') return roomsRoute(request, env, origin);
    if (url.pathname.startsWith('/api/dm/')) return dmRoute(request, env, origin);
    const voiceRoute = /^\/api\/room\/([a-z0-9-]{1,32}|[0-9a-f]{64})\/voice\/([a-z/]+)$/.exec(url.pathname);
    if (voiceRoute) {
      const headers = { ...corsHeaders(origin), 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (voiceRoute[2] === 'config' && request.method === 'GET') return Response.json(configuration(env, voiceRoute[1]), { headers });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers });
      const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('Authorization') || '')?.[1];
      if (!token) return Response.json({ code: 'invalid_token' }, { status: 401, headers });
      try {
        const input = record(await readJson(request));
        const chatId = voiceRoute[1].length === 64 ? env.ROOMS.idFromString(voiceRoute[1]) : env.ROOMS.idFromName(voiceRoute[1]);
        const result = await env.VOICE_ROOMS.getByName(`voice:${chatId}`).handle(voiceRoute[1], voiceRoute[2], token, JSON.stringify(input));
        return new Response(result.json, { status: result.status, headers: { ...headers, 'Content-Type': 'application/json' } });
      } catch (error) {
        return Response.json({ code: error instanceof VoiceError ? error.code : 'voice_unavailable' }, { status: error instanceof VoiceError ? error.status : 503, headers });
      }
    }
    if (url.pathname === '/api/guest/session' || url.pathname === '/api/room') {
      const headers = corsHeaders(origin);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
        ...headers, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400',
      } });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers });
      if (url.pathname === '/api/guest/session') {
        const limiter = env.LIMITERS.get(env.LIMITERS.idFromName(`bootstrap:${request.headers.get('CF-Connecting-IP') || 'local'}`));
        if (!await limiter.check()) return Response.json({ error: 'Please retry later.', code: 'rate_limited' }, { status: 429, headers });
        try { return await guestSession(request, env, origin); }
        catch { return Response.json({ error: 'Guest identity is temporarily unavailable.', code: 'guest_unavailable' }, { status: 503, headers }); }
      }
      return new Response(env.ROOMS.newUniqueId().toString(), { headers });
    }
    const match = /^\/api\/room\/([a-z0-9-]{1,32}|[0-9a-f]{64})\/websocket$/.exec(url.pathname);
    if (!match) return response('Not found', 404);
    if (request.method !== 'GET') return response('Method not allowed', 405);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return response('Expected WebSocket upgrade', 426);
    let id: DurableObjectId;
    try {
      id = match[1].length === 64 ? env.ROOMS.idFromString(match[1]) : env.ROOMS.idFromName(match[1]);
    } catch {
      return response('Unknown private room; create a new room on this server', 404);
    }
    return env.ROOMS.get(id).fetch(request);
  },
} satisfies ExportedHandler<ChatEnv>;

export class ChatRoom extends DurableObject<ChatEnv> {
  private roomPush: RoomPush;
  async roomPushSettings(actor: Profile, room: string, endpoint: string, preferences: RoomPushPreferences) {
    const result = await reply(async () => {
      const id = room.length === 64 ? this.env.ROOMS.idFromString(room) : this.env.ROOMS.idFromName(room);
      if (!id.equals(this.ctx.id)) throw new Error('Wrong room');
      const device = await pushDeviceKey(endpoint);
      this.ctx.storage.transactionSync(() => this.roomPush.manage(actor, room, endpoint, device, preferences));
      return {};
    });
    return { status: result.status, code: String(result.data.code || '') };
  }
  async alarm() { await this.roomPush.drain(); }
  directPeer(actorId: string, peerId: string): Profile | null {
    const rows = this.ctx.storage.sql.exec<{ id: string; profile: string }>('SELECT id,profile FROM room_members WHERE id IN (?,?)', actorId, peerId).toArray();
    if (rows.length !== 2) return null;
    const peer = rows.find(row => row.id === peerId);
    return peer ? JSON.parse(peer.profile) : null;
  }
  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, message TEXT NOT NULL,
      timestamp INTEGER NOT NULL, profile TEXT NOT NULL
    )`);
    const hasMembers = this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'room_members'").toArray().length;
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS room_members (id TEXT PRIMARY KEY, profile TEXT NOT NULL)');
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS room_visibility (
      id TEXT PRIMARY KEY, visibility TEXT NOT NULL CHECK (visibility IN ('online', 'offline', 'hidden'))
    )`);
    if (!hasMembers) {
      // Retain the latest verified identity from rooms that predate the member list.
      this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO room_members (id, profile)
        SELECT json_extract(profile, '$.id'), profile FROM messages
        WHERE json_extract(profile, '$.authenticated') = 1 AND json_extract(profile, '$.id') LIKE 'sekai:%'
        ORDER BY id DESC`);
    }
    this.roomPush = new RoomPush(ctx, env,
      owner => !!ctx.storage.sql.exec('SELECT 1 FROM room_members WHERE id=?', owner).toArray().length,
      () => new Set(ctx.getWebSockets().flatMap(ws => {
        const s = ws.deserializeAttachment() as Session;
        return !s.closed && s.user && s.authExpiresAt > Date.now() && s.pushDevice && s.pushViewing ? [s.user.id + '\n' + s.pushDevice] : [];
      })));
  }

  async fetch(request: Request): Promise<Response> {
    if (!allowedOrigin(request, this.env)) return response('Origin is not allowed', 403);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return response('Expected WebSocket upgrade', 426);
    let guest: GuestIdentity | null;
    try { guest = await verifyGuest(request, this.env); }
    catch { return response('Guest identity is temporarily unavailable', 503); }
    if (this.ctx.getWebSockets().length >= 256) return response('Room is full', 503);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({
      limiterId: this.env.LIMITERS.idFromName(`ip:${request.headers.get('CF-Connecting-IP') || 'local'}`).toString(),
      user: null, authExpiresAt: 0, guest, isMobile: isMobileRequest(request), connectionId: crypto.randomUUID(),
      roomName: /^\/api\/room\/([^/]+)\/websocket$/.exec(new URL(request.url).pathname)?.[1],
    } satisfies Session);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > 8192) return this.reject(ws, 'Invalid message frame.');
    let data: unknown;
    try { data = JSON.parse(raw); } catch { return this.reject(ws, 'Invalid JSON.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return this.reject(ws, 'Expected a JSON object.');
    const frame = data as Record<string, unknown>;
    const initial = ws.deserializeAttachment() as Session;
    if (initial.closed) return;
    if (frame.type === 'push:attention') {
      if (initial.user?.authenticated && initial.authExpiresAt > Date.now() && typeof frame.device === 'string' && /^[a-f0-9]{64}$/.test(frame.device) && typeof frame.viewing === 'boolean') {
        ws.serializeAttachment({ ...initial, pushDevice: frame.device, pushViewing: frame.viewing });
        if (frame.viewing) this.roomPush.read(initial.user.id, frame.device);
      }
      return;
    }
    if (frame.type === 'room:visibility') return this.setVisibility(ws, initial, frame);
    if (frame.type === 'voice:ticket') {
      const requestId = typeof frame.requestId === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(frame.requestId) ? frame.requestId : null;
      if (!requestId) return;
      const send = (value: Record<string, unknown>) => { try { ws.send(JSON.stringify({ type: 'voice:ticket', requestId, ...value })); } catch { /* Socket left. */ } };
      const user = initial.user;
      const authUntil = user?.authenticated ? initial.authExpiresAt
        : user && initial.guest?.id === user.id ? initial.guest.expiresAt : 0;
      if (!user || authUntil <= Date.now() || (!user.authenticated && this.env.VOICE_REQUIRE_PASS !== 'false')) { send({ code: 'login_required' }); return; }
      if (Date.now() - (initial.voiceTicketAt || 0) < 1000) { send({ code: 'rate_limited' }); return; }
      ws.serializeAttachment({ ...initial, voiceTicketAt: Date.now(), voiceUsed: true });
      try {
        const result = await this.env.VOICE_ROOMS.getByName(`voice:${this.ctx.id}`).issueTicket(initial.roomName || '', this.ctx.id.toString(), initial.connectionId!, user, authUntil);
        if ((ws.deserializeAttachment() as Session).closed) return;
        send({ ticket: result.ticket, code: result.code });
      } catch { send({ code: 'voice_unavailable' }); }
      return;
    }
    if (initial.busy) return this.reject(ws, 'Please wait for the previous action.');
    if (initial.user && frame.type !== 'auth' && (typeof frame.message !== 'string' || frame.message.length > 256)) {
      return this.reject(ws, 'Message must be a string of at most 256 characters.');
    }
    ws.serializeAttachment({ ...initial, busy: true });
    try {
      const limiterIds = !initial.user || frame.type === 'auth' ? [initial.limiterId]
        : initial.user.authenticated ? [initial.userLimiterId || initial.limiterId]
        : [initial.limiterId, initial.userLimiterId || this.env.LIMITERS.idFromName(`user:${initial.user.id}`).toString()];
      const checks = await Promise.all(limiterIds.map(id => this.env.LIMITERS.get(this.env.LIMITERS.idFromString(id)).check()));
      if (checks.some(allowed => !allowed)) {
        this.reject(ws, 'Your IP or account is being rate-limited, please try again later.', 'rate_limited');
        if (!initial.user || frame.type === 'auth') ws.close(1013, 'Please retry later');
        return;
      }
      if (!initial.user || frame.type === 'auth') {
        let user: Profile;
        let authExpiresAt = 0;
        // Device hints are connection metadata, independent of account identity.
        const isMobile = initial.isMobile === true || initial.user?.isMobile === true || (!initial.user && frame.isMobile === true);
        if ('accessToken' in frame) {
          if (typeof frame.accessToken !== 'string' || !frame.accessToken || frame.accessToken.length > 4096) return this.authFailure(ws);
          // Bearer tokens stay on the service-binding path and are never stored or broadcast.
          const result = await this.env.SEKAI_PASS.fetch(`${ISSUER}/oauth/userinfo`, {
            headers: { Authorization: `Bearer ${frame.accessToken}` }, signal: AbortSignal.timeout(10_000),
          });
          if (!result.ok) {
            if (result.status === 401 || result.status === 403) return this.authFailure(ws);
            return this.reject(ws, 'SEKAI Pass is temporarily unavailable.', 'auth_unavailable');
          }
          user = profileFromUserInfo(await result.json(), isMobile);
          if (initial.user?.authenticated && initial.user.id !== user.id) return this.authFailure(ws);
          authExpiresAt = Date.now() + AUTH_LEASE_MS;
        } else {
          if (frame.type === 'auth' || initial.user?.authenticated) return this.authFailure(ws);
          if (!initial.guest || initial.guest.expiresAt <= Date.now()) return this.guestFailure(ws);
          if (typeof frame.name !== 'string' || !frame.name.trim() || frame.name.length > 32) return this.reject(ws, 'Name must contain 1 to 32 characters.');
          user = guestProfile(frame.name.trim(), initial.guest.id, isMobile);
        }
        if ((ws.deserializeAttachment() as Session).closed) return;
        if (initial.user && initial.user.id !== user.id) this.removeSession(ws);
        ws.serializeAttachment({
          ...initial, user, authExpiresAt, isMobile, busy: true, closed: false,
          userLimiterId: this.env.LIMITERS.idFromName(`user:${user.id}`).toString(),
        } satisfies Session);
        if (user.authenticated) {
          this.ctx.storage.sql.exec('INSERT INTO room_members (id, profile) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET profile = excluded.profile', user.id, JSON.stringify({ ...user, isMobile: false }));
        }
        const guestExpiresAt = user.authenticated ? 0 : initial.guest!.expiresAt;
        const visibility = this.visibility(user.id);
        ws.send(JSON.stringify({ type: 'session', user, authExpiresAt, guestExpiresAt, visibility }));
        const sameIdentity = this.ctx.getWebSockets().filter(other => {
          if (other === ws) return false;
          const member = other.deserializeAttachment() as Session;
          return !member.closed && member.user?.id === user.id;
        });
        if (!user.authenticated && sameIdentity.length) {
          for (const other of sameIdentity) {
            const member = other.deserializeAttachment() as Session;
            const otherUser = { ...user, isMobile: member.user?.isMobile === true };
            other.serializeAttachment({ ...member, user: otherUser });
            other.send(JSON.stringify({ type: 'session', user: otherUser, authExpiresAt: 0, guestExpiresAt: member.guest?.expiresAt || 0, visibility }));
          }
        }
        const presenceUser = this.presenceProfile(user);
        if (initial.user) {
          if (visibility === 'online') this.broadcast(initial.user.id === user.id ? { type: 'profile', user: presenceUser } : { joined: user.displayName, user: presenceUser });
          else if (visibility === 'offline' && user.authenticated) this.broadcast({ type: 'room:members', users: this.visibleMembers() });
          return;
        }
        const history = this.ctx.storage.sql.exec<StoredMessage>(
          'SELECT name, message, timestamp, profile FROM messages ORDER BY id DESC LIMIT ?', HISTORY_LIMIT,
        ).toArray().reverse();
        for (const entry of history) ws.send(JSON.stringify({ name: entry.name, message: entry.message, timestamp: entry.timestamp, user: { isMobile: false, ...JSON.parse(entry.profile) } }));
        const seen = new Set<string>();
        for (const other of this.ctx.getWebSockets()) {
          const member = other.deserializeAttachment() as Session;
          if (other !== ws && member.user && !member.closed && !seen.has(member.user.id) && this.visibility(member.user.id) === 'online') {
            seen.add(member.user.id);
            ws.send(JSON.stringify({ joined: member.user.displayName, user: this.presenceProfile(member.user) }));
          }
        }
        if (visibility === 'online') this.broadcast(sameIdentity.length ? { type: 'profile', user: presenceUser } : { joined: user.displayName, user: presenceUser });
        const users = this.visibleMembers();
        if (visibility === 'offline' && user.authenticated) this.broadcast({ type: 'room:members', users });
        ws.send(JSON.stringify({ type: 'room:members', users }));
        if (configuration(this.env, initial.roomName || '').enabled || this.env.VOICE_MODE === 'drain') {
          try {
            const snapshot = await this.env.VOICE_ROOMS.getByName(`voice:${this.ctx.id}`).getPresence();
            if ((ws.deserializeAttachment() as Session).closed) return;
            ws.send(JSON.stringify({ type: 'voice:state', snapshot }));
          } catch { /* Voice discovery must not prevent joining text chat. */ }
        }
        ws.send(JSON.stringify({ ready: true, user, authExpiresAt, guestExpiresAt }));
        return;
      }
      if ((ws.deserializeAttachment() as Session).closed) return;
      if (initial.user.authenticated && Date.now() >= initial.authExpiresAt) return this.reject(ws, 'Please refresh your SEKAI Pass session.', 'auth_required');
      if (!initial.user.authenticated && (!initial.guest || Date.now() >= initial.guest.expiresAt)) return this.guestFailure(ws);
      const previous = this.ctx.storage.sql.exec<{ timestamp: number }>('SELECT timestamp FROM messages ORDER BY id DESC LIMIT 1').toArray()[0];
      const entry: ChatMessage = {
        name: initial.user.displayName, message: frame.message as string, user: { ...initial.user, isMobile: initial.user.isMobile === true },
        timestamp: Math.max(Date.now(), (previous?.timestamp || 0) + 1),
      };
      await this.ctx.storage.transaction(async () => {
        const inserted = this.ctx.storage.sql.exec<{ id: number }>(
          'INSERT INTO messages (name, message, timestamp, profile) VALUES (?, ?, ?, ?) RETURNING id',
          entry.name, entry.message, entry.timestamp, JSON.stringify(entry.user),
        ).one();
        this.ctx.storage.sql.exec('DELETE FROM messages WHERE id <= ?', inserted.id - STORED_MESSAGE_LIMIT);
        if (this.roomPush.enqueue(entry.user.id, entry.message, timestamp => this.ctx.storage.sql.exec<{ owner: string }>(
          "SELECT json_extract(profile,'$.id') AS owner FROM messages WHERE timestamp=? LIMIT 1", timestamp).toArray()[0]?.owner)) await this.roomPush.schedule();
      });
      this.broadcast(entry);
    } catch (error) {
      console.error('Chat event failed', error instanceof Error ? error.message : 'Unknown error');
      this.reject(ws, 'Unable to process action; please reconnect and try again.', !initial.user || frame.type === 'auth' ? 'auth_unavailable' : undefined);
    } finally {
      ws.serializeAttachment({ ...ws.deserializeAttachment(), busy: false });
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.removeSession(ws);
    // Complete the peer's close handshake instead of leaving it waiting for a timeout.
    ws.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason);
  }
  webSocketError(ws: WebSocket): void { this.removeSession(ws); ws.close(1011, 'Connection error'); }
  private reject(ws: WebSocket, error: string, code?: string): void { ws.send(JSON.stringify({ error, code })); }
  private authFailure(ws: WebSocket): void {
    this.reject(ws, 'SEKAI Pass session is invalid or expired. Please sign in again.', 'auth_invalid');
    this.removeSession(ws);
    ws.close(4001, 'Authentication required');
  }
  private guestFailure(ws: WebSocket): void {
    this.reject(ws, 'Please refresh this page and enable cookies to retain your guest identity, or sign in with SEKAI Pass.', 'guest_session_required');
    this.removeSession(ws);
    ws.close(4002, 'Guest credential required');
  }
  private visibility(id: string): Visibility {
    return this.ctx.storage.sql.exec<{ visibility: Visibility }>('SELECT visibility FROM room_visibility WHERE id = ?', id).toArray()[0]?.visibility || 'online';
  }
  private visibleMembers(): Profile[] {
    return this.ctx.storage.sql.exec<{ profile: string }>(`SELECT m.profile FROM room_members m
      LEFT JOIN room_visibility v ON v.id = m.id WHERE v.visibility IS NULL OR v.visibility != 'hidden'
      ORDER BY m.rowid`).toArray().map(row => JSON.parse(row.profile) as Profile);
  }
  private async setVisibility(ws: WebSocket, initial: Session, frame: Record<string, unknown>): Promise<void> {
    const requestId = typeof frame.requestId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(frame.requestId) ? frame.requestId : undefined;
    const fail = (error: string, code: string) => ws.send(JSON.stringify({ type: 'room:visibility', requestId, error, code }));
    const user = initial.user;
    if (!user || (user.authenticated ? initial.authExpiresAt : initial.guest?.expiresAt || 0) <= Date.now()) {
      fail('连接身份已过期，请重新连接后再试。', 'auth_required'); return;
    }
    if (!requestId || !['online', 'offline', 'hidden'].includes(frame.visibility as string)) {
      fail('请选择有效的显示状态。', 'invalid_visibility'); return;
    }
    if (initial.busy) { fail('正在处理其他操作，请稍后再试。', 'busy'); return; }
    ws.serializeAttachment({ ...initial, busy: true });
    try {
      if (!await this.env.LIMITERS.getByName(`room-visibility:${user.id}`).check()) {
        fail('切换过于频繁，请稍后再试。', 'rate_limited'); return;
      }
      const current = ws.deserializeAttachment() as Session;
      if (current.closed) return;
      if (current.user?.id !== user.id || (user.authenticated ? current.authExpiresAt : current.guest?.expiresAt || 0) <= Date.now()) {
        fail('连接身份已过期，请重新连接后再试。', 'auth_required'); return;
      }
      const visibility = frame.visibility as Visibility, previous = this.visibility(user.id);
      // Scope comes from the verified identity and this room, never a supplied user ID.
      this.ctx.storage.sql.exec(`INSERT INTO room_visibility (id, visibility) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET visibility = excluded.visibility`, user.id, visibility);
      for (const other of this.ctx.getWebSockets()) {
        const session = other.deserializeAttachment() as Session;
        if (session.closed || session.user?.id !== user.id) continue;
        try { other.send(JSON.stringify({ type: 'room:visibility', userId: user.id, visibility, ...(other === ws ? { requestId } : {}) })); }
        catch { this.removeSession(other); }
      }
      if (previous !== visibility) {
        // Update lists without announcing a fabricated join/leave or ringing alerts.
        if (previous === 'online') this.broadcast({ quit: user.displayName, userId: user.id, silent: true });
        if (visibility === 'online') this.broadcast({ joined: user.displayName, user: this.presenceProfile(user), silent: true });
        this.broadcast({ type: 'room:members', users: this.visibleMembers() });
      }
    } catch {
      fail('保存失败，请稍后重试。', 'visibility_unavailable');
    } finally {
      ws.serializeAttachment({ ...ws.deserializeAttachment(), busy: false });
    }
  }
  private presenceProfile(user: Profile): Profile {
    return { ...user, isMobile: this.ctx.getWebSockets().some(other => {
      const member = other.deserializeAttachment() as Session;
      return !member.closed && member.user?.id === user.id && member.user.isMobile === true;
    }) };
  }
  private removeSession(ws: WebSocket): void {
    const session = ws.deserializeAttachment() as Session;
    if (session.closed) return;
    ws.serializeAttachment({ ...session, closed: true });
    if (session.voiceUsed && session.connectionId) this.ctx.waitUntil(this.env.VOICE_ROOMS.getByName(`voice:${this.ctx.id}`).disconnect(session.connectionId).catch(() => {}));
    if (!session.user) return;
    if (this.visibility(session.user.id) !== 'online') return;
    const anotherConnection = this.ctx.getWebSockets().find((other) => {
      const member = other.deserializeAttachment() as Session;
      return other !== ws && !member.closed && member.user?.id === session.user?.id;
    });
    if (!anotherConnection) this.broadcast({ quit: session.user.displayName, userId: session.user.id });
    else this.broadcast({ type: 'profile', user: this.presenceProfile((anotherConnection.deserializeAttachment() as Session).user!) });
  }
  voiceChanged(snapshot: { revision: number; members: unknown[] }): void {
    const text = JSON.stringify({ type: 'voice:state', snapshot });
    for (const ws of this.ctx.getWebSockets()) {
      const session = ws.deserializeAttachment() as Session;
      if (!session.user || session.closed) continue;
      try { ws.send(text); } catch { this.removeSession(ws); }
    }
  }
  private broadcast(data: ChatMessage | Presence): void {
    const text = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      const session = ws.deserializeAttachment() as Session;
      if (!session.user || session.closed) continue;
      try { ws.send(text); } catch { this.removeSession(ws); }
    }
  }
}

export class RateLimiter extends DurableObject<ChatEnv> {
  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS rate_limit (id INTEGER PRIMARY KEY CHECK (id = 1), next_allowed INTEGER NOT NULL)');
  }
  check(): boolean {
    const now = Date.now();
    const row = this.ctx.storage.sql.exec<{ next_allowed: number }>('SELECT next_allowed FROM rate_limit WHERE id = 1').toArray()[0];
    const nextAllowed = Math.max(now, row?.next_allowed || 0);
    if (nextAllowed > now + 20_000) return false;
    this.ctx.storage.sql.exec('INSERT INTO rate_limit (id, next_allowed) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET next_allowed = excluded.next_allowed', nextAllowed + 5000);
    return true;
  }
}
