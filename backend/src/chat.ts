/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2026 The 25-ji-code-de Team
 * Compatible with cloudflare/workers-chat-demo; identity is verified server-side.
 */
import { DurableObject } from 'cloudflare:workers';
import { AUTH_LEASE_MS, guestProfile, ISSUER, profileFromUserInfo, type Profile } from './identity';
import { allowedOrigin, corsHeaders, guestSession, verifyGuest, type ChatEnv, type GuestIdentity } from './guest';

const HISTORY_LIMIT = 100;
const STORED_MESSAGE_LIMIT = 1000;
interface Session {
  limiterId: string;
  user: Profile | null;
  authExpiresAt: number;
  guest?: GuestIdentity | null;
  userLimiterId?: string;
  busy?: boolean;
  closed?: boolean;
}
type StoredMessage = { name: string; message: string; timestamp: number; profile: string };
type ChatMessage = { name: string; message: string; timestamp: number; user: Profile };
type Presence = { joined: string; user: Profile } | { quit: string; userId: string } | { type: 'profile'; user: Profile };

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
  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, message TEXT NOT NULL,
      timestamp INTEGER NOT NULL, profile TEXT NOT NULL
    )`);
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
      user: null, authExpiresAt: 0, guest,
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
          user = profileFromUserInfo(await result.json());
          if (initial.user?.authenticated && initial.user.id !== user.id) return this.authFailure(ws);
          authExpiresAt = Date.now() + AUTH_LEASE_MS;
        } else {
          if (frame.type === 'auth' || initial.user?.authenticated) return this.authFailure(ws);
          if (!initial.guest || initial.guest.expiresAt <= Date.now()) return this.guestFailure(ws);
          if (typeof frame.name !== 'string' || !frame.name.trim() || frame.name.length > 32) return this.reject(ws, 'Name must contain 1 to 32 characters.');
          user = guestProfile(frame.name.trim(), initial.guest.id);
        }
        if ((ws.deserializeAttachment() as Session).closed) return;
        if (initial.user && initial.user.id !== user.id) this.removeSession(ws);
        ws.serializeAttachment({
          ...initial, user, authExpiresAt, busy: true, closed: false,
          userLimiterId: this.env.LIMITERS.idFromName(`user:${user.id}`).toString(),
        } satisfies Session);
        const guestExpiresAt = user.authenticated ? 0 : initial.guest!.expiresAt;
        ws.send(JSON.stringify({ type: 'session', user, authExpiresAt, guestExpiresAt }));
        const sameIdentity = this.ctx.getWebSockets().filter(other => {
          if (other === ws) return false;
          const member = other.deserializeAttachment() as Session;
          return !member.closed && member.user?.id === user.id;
        });
        if (!user.authenticated && sameIdentity.length) {
          for (const other of sameIdentity) {
            other.serializeAttachment({ ...other.deserializeAttachment(), user });
            other.send(JSON.stringify({ type: 'session', user, authExpiresAt: 0, guestExpiresAt: (other.deserializeAttachment() as Session).guest?.expiresAt || 0 }));
          }
        }
        if (initial.user) {
          this.broadcast(initial.user.id === user.id ? { type: 'profile', user } : { joined: user.displayName, user });
          return;
        }
        const history = this.ctx.storage.sql.exec<StoredMessage>(
          'SELECT name, message, timestamp, profile FROM messages ORDER BY id DESC LIMIT ?', HISTORY_LIMIT,
        ).toArray().reverse();
        for (const entry of history) ws.send(JSON.stringify({ name: entry.name, message: entry.message, timestamp: entry.timestamp, user: JSON.parse(entry.profile) }));
        const seen = new Set<string>();
        for (const other of this.ctx.getWebSockets()) {
          const member = other.deserializeAttachment() as Session;
          if (other !== ws && member.user && !member.closed && !seen.has(member.user.id)) {
            seen.add(member.user.id);
            ws.send(JSON.stringify({ joined: member.user.displayName, user: member.user }));
          }
        }
        this.broadcast(sameIdentity.length ? { type: 'profile', user } : { joined: user.displayName, user });
        ws.send(JSON.stringify({ ready: true, user, authExpiresAt, guestExpiresAt }));
        return;
      }
      if ((ws.deserializeAttachment() as Session).closed) return;
      if (initial.user.authenticated && Date.now() >= initial.authExpiresAt) return this.reject(ws, 'Please refresh your SEKAI Pass session.', 'auth_required');
      if (!initial.user.authenticated && (!initial.guest || Date.now() >= initial.guest.expiresAt)) return this.guestFailure(ws);
      const previous = this.ctx.storage.sql.exec<{ timestamp: number }>('SELECT timestamp FROM messages ORDER BY id DESC LIMIT 1').toArray()[0];
      const entry: ChatMessage = {
        name: initial.user.displayName, message: frame.message as string, user: initial.user,
        timestamp: Math.max(Date.now(), (previous?.timestamp || 0) + 1),
      };
      const inserted = this.ctx.storage.sql.exec<{ id: number }>(
        'INSERT INTO messages (name, message, timestamp, profile) VALUES (?, ?, ?, ?) RETURNING id',
        entry.name, entry.message, entry.timestamp, JSON.stringify(entry.user),
      ).one();
      this.ctx.storage.sql.exec('DELETE FROM messages WHERE id <= ?', inserted.id - STORED_MESSAGE_LIMIT);
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
  private removeSession(ws: WebSocket): void {
    const session = ws.deserializeAttachment() as Session;
    if (session.closed) return;
    ws.serializeAttachment({ ...session, closed: true });
    if (!session.user) return;
    const anotherConnection = this.ctx.getWebSockets().some((other) => {
      const member = other.deserializeAttachment() as Session;
      return other !== ws && !member.closed && member.user?.id === session.user?.id;
    });
    if (!anotherConnection) this.broadcast({ quit: session.user.displayName, userId: session.user.id });
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
