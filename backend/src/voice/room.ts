/* SPDX-License-Identifier: AGPL-3.0-only */
import { DurableObject } from 'cloudflare:workers';
import type { ChatEnv } from '../guest';
import type { Profile } from '../identity';
import { capability, configuration, description, digest, fail, identifier, randomToken, record, VoiceError, type VoiceResult } from './protocol';
import { Provider, type MediaSession } from './provider';
import type { VoiceUsage } from './quota';
import { cleanupComplete, retryAfter, type RetryState } from './cleanup';

type Member = {
  id: string; tokenHash: string; user: Pick<Profile, 'id' | 'displayName' | 'avatarUrl' | 'authenticated'>;
  clientId: string; joinRequestId: string; chatId: string; chatConnectionId: string;
  authUntil: number; expiresAt: number; heartbeatAt: number; nextMutationAt: number;
  leaving: boolean; tombstoneUntil?: number; disconnectUntil?: number; generations: { publisher: number; receiver: number };
  publication?: { sessionId: string; trackName: string; version: string; microphone?: boolean; microphoneSequence?: number };
  turnUsers: string[]; turnCredentials?: TurnCredential[]; ice?: Record<string, unknown>;
  cleanupVersion?: number; mediaClosedAt?: number; settlementRetry?: RetryState; legacySettlementReview?: boolean;
  quotaUntil?: number; usage?: VoiceUsage; leaveReason?: string;
};
type TurnCredential = { id: string; username: string; keyId?: string; expiresAt: number; retry?: RetryState };
type TurnCleanup = TurnCredential & { memberId: string };
type Ticket = { user: Member['user']; chatConnectionId: string; chatId: string; authUntil: number; expiresAt: number };

export class VoiceRoom extends DurableObject<ChatEnv> {
  private provider: Provider;
  private active = new Set<string>();
  private pendingQuota = new Map<string, Promise<Member>>();
  private cleanupSlots = 0;
  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);
    this.provider = new Provider(env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_members (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_tickets (hash TEXT PRIMARY KEY, data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_events (revision INTEGER PRIMARY KEY AUTOINCREMENT)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_operations (member_id TEXT NOT NULL, request_id TEXT NOT NULL, action TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT, expires_at INTEGER NOT NULL, PRIMARY KEY(member_id, request_id))');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_turn_cleanup (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    if (this.migrateCleanup()) ctx.blockConcurrencyWhile(() => this.schedule());
  }
  private members(): Member[] { return this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM voice_members').toArray().map(row => JSON.parse(row.data)); }
  private sessions(): MediaSession[] { return this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM voice_sessions').toArray().map(row => JSON.parse(row.data)); }
  private save(member: Member) { this.ctx.storage.sql.exec('INSERT INTO voice_members VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', member.id, member.tokenHash, JSON.stringify(member)); }
  private saveSession(session: MediaSession) {
    const stored = this.current(session.id);
    if (stored?.retired) { session.retired = true; session.retiredAt ??= stored.retiredAt; session.cleanup ??= stored.cleanup; }
    if (session.retired) session.retiredAt ??= Date.now();
    this.ctx.storage.sql.exec('INSERT INTO voice_sessions VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', session.id, JSON.stringify(session));
  }
  private turnTasks(): TurnCleanup[] { return this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM voice_turn_cleanup').toArray().map(row => JSON.parse(row.data)); }
  private saveTurn(task: TurnCleanup) { this.ctx.storage.sql.exec('INSERT INTO voice_turn_cleanup VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', task.id, JSON.stringify(task)); }
  private enqueueTurn(member: Member) {
    for (const credential of member.turnCredentials || []) this.saveTurn({ ...credential, memberId: member.id });
    member.turnCredentials = []; member.turnUsers = []; delete member.ice;
  }
  private migrateCleanup() {
    let migrated = false;
    this.ctx.storage.transactionSync(() => {
      const now = Date.now(), sessions = this.sessions();
      for (const member of this.members()) if (!member.cleanupVersion) {
        // Historical code always issued a one-hour TTL. A missing cache uses a
        // conservative upper bound from migration, never a guessed past expiry.
        const cachedExpiry = Number(member.ice?.iceExpiresAt);
        const expiresAt = Number.isSafeInteger(cachedExpiry) && cachedExpiry > 0 ? cachedExpiry : now + 3600000;
        member.turnCredentials = [...new Set(member.turnUsers)].map(username => ({ id: crypto.randomUUID(), username, expiresAt }));
        member.cleanupVersion = 1;
        member.legacySettlementReview = member.leaving && !member.tombstoneUntil && !sessions.some(session => session.memberId === member.id);
        if (member.leaving) this.enqueueTurn(member);
        this.save(member); migrated = true;
      }
      for (const session of sessions) if (session.retired && !session.cleanup) {
        session.cleanup = { attempts: session.cleanupAttempts || 0, nextAttemptAt: now + Math.floor(Math.random() * 5000),
          ...(session.cleanupAttempts ? { firstFailedAt: now - 300000 } : {}) };
        this.saveSession(session); migrated = true;
      }
    });
    return migrated;
  }
  private latest(id: string): Member { return this.members().find(member => member.id === id) || fail('membership_expired', 401); }
  private current(id: string): MediaSession | undefined { return this.sessions().find(session => session.id === id); }
  private revision(): number { return this.ctx.storage.sql.exec<{ revision: number }>('SELECT COALESCE(MAX(rowid),0) AS revision FROM voice_events').one().revision; }
  private snapshot() {
    const now = Date.now();
    const members = this.members();
    return { revision: this.revision(), departures: members.filter(member => member.leaving && member.leaveReason).map(member => ({ memberId: member.id, code: member.leaveReason })), members: members.filter(member => !member.leaving && this.expiry(member) > now).map(member => ({
      memberId: member.id, user: member.user, publishing: !!member.publication, publicationVersion: member.publication?.version || null,
      microphone: !!member.publication && member.publication.microphone !== false,
    })) };
  }
  getPresence() { return this.snapshot(); }
  private changed() {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_events (revision INTEGER PRIMARY KEY AUTOINCREMENT)');
    this.ctx.storage.sql.exec('INSERT INTO voice_events DEFAULT VALUES');
    this.ctx.storage.sql.exec('DELETE FROM voice_events WHERE revision < (SELECT MAX(revision) FROM voice_events)');
    this.publishPresence();
  }
  private publishPresence() {
    const snapshot = this.snapshot();
    const members = this.members(), chatId = members[0]?.chatId;
    const lease = { observedAt: Date.now(), expiresAt: Object.fromEntries(members.filter(member => !member.leaving).map(member => [member.id, this.expiry(member)])) };
    if (chatId) this.ctx.waitUntil(this.env.ROOMS.get(this.env.ROOMS.idFromString(chatId)).voiceChanged(snapshot, lease).catch(() => {}));
  }
  private async schedule() {
    await this.ctx.storage.transaction(async txn => {
      const alarm = await txn.getAlarm(), now = Date.now(), deadlines: number[] = [];
      const sessions = this.sessions();
      const budget = this.cleanupBudget();
      const taskDeadline = (due: number) => this.cleanupSlots >= 2 ? Math.max(due, now + 10000)
        : budget - now < 50 ? Math.max(due, budget) : due;
      for (const member of this.members()) {
        if (member.tombstoneUntil) deadlines.push(member.tombstoneUntil);
        else if (!member.leaving) deadlines.push(Math.min(now + 20000, this.expiry(member), member.quotaUntil ?? now + 20000));
        else if (!sessions.some(session => session.memberId === member.id)) {
          deadlines.push(this.pendingQuota.has(member.id) || this.active.has(`turn:${member.id}`) || this.active.has(`settle:${member.id}`)
            ? now + 10000 : member.settlementRetry?.nextAttemptAt ?? now + 1);
        }
      }
      for (const session of sessions) {
        deadlines.push(session.retired
          ? this.active.has(session.id) ? now + 10000 : taskDeadline(session.cleanup?.nextAttemptAt ?? now + 1)
          : session.deadline);
      }
      for (const task of this.turnTasks()) deadlines.push(Math.min(task.expiresAt,
        task.keyId ? taskDeadline(task.retry?.nextAttemptAt ?? now + 1) : task.expiresAt));
      for (const row of this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM voice_tickets').toArray()) deadlines.push((JSON.parse(row.data) as Ticket).expiresAt);
      const operation = this.ctx.storage.sql.exec<{ deadline: number | null }>('SELECT MIN(expires_at) AS deadline FROM voice_operations').one().deadline;
      if (operation !== null) deadlines.push(operation);
      if (!deadlines.length) { if (alarm !== null) await txn.deleteAlarm(); return; }
      const deadline = Math.max(now + 1, Math.min(...deadlines));
      // Recompute from current persisted work inside the transaction. A completed
      // attempt may have moved its retry beyond the in-flight watchdog. Keeping
      // that old alarm wakes an idle room before anything can make progress.
      // Authentication, quota and concurrent tasks are all included above.
      if (alarm !== deadline) await txn.setAlarm(deadline);
    });
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
  private valid(member: Member, refreshingQuota = false) {
    if (member.leaving || this.expiry(member) <= Date.now()) return fail(member.leaveReason || 'membership_expired', 401);
    if (member.user.id.startsWith('guest:') && this.env.VOICE_REQUIRE_PASS !== 'false') return fail('login_required', 401);
    if (this.env.VOICE_MODE !== 'on' && this.env.VOICE_MODE !== 'drain') return fail('voice_disabled', 503);
    if (!refreshingQuota && (!member.quotaUntil || member.quotaUntil <= Date.now())) return fail('voice_quota_expired', 401);
    return member;
  }
  private async quota(member: Member): Promise<Member> {
    const existing = this.pendingQuota.get(member.id);
    if (existing) return existing;
    const pending = this.grantQuota(member); this.pendingQuota.set(member.id, pending);
    try { return await pending; }
    finally {
      this.pendingQuota.delete(member.id);
      if (this.latest(member.id).leaving) { this.recordMediaClosure(member.id); this.ctx.waitUntil(this.cleanup()); }
    }
  }
  private async grantQuota(member: Member): Promise<Member> {
    try {
      this.valid(member, true);
      const request = this.env.VOICE_QUOTAS.getByName('voice-minutes-v1').grant(member.id, this.ctx.id.toString(), member.user.id, this.expiry(member));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new VoiceError('voice_quota_unavailable', 503)), Math.min(5000, Math.max(1, (member.quotaUntil ?? Date.now() + 5000) - Date.now())));
      });
      const grant = await Promise.race([request, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
      if (!grant.ok) return fail(grant.code, grant.code.endsWith('_limit') ? 429 : 503);
      member = this.latest(member.id); member.quotaUntil = grant.until; member.usage = grant.usage; this.save(member);
      return this.valid(member);
    } catch (error) {
      const failure = error instanceof VoiceError ? error : new VoiceError('voice_quota_unavailable', 503);
      member = this.latest(member.id);
      if (!member.leaving) { this.retireMember(member, failure.code); this.changed(); }
      throw failure;
    }
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
          this.valid(member, true);
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
            generations: { publisher: 0, receiver: 0 }, turnUsers: [], turnCredentials: [], cleanupVersion: 1 };
          this.save(member); this.changed();
        }
        member = await this.quota(member);
        await this.schedule();
        return { ok: true, value: this.state(member) };
      }
      if (!member) return fail('membership_expired', 401);
      if (action === 'leave') {
        if (!member.leaving) { this.retireMember(member); this.changed(); }
        await this.schedule();
        this.ctx.waitUntil(this.cleanup());
        return { ok: true, value: { cleanupState: member.tombstoneUntil ? 'complete' : 'pending' } };
      }
      this.valid(member, true);
      if (action === 'renew') {
        const ticket = await this.ticket(input.ticket);
        member = this.valid(this.latest(member.id), true);
        if (ticket.user.id !== member.user.id || ticket.chatId !== member.chatId) return fail('invalid_ticket', 401);
        member.authUntil = ticket.authUntil; member.chatConnectionId = ticket.chatConnectionId; member.user = ticket.user;
        delete member.disconnectUntil;
        member.expiresAt = Date.now() + 90000; this.save(member); member = await this.quota(member); await this.schedule();
        this.publishPresence();
        return { ok: true, value: this.state(member) };
      }
      if (action === 'heartbeat') {
        if (Date.now() - member.heartbeatAt < 3000) return fail('rate_limited', 429);
        member.heartbeatAt = Date.now(); member.expiresAt = Date.now() + 90000; this.save(member);
        member = await this.quota(member);
        await this.schedule(); this.publishPresence(); return { ok: true, value: this.state(member) };
      }
      if (!member.quotaUntil) member = await this.quota(member);
      this.valid(member);
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
    return { memberId: member.id, authUntil: member.authUntil, expiresAt: this.expiry(member), heartbeatEveryMs: 20000, usage: member.usage, snapshot: this.snapshot() };
  }
  private retireMember(member: Member, reason?: string) {
    if (reason) member.leaveReason = reason;
    member.leaving = true; delete member.publication; this.enqueueTurn(member); this.save(member);
    for (const session of this.sessions().filter(value => value.memberId === member.id)) { session.retired = true; this.saveSession(session); }
    this.recordMediaClosure(member.id);
  }
  private recordMediaClosure(id: string) {
    const member = this.latest(id);
    // Initial admission must finish before its lease can be settled. Once a
    // member has joined, neither quota retries nor TURN issuance extend media time.
    if (!member.leaving || member.mediaClosedAt !== undefined
      || (!member.quotaUntil && this.pendingQuota.has(id))
      || this.sessions().some(session => session.memberId === id)) return;
    member.mediaClosedAt = Date.now(); this.save(member);
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
      member.turnCredentials ??= [];
      for (const username of new Set(value.iceServers.flatMap(item => 'username' in item && item.username ? [item.username] : []))) {
        member.turnCredentials.push({ id: crypto.randomUUID(), username, keyId: this.env.REALTIME_TURN_KEY_ID, expiresAt: value.iceExpiresAt });
      }
      member.ice = value;
      if (member.leaving) this.enqueueTurn(member);
      this.save(member); this.valid(member);
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
    await this.cleanup({ memberId: member.id, direction });
    member = this.valid(this.latest(member.id));
    if (this.sessions().some(value => value.memberId === member.id && value.direction === direction)) return fail('cleanup_pending', 409);
    if (direction === 'receiver' && !publications.length) return { empty: true };
    const ice = await this.ice(member.id);
    member = this.valid(this.latest(member.id));
    const session: MediaSession = { id: crypto.randomUUID(), appId: this.env.REALTIME_SFU_APP_ID, memberId: member.id, direction, generation: ++member.generations[direction], mids: [], retired: false, operationId: requestId, phase: 'allocating', deadline: Date.now() + 30000 };
    // A persistent reservation precedes external I/O; leave/alarm can fence it.
    if (this.sessions().some(value => value.memberId === member.id && value.direction === direction)) return fail('operation_busy', 409);
    this.save(member); this.saveSession(session); this.active.add(session.id);
    try {
      await this.schedule();
      const created = await this.provider.sfu('sessions/new', 'POST');
      if (typeof created.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(created.sessionId)) return fail('upstream_unavailable', 502);
      session.providerId = created.sessionId; session.retired = this.current(session.id)?.retired ?? true; this.saveSession(session);
      this.assertSession(member.id, session.id);
      session.phase = 'mutating'; session.uncertain = true; session.allocationStartedAt = Date.now(); session.expectedTracks = direction === 'publisher' ? 1 : publications.length; this.saveSession(session);
      const tracks = direction === 'publisher' ? [{ location: 'local', mid: input.mid, trackName: `mic-${session.id}` }]
        : publications.map(value => ({ location: 'remote', sessionId: value.publication.sessionId, trackName: value.publication.trackName }));
      const result = await this.provider.sfu(`sessions/${session.providerId}/tracks/new`, 'POST', { tracks, ...(offer ? { sessionDescription: offer } : {}) });
      // Retain every returned mid before validating partial success.
      const items = Array.isArray(result.tracks) ? result.tracks.map(item => item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {}) : [];
      session.mids = [...new Set(items.flatMap(item => typeof item.mid === 'string' && item.mid.length > 0 ? [item.mid] : []))];
      // A missing or malformed item may hide a successful upstream allocation.
      // Save valid mids for cleanup without treating an incomplete list as final.
      session.uncertain = items.length !== session.expectedTracks || session.mids.length !== session.expectedTracks;
      session.retired = this.current(session.id)?.retired ?? true; this.saveSession(session);
      this.assertSession(member.id, session.id);
      if (result.errorCode || session.uncertain || items.some(item => item.errorCode)) return fail('upstream_unavailable', 502);
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
  private cleanupBudget(): number {
    const now = Date.now();
    const mandatory = this.members().filter(member => !member.leaving).map(member => Math.min(this.expiry(member), member.quotaUntil ?? now + 10000));
    return Math.min(now + 10000, ...mandatory);
  }
  private async cleanSession(id: string, budget: number) {
    let session = this.current(id);
    if (!session?.retired || this.active.has(id) || (session.cleanup?.nextAttemptAt || 0) > Date.now() || this.cleanupSlots >= 2 || budget - Date.now() < 50) return;
    this.active.add(id); this.cleanupSlots++;
    try {
      // At most one inspect + one close in this pass, with one shared deadline.
      for (let step = 0; step < 2 && budget - Date.now() >= 50; step++) {
        session = this.current(id);
        if (!session) break;
        session.cleanup = { ...session.cleanup, attempts: session.cleanup?.attempts || 0, nextAttemptAt: budget + 1000 };
        this.saveSession(session); await this.schedule();
        const result = await this.provider.closeStep(session, Math.max(1, budget - Date.now()));
        const current = this.current(id);
        if (!current) break;
        current.cleanupMids = result.pending; current.closedMids = result.closed;
        if (result.done) {
          // Preserve the billing boundary even if another cleanup stalls or the
          // object restarts before the quota RPC completes.
          this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec('DELETE FROM voice_sessions WHERE id=?', id);
            this.recordMediaClosure(current.memberId);
          });
          cleanupComplete(id, 'sfu.close', result.reason, current.cleanup?.attempts);
          break;
        }
        this.saveSession(current);
        if (result.failure || result.reason === 'outcome_unknown') throw result.failure || new VoiceError('outcome_unknown', 503);
        current.cleanup!.nextAttemptAt = Date.now() + 1; this.saveSession(current);
      }
    } catch (error) {
      const current = this.current(id);
      if (current) {
        current.cleanup = retryAfter(current.cleanup, current.uncertain ? 'uncertain' : 'media', error, 'sfu.close', id);
        this.saveSession(current);
      }
    } finally { this.active.delete(id); this.cleanupSlots--; }
  }
  private async settleMember(id: string, budget: number) {
    let member = this.latest(id);
    if (budget - Date.now() < 50 || !member.leaving || member.tombstoneUntil || (member.settlementRetry?.nextAttemptAt || 0) > Date.now()
      || this.sessions().some(session => session.memberId === id) || this.pendingQuota.has(id)
      || this.active.has(`turn:${id}`) || this.active.has(`settle:${id}`)) return;
    const lock = `settle:${id}`; this.active.add(lock);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      member.mediaClosedAt ??= Date.now();
      member.settlementRetry = { ...member.settlementRetry, attempts: member.settlementRetry?.attempts || 0, nextAttemptAt: Date.now() + 60000 };
      this.save(member); await this.schedule();
      const request = this.env.VOICE_QUOTAS.getByName('voice-minutes-v1').release(id, this.ctx.id.toString(), member.mediaClosedAt, member.legacySettlementReview === true);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new VoiceError('voice_quota_unavailable', 503)), Math.max(1, Math.min(5000, budget - Date.now())));
      });
      // A late RPC may still finish. release() is idempotent and every retry uses
      // the same persisted closure time, so it cannot double-charge or refund.
      await Promise.race([request, timeout]);
      member = this.latest(id); member.tombstoneUntil = Date.now() + 600000; delete member.settlementRetry; this.save(member);
      cleanupComplete(id, 'quota.release', member.legacySettlementReview ? 'legacy_settlement_review' : 'settled');
    } catch (error) {
      member = this.latest(id); member.settlementRetry = retryAfter(member.settlementRetry, 'quota', error, 'quota.release', id); this.save(member);
    } finally { if (timer !== undefined) clearTimeout(timer); this.active.delete(lock); }
  }
  private async cleanTurn(task: TurnCleanup, budget: number) {
    const lock = `revoke:${task.id}`;
    if (this.active.has(lock)) return;
    if (task.expiresAt <= Date.now()) {
      this.ctx.storage.sql.exec('DELETE FROM voice_turn_cleanup WHERE id=?', task.id);
      cleanupComplete(task.id, 'turn.revoke', 'expired', task.retry?.attempts); return;
    }
    // Legacy credentials have no reliable key ownership. Their one-hour expiry
    // bound ends cleanup without trying a possibly rotated key.
    if (!task.keyId || (task.retry?.nextAttemptAt || 0) > Date.now() || this.cleanupSlots >= 2 || budget - Date.now() < 50) return;
    this.active.add(lock); this.cleanupSlots++;
    try {
      task.retry = { ...task.retry, attempts: task.retry?.attempts || 0, nextAttemptAt: budget + 1000 };
      this.saveTurn(task); await this.schedule();
      await this.provider.revoke(task.username, task.keyId, Math.max(1, Math.min(budget, task.expiresAt) - Date.now()));
      this.ctx.storage.sql.exec('DELETE FROM voice_turn_cleanup WHERE id=?', task.id);
      cleanupComplete(task.id, 'turn.revoke', 'revoked', task.retry.attempts);
    } catch (error) {
      task.retry = retryAfter(task.retry, 'turn', error, 'turn.revoke', task.id); this.saveTurn(task);
    } finally { this.active.delete(lock); this.cleanupSlots--; }
  }
  private async cleanup(scope?: { memberId: string; direction: MediaSession['direction'] }) {
    for (const member of this.members()) if (member.leaving) this.recordMediaClosure(member.id);
    const budget = this.cleanupBudget();
    const due = this.sessions().filter(session => session.retired && !this.active.has(session.id)
      && (session.cleanup?.nextAttemptAt || 0) <= Date.now()
      && (!scope || session.memberId === scope.memberId && session.direction === scope.direction))
      .sort((a, b) => (a.cleanup?.nextAttemptAt || 0) - (b.cleanup?.nextAttemptAt || 0)).slice(0, Math.max(0, 2 - this.cleanupSlots));
    await Promise.all(due.map(session => this.cleanSession(session.id, budget)));
    if (!scope) {
      await Promise.all(this.members().filter(member => member.leaving && !member.tombstoneUntil).map(member => this.settleMember(member.id, budget)));
      const tasks = this.turnTasks().filter(task => task.expiresAt <= Date.now() || task.keyId && (task.retry?.nextAttemptAt || 0) <= Date.now())
        .sort((a, b) => (a.retry?.nextAttemptAt || 0) - (b.retry?.nextAttemptAt || 0));
      // Expired entries need no I/O and must not wait behind slow revocations.
      for (const task of tasks.filter(task => task.expiresAt <= Date.now())) await this.cleanTurn(task, budget);
      await Promise.all(tasks.filter(task => task.expiresAt > Date.now()).slice(0, Math.max(0, 2 - this.cleanupSlots)).map(task => this.cleanTurn(task, budget)));
    }
    await this.schedule();
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
    await Promise.all(this.members().filter(member => !member.leaving && (!member.quotaUntil || member.quotaUntil - Date.now() <= 20000)).map(async member => {
      try { await this.quota(member); }
      catch { /* quota() retires the member; persisted cleanup retries remain. */ }
    }));
    await this.cleanup();
  }
}
