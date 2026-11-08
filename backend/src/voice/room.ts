/* SPDX-License-Identifier: AGPL-3.0-only */
import { DurableObject } from 'cloudflare:workers';
import type { ChatEnv } from '../guest';
import type { Profile } from '../identity';
import { capability, configuration, description, digest, fail, identifier, randomToken, record, VoiceError, type VoiceResult } from './protocol';
import { Provider, type MediaSession } from './provider';

type Member = {
  id: string; tokenHash: string; user: Pick<Profile, 'id' | 'displayName' | 'avatarUrl' | 'authenticated'>;
  clientId: string; joinRequestId: string; chatId: string; chatConnectionId: string;
  authUntil: number; expiresAt: number; heartbeatAt: number; nextMutationAt: number;
  leaving: boolean; tombstoneUntil?: number; disconnectUntil?: number; generations: { publisher: number; receiver: number };
  publication?: { sessionId: string; trackName: string; version: string; microphone?: boolean; microphoneSequence?: number };
  turnUsers: string[]; ice?: Record<string, unknown>;
};
type Ticket = { user: Member['user']; chatConnectionId: string; chatId: string; authUntil: number; expiresAt: number };

export class VoiceRoom extends DurableObject<ChatEnv> {
  private provider: Provider;
  private active = new Set<string>();
  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);
    this.provider = new Provider(env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_members (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_tickets (hash TEXT PRIMARY KEY, data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_events (revision INTEGER PRIMARY KEY AUTOINCREMENT)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_operations (member_id TEXT NOT NULL, request_id TEXT NOT NULL, action TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT, expires_at INTEGER NOT NULL, PRIMARY KEY(member_id, request_id))');
  }
  private members(): Member[] { return this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM voice_members').toArray().map(row => JSON.parse(row.data)); }
  private sessions(): MediaSession[] { return this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM voice_sessions').toArray().map(row => JSON.parse(row.data)); }
  private save(member: Member) { this.ctx.storage.sql.exec('INSERT INTO voice_members VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', member.id, member.tokenHash, JSON.stringify(member)); }
  private saveSession(session: MediaSession) { this.ctx.storage.sql.exec('INSERT INTO voice_sessions VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', session.id, JSON.stringify(session)); }
  private latest(id: string): Member { return this.members().find(member => member.id === id) || fail('membership_expired', 401); }
  private current(id: string): MediaSession | undefined { return this.sessions().find(session => session.id === id); }
  private revision(): number { return this.ctx.storage.sql.exec<{ revision: number }>('SELECT COALESCE(MAX(rowid),0) AS revision FROM voice_events').one().revision; }
  private snapshot() {
    const now = Date.now();
    return { revision: this.revision(), members: this.members().filter(member => !member.leaving && this.expiry(member) > now).map(member => ({
      memberId: member.id, user: member.user, publishing: !!member.publication, publicationVersion: member.publication?.version || null,
      microphone: !!member.publication && member.publication.microphone !== false,
    })) };
  }
  getPresence() { return this.snapshot(); }
  private changed() {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_events (revision INTEGER PRIMARY KEY AUTOINCREMENT)');
    this.ctx.storage.sql.exec('INSERT INTO voice_events DEFAULT VALUES');
    this.ctx.storage.sql.exec('DELETE FROM voice_events WHERE revision < (SELECT MAX(revision) FROM voice_events)');
    const snapshot = this.snapshot();
    const chatId = this.members()[0]?.chatId;
    if (chatId) this.ctx.waitUntil(this.env.ROOMS.get(this.env.ROOMS.idFromString(chatId)).voiceChanged(snapshot).catch(() => {}));
  }
  private async schedule() {
    if (!this.members().length && !this.sessions().length && !this.ctx.storage.sql.exec('SELECT 1 FROM voice_tickets LIMIT 1').toArray().length) { await this.ctx.storage.deleteAlarm(); return; }
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > Date.now() + 20000) await this.ctx.storage.setAlarm(Date.now() + 20000);
  }
  async issueTicket(room: string, chatId: string, connectionId: string, user: Profile, authUntil: number): Promise<{ ticket?: string; code?: string }> {
    if (!configuration(this.env, room).enabled && this.env.VOICE_MODE !== 'drain') return { code: 'voice_disabled' };
    if ((!user.authenticated && this.env.VOICE_REQUIRE_PASS !== 'false') || authUntil <= Date.now()) return { code: 'login_required' };
    const token = randomToken();
    const hash = await digest(token);
    const ticket: Ticket = { user: { id: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl, authenticated: user.authenticated }, chatId, chatConnectionId: connectionId, authUntil, expiresAt: Date.now() + 30000 };
    this.ctx.storage.sql.exec('INSERT INTO voice_tickets VALUES (?,?)', hash, JSON.stringify(ticket));
    await this.schedule();
    return { ticket: token };
  }
  async disconnect(connectionId: string) {
    for (const member of this.members()) if (member.chatConnectionId === connectionId && !member.leaving) {
      member.disconnectUntil = Date.now() + 60000; this.save(member);
    }
    await this.schedule();
  }
  private async ticket(value: unknown): Promise<Ticket> {
    const hash = await digest(capability(value));
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM voice_tickets WHERE hash=?', hash).toArray()[0];
    if (!row) return fail('invalid_ticket', 401);
    const ticket: Ticket = JSON.parse(row.data);
    if (ticket.expiresAt <= Date.now() || ticket.authUntil <= Date.now()) return fail('invalid_ticket', 401);
    if (ticket.user.id.startsWith('guest:') && this.env.VOICE_REQUIRE_PASS !== 'false') return fail('login_required', 401);
    this.ctx.storage.sql.exec('DELETE FROM voice_tickets WHERE hash=?', hash);
    return ticket;
  }
  private expiry(member: Member) { return Math.min(member.authUntil, member.expiresAt, member.disconnectUntil ?? Number.MAX_SAFE_INTEGER); }
  private valid(member: Member) {
    if (member.leaving || this.expiry(member) <= Date.now()) return fail('membership_expired', 401);
    if (member.user.id.startsWith('guest:') && this.env.VOICE_REQUIRE_PASS !== 'false') return fail('login_required', 401);
    if (this.env.VOICE_MODE !== 'on' && this.env.VOICE_MODE !== 'drain') return fail('voice_disabled', 503);
    return member;
  }
  async handle(room: string, action: string, token: string, json: string): Promise<{ status: number; json: string }> {
    let input;
    try { input = record(JSON.parse(json)); } catch { return { status: 400, json: JSON.stringify({ code: 'invalid_request' }) }; }
    const result = await this.handleCommand(room, action, token, input);
    return { status: result.ok ? 200 : result.status, json: JSON.stringify(result.ok ? result.value : { code: result.code }) };
  }
  private async handleCommand(room: string, action: string, token: string, input: Record<string, unknown>): Promise<VoiceResult> {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_events (revision INTEGER PRIMARY KEY AUTOINCREMENT)');
    try {
      const hash = await digest(capability(token));
      let member = this.members().find(value => value.tokenHash === hash);
      if (action === 'join') {
        const clientId = identifier(input.clientId), joinRequestId = identifier(input.joinRequestId);
        if (member) {
          this.valid(member);
          if (member.clientId !== clientId || member.joinRequestId !== joinRequestId) return fail('invalid_request');
        } else {
          if (!configuration(this.env, room).enabled) return fail('voice_disabled', 503);
          const ticket = await this.ticket(input.ticket);
          if (this.members().some(value => value.user.id === ticket.user.id && !value.leaving)) return fail('voice_in_use', 409);
          // Departing members retain their slot until resources are confirmed closed.
          if (this.members().filter(value => !value.tombstoneUntil).length >= 8) return fail('room_full', 409);
          member = { id: crypto.randomUUID(), tokenHash: hash, user: ticket.user, clientId, joinRequestId,
            chatId: ticket.chatId, chatConnectionId: ticket.chatConnectionId, authUntil: ticket.authUntil,
            expiresAt: Date.now() + 90000, heartbeatAt: 0, nextMutationAt: 0, leaving: false,
            generations: { publisher: 0, receiver: 0 }, turnUsers: [] };
          this.save(member); this.changed();
        }
        await this.schedule();
        return { ok: true, value: this.state(member) };
      }
      if (!member) return fail('membership_expired', 401);
      if (action === 'leave') {
        this.retireMember(member); this.changed(); await this.schedule();
        this.ctx.waitUntil(this.cleanup());
        return { ok: true, value: { cleanupState: member.tombstoneUntil ? 'complete' : 'pending' } };
      }
      this.valid(member);
      if (action === 'renew') {
        const ticket = await this.ticket(input.ticket);
        member = this.valid(this.latest(member.id));
        if (ticket.user.id !== member.user.id || ticket.chatId !== member.chatId) return fail('invalid_ticket', 401);
        member.authUntil = ticket.authUntil; member.chatConnectionId = ticket.chatConnectionId; member.user = ticket.user;
        delete member.disconnectUntil;
        member.expiresAt = Date.now() + 90000; this.save(member); await this.schedule();
        return { ok: true, value: this.state(member) };
      }
      if (action === 'heartbeat') {
        if (Date.now() - member.heartbeatAt < 3000) return fail('rate_limited', 429);
        member.heartbeatAt = Date.now(); member.expiresAt = Date.now() + 90000; this.save(member);
        await this.schedule(); return { ok: true, value: this.state(member) };
      }
      if (action === 'ice') {
        const ice = await this.ice(member.id); await this.schedule();
        return { ok: true, value: ice };
      }
      const requestId = identifier(input.mutationId);
      const fingerprint = await digest(JSON.stringify(input));
      member = this.valid(this.latest(member.id));
      const cached = this.ctx.storage.sql.exec<{ action: string; fingerprint: string; result: string | null }>('SELECT action,fingerprint,result FROM voice_operations WHERE member_id=? AND request_id=?', member.id, requestId).toArray()[0];
      if (cached) {
        if (cached.action !== action || cached.fingerprint !== fingerprint) return fail('invalid_request');
        if (!cached.result) return fail('reconnect_required', 409);
        return { ok: true, value: JSON.parse(cached.result) };
      }
      if (!['publisher/ready', 'renegotiate', 'publisher/stop', 'publisher/state'].includes(action)) {
        if (Date.now() < member.nextMutationAt) return fail('rate_limited', 429);
        member.nextMutationAt = Date.now() + 400; this.save(member);
      }
      if (this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM voice_operations WHERE member_id=?', member.id).one().n >= 128) return fail('rate_limited', 429);
      this.ctx.storage.sql.exec('INSERT INTO voice_operations VALUES (?,?,?,?,NULL,?)', member.id, requestId, action, fingerprint, Date.now() + 120000);
      const value = await this.media(member, action, requestId, input);
      member = this.valid(this.latest(member.id));
      this.ctx.storage.sql.exec('UPDATE voice_operations SET result=? WHERE member_id=? AND request_id=?', JSON.stringify(value), member.id, requestId);
      await this.schedule();
      return { ok: true, value };
    } catch (error) {
      await this.schedule();
      return { ok: false, code: error instanceof VoiceError ? error.code : 'voice_unavailable', status: error instanceof VoiceError ? error.status : 503 };
    }
  }
  private state(member: Member): Record<string, unknown> {
    return { memberId: member.id, authUntil: member.authUntil, expiresAt: this.expiry(member), heartbeatEveryMs: 20000, snapshot: this.snapshot() };
  }
  private retireMember(member: Member) {
    member.leaving = true; delete member.publication; this.save(member);
    for (const session of this.sessions().filter(value => value.memberId === member.id)) { session.retired = true; this.saveSession(session); }
  }
  private assertSession(memberId: string, sessionId: string): MediaSession {
    this.valid(this.latest(memberId));
    const session = this.current(sessionId);
    if (!session || session.retired || session.deadline < Date.now()) return fail('reconnect_required', 409);
    return session;
  }
  private async ice(memberId: string) {
    let member = this.valid(this.latest(memberId));
    if (member.ice && Number(member.ice.iceExpiresAt) > Date.now() + 600000) return member.ice;
    const lock = `turn:${memberId}`;
    if (this.active.has(lock)) return fail('operation_busy', 409);
    this.active.add(lock);
    try {
      const value = await this.provider.ice();
      // Save credential ownership even when the user leaves during the call.
      member = this.latest(memberId);
      for (const item of value.iceServers) if ('username' in item && item.username) member.turnUsers.push(item.username);
      member.ice = value; this.save(member); this.valid(member);
      return value;
    } finally {
      this.active.delete(lock);
      if (this.latest(memberId).leaving) this.ctx.waitUntil(this.cleanup());
    }
  }
  private async media(member: Member, action: string, requestId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (action === 'publisher/state') {
      if (typeof input.microphone !== 'boolean' || !Number.isSafeInteger(input.sequence) || (input.sequence as number) < 1) return fail('invalid_request');
      const operationId = identifier(input.operationId);
      const session = this.sessions().find(value => value.memberId === member.id && value.direction === 'publisher'
        && value.operationId === operationId && value.generation === input.generation && value.phase === 'ready' && !value.retired);
      if (!session || member.publication?.version !== session.id) return fail('stale_generation', 409);
      this.assertSession(member.id, session.id);
      const previous = member.publication.microphoneSequence || 0;
      if (input.sequence === previous && member.publication.microphone !== input.microphone) return fail('invalid_request');
      if ((input.sequence as number) > previous) {
        member.publication.microphoneSequence = input.sequence as number;
        member.publication.microphone = input.microphone;
        this.save(member); this.changed();
      }
      return { microphone: member.publication.microphone !== false, sequence: member.publication.microphoneSequence || 0, snapshot: this.snapshot() };
    }
    if (action === 'publisher/stop') {
      const operationId = identifier(input.operationId);
      const sessions = this.sessions().filter(value => value.memberId === member.id && value.direction === 'publisher' && value.operationId === operationId);
      if (sessions.some(session => session.id === member.publication?.version)) { delete member.publication; this.save(member); }
      for (const session of sessions) { session.retired = true; this.saveSession(session); }
      this.changed(); this.ctx.waitUntil(this.cleanup()); return { stopped: true };
    }
    if (action === 'publisher/ready' || action === 'renegotiate') {
      const session = this.sessions().find(value => value.memberId === member.id && value.operationId === input.operationId && value.generation === input.generation && !value.retired);
      if (!session) return fail('stale_generation', 409);
      this.assertSession(member.id, session.id);
      if (action === 'renegotiate') {
        if (session.direction !== 'receiver' || session.phase !== 'answer') return fail('reconnect_required', 409);
        const answer = description(input.sessionDescription, 'answer');
        if (this.active.has(session.id)) return fail('operation_busy', 409);
        this.active.add(session.id);
        try {
          const result = await this.provider.sfu(`sessions/${session.providerId}/renegotiate`, 'PUT', { sessionDescription: answer });
          if (result.errorCode) return fail('upstream_unavailable', 502);
          this.assertSession(member.id, session.id);
        } finally { this.active.delete(session.id); }
      } else if (session.direction !== 'publisher' || session.phase !== 'answer') return fail('reconnect_required', 409);
      session.phase = 'ready'; session.deadline = Number.MAX_SAFE_INTEGER; this.saveSession(session);
      if (action === 'publisher/ready') {
        member = this.valid(this.latest(member.id));
        member.publication = { sessionId: session.providerId!, trackName: `mic-${session.id}`, version: session.id, microphone: true, microphoneSequence: 0 }; this.save(member); this.changed();
      }
      return { ready: true, snapshot: this.snapshot() };
    }
    if (action !== 'publisher/start' && action !== 'subscriptions') return fail('unknown_operation', 404);
    const direction = action === 'publisher/start' ? 'publisher' : 'receiver';
    let offer: ReturnType<typeof description> | undefined;
    let publications: { memberId: string; publication: NonNullable<Member['publication']> }[] = [];
    if (direction === 'publisher') {
      offer = description(input.sessionDescription, 'offer', true);
      if (typeof input.mid !== 'string' || !/^[a-zA-Z0-9_-]{1,16}$/.test(input.mid) || !offer.sdp.split(/\r?\n/).includes(`a=mid:${input.mid}`)) return fail('invalid_sdp');
    } else {
      if (!Array.isArray(input.memberIds) || input.memberIds.length > 7 || new Set(input.memberIds).size !== input.memberIds.length) return fail('invalid_request');
      publications = input.memberIds.map(id => {
        const peer = this.members().find(value => value.id === id && value.id !== member.id && value.publication && !value.leaving && this.expiry(value) > Date.now());
        if (!peer?.publication) return fail('publication_changed', 409);
        return { memberId: peer.id, publication: peer.publication };
      });
    }
    if (this.sessions().some(value => value.memberId === member.id && value.direction === direction && !value.retired && value.phase !== 'ready' && !(direction === 'receiver' && value.phase === 'answer' && !this.active.has(value.id)))) return fail('operation_busy', 409);
    for (const old of this.sessions().filter(value => value.memberId === member.id && value.direction === direction)) { old.retired = true; this.saveSession(old); }
    if (direction === 'publisher') { delete member.publication; this.save(member); this.changed(); }
    // Confirm old forwarding is closed before replacing this direction.
    await this.cleanup();
    member = this.valid(this.latest(member.id));
    if (this.sessions().some(value => value.memberId === member.id && value.direction === direction)) return fail('cleanup_pending', 409);
    if (direction === 'receiver' && !publications.length) return { empty: true };
    const ice = await this.ice(member.id);
    member = this.valid(this.latest(member.id));
    const session: MediaSession = { id: crypto.randomUUID(), memberId: member.id, direction, generation: ++member.generations[direction], mids: [], retired: false, operationId: requestId, phase: 'allocating', deadline: Date.now() + 30000 };
    // A persistent reservation precedes external I/O; leave/alarm can fence it.
    if (this.sessions().some(value => value.memberId === member.id && value.direction === direction)) return fail('operation_busy', 409);
    this.save(member); this.saveSession(session); await this.schedule(); this.active.add(session.id);
    try {
      const created = await this.provider.sfu('sessions/new', 'POST');
      if (typeof created.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(created.sessionId)) return fail('upstream_unavailable', 502);
      session.providerId = created.sessionId; session.retired = this.current(session.id)?.retired ?? true; this.saveSession(session);
      this.assertSession(member.id, session.id);
      session.phase = 'mutating'; session.uncertain = true; this.saveSession(session);
      const tracks = direction === 'publisher' ? [{ location: 'local', mid: input.mid, trackName: `mic-${session.id}` }]
        : publications.map(value => ({ location: 'remote', sessionId: value.publication.sessionId, trackName: value.publication.trackName }));
      const result = await this.provider.sfu(`sessions/${session.providerId}/tracks/new`, 'POST', { tracks, ...(offer ? { sessionDescription: offer } : {}) });
      // Retain every returned mid before validating partial success.
      const items = Array.isArray(result.tracks) ? result.tracks.map(record) : [];
      session.mids = items.flatMap(item => typeof item.mid === 'string' ? [item.mid] : []);
      session.uncertain = false; session.retired = this.current(session.id)?.retired ?? true; this.saveSession(session);
      this.assertSession(member.id, session.id);
      if (result.errorCode || items.length !== tracks.length || items.some(item => item.errorCode || typeof item.mid !== 'string')) return fail('upstream_unavailable', 502);
      const sdp = description(result.sessionDescription, direction === 'publisher' ? 'answer' : 'offer');
      if (direction === 'receiver' && result.requiresImmediateRenegotiation !== true) return fail('upstream_unavailable', 502);
      if (direction === 'receiver' && publications.some(value => this.latest(value.memberId).publication?.version !== value.publication.version)) return fail('publication_changed', 409);
      session.phase = 'answer'; session.deadline = Date.now() + 15000; this.saveSession(session);
      return { ...ice, operationId: requestId, generation: session.generation, sessionDescription: sdp,
        tracks: items.map((item, index) => ({ mid: item.mid, memberId: direction === 'receiver' ? publications[index].memberId : member.id })) };
    } catch (error) {
      session.retired = true; this.saveSession(session); throw error;
    } finally {
      this.active.delete(session.id);
      if (this.current(session.id)?.retired) this.ctx.waitUntil(this.cleanup());
    }
  }
  private async cleanup() {
    for (const session of this.sessions().filter(value => value.retired && !this.active.has(value.id))) {
      this.active.add(session.id);
      try {
        await this.provider.close(session);
        // An uncertain tracks/new can finish after timeout: keep querying/closing
        // on every alarm, rather than claiming an empty GET cancelled that request.
        if (!session.uncertain) this.ctx.storage.sql.exec('DELETE FROM voice_sessions WHERE id=?', session.id);
        else this.cleanupWarning(session, 'outcome_unknown');
      } catch (error) { this.cleanupWarning(session, error instanceof VoiceError ? error.code : 'cleanup_failed'); }
      finally { this.active.delete(session.id); }
    }
    for (const member of this.members().filter(value => value.leaving && !value.tombstoneUntil)) {
      if (this.sessions().some(session => session.memberId === member.id) || this.active.has(`turn:${member.id}`)) continue;
      this.active.add(`turn:${member.id}`);
      try {
        for (const username of member.turnUsers) await this.provider.revoke(username);
        const latest = this.latest(member.id); latest.tombstoneUntil = Date.now() + 600000; latest.turnUsers = []; delete latest.ice; this.save(latest);
      } catch { /* Retry credentials alongside media cleanup. */ }
      finally { this.active.delete(`turn:${member.id}`); }
    }
    await this.schedule();
  }
  private cleanupWarning(session: MediaSession, code: string) {
    session.cleanupAttempts = (session.cleanupAttempts || 0) + 1; this.saveSession(session);
    // Exponential log sampling; never log SDP, tokens or upstream response text.
    if ((session.cleanupAttempts & (session.cleanupAttempts - 1)) === 0) console.warn(JSON.stringify({ event: 'voice_cleanup_retry', direction: session.direction, code, attempts: session.cleanupAttempts }));
  }
  async alarm() {
    const now = Date.now();
    this.ctx.storage.sql.exec('DELETE FROM voice_operations WHERE expires_at<=?', now);
    for (const row of this.ctx.storage.sql.exec<{ hash: string; data: string }>('SELECT * FROM voice_tickets').toArray()) if ((JSON.parse(row.data) as Ticket).expiresAt <= now) this.ctx.storage.sql.exec('DELETE FROM voice_tickets WHERE hash=?', row.hash);
    let changed = false;
    for (const member of this.members()) {
      if (member.tombstoneUntil && member.tombstoneUntil <= now) { this.ctx.storage.sql.exec('DELETE FROM voice_members WHERE id=?', member.id); continue; }
      if (!member.leaving && (this.expiry(member) <= now || !['on', 'drain'].includes(this.env.VOICE_MODE || '') || (member.user.id.startsWith('guest:') && this.env.VOICE_REQUIRE_PASS !== 'false'))) { this.retireMember(member); changed = true; }
    }
    for (const session of this.sessions()) if (!session.retired && session.deadline <= now) {
      session.retired = true; this.saveSession(session);
      const member = this.latest(session.memberId);
      if (member.publication?.version === session.id) { delete member.publication; this.save(member); changed = true; }
    }
    if (changed) this.changed();
    await this.cleanup();
  }
}
