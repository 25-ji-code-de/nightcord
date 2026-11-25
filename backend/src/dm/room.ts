/* SPDX-License-Identifier: AGPL-3.0-only */
import { DurableObject } from 'cloudflare:workers';
import type { ChatEnv } from '../guest';
import type { Profile } from '../identity';
import { available, boolean, fail, identifier, payload, positive, reply, sequence, type Message, type RequestState, type Snapshot } from './protocol';

type State = {
  id: string; users: Profile[]; state: RequestState; initiator: string | null; version: number;
  lastSeq: number; incoming: Record<string, number>; refused: Record<string, boolean>;
  bytes: number; updatedAt: number; lastSenderId: string | null;
};
type Row = { seq: number; sender_id: string; recipient_id: string; incoming: number; client_id: string; payload: string; timestamp: number };
type Pending = { owner_id: string; version: number; snapshot: string; attempts: number; due: number };

export class DirectRoom extends DurableObject<ChatEnv> {
  private delivery: Promise<void> | null = null;
  private deliverAgain = false;
  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS dm_meta (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS dm_messages (seq INTEGER PRIMARY KEY, sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL, incoming INTEGER NOT NULL, client_id TEXT NOT NULL, payload TEXT NOT NULL, timestamp INTEGER NOT NULL, UNIQUE(sender_id,client_id))');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS dm_received ON dm_messages(recipient_id,seq)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS dm_outbox (owner_id TEXT PRIMARY KEY, version INTEGER NOT NULL, snapshot TEXT NOT NULL, attempts INTEGER NOT NULL, due INTEGER NOT NULL)');
  }
  private state(): State | undefined {
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM dm_meta WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.data) : undefined;
  }
  private save(state: State) {
    this.ctx.storage.sql.exec('INSERT INTO dm_meta VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', JSON.stringify(state));
  }
  private member(state: State | undefined, actor: Profile): asserts state is State {
    if (!actor.authenticated || !state?.users.some(user => user.id === actor.id)) fail('not_found', 404);
  }
  private snapshot(state: State, ownerId: string): Snapshot {
    return {
      id: state.id, ownerId, peer: state.users.find(user => user.id !== ownerId)!, version: state.version,
      state: state.state, initiator: state.initiator, refuseIncoming: !!state.refused[ownerId],
      lastSeq: state.lastSeq, incoming: state.incoming[ownerId] || 0,
      updatedAt: state.updatedAt, lastSenderId: state.lastSenderId,
    };
  }
  private message(row: Row): Message {
    return { ...JSON.parse(row.payload), seq: row.seq, senderId: row.sender_id, clientMessageId: row.client_id, timestamp: row.timestamp };
  }
  private async changed(state: State, onlyOwner?: string) {
    state.version++;
    this.save(state);
    for (const user of state.users.filter(user => !onlyOwner || user.id === onlyOwner)) {
      this.ctx.storage.sql.exec('INSERT INTO dm_outbox VALUES(?,?,?,0,?) ON CONFLICT(owner_id) DO UPDATE SET version=excluded.version,snapshot=excluded.snapshot,attempts=0,due=excluded.due',
        user.id, state.version, JSON.stringify(this.snapshot(state, user.id)), Date.now());
    }
    // Called inside storage.transaction: message, outbox and wakeup commit together.
    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm || alarm > Date.now() + 1000) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }
  async handle(actor: Profile, action: string, input: Record<string, unknown>, bootstrap?: { id: string; peer: Profile }) {
    return reply(async () => {
      let mutated = false;
      available(this.env, ['send', 'accept', 'reject', 'initialize'].includes(action));
      if (action === 'initialize') {
        if (!bootstrap || !actor.authenticated || !bootstrap.peer.authenticated || bootstrap.peer.id === actor.id) return fail('not_found', 404);
        await this.ctx.storage.transaction(async () => {
          let state = this.state();
          if (!state) {
            state = { id: bootstrap.id, users: [actor, bootstrap.peer], state: 'none', initiator: null, version: 0,
              lastSeq: 0, incoming: {}, refused: {}, bytes: 0, updatedAt: Date.now(), lastSenderId: null };
            await this.changed(state, actor.id);
            mutated = true;
          }
          this.member(state, actor);
          if (state.id !== bootstrap.id || !state.users.some(user => user.id === bootstrap.peer.id)) return fail('not_found', 404);
        });
      }
      let state = this.state();
      this.member(state, actor);
      if (action === 'history') {
        const before = input.before === undefined ? state.lastSeq + 1 : sequence(input.before);
        const after = input.after === undefined ? 0 : sequence(input.after);
        const limit = Math.min(100, positive(input.limit, 50));
        const forward = input.after !== undefined;
        const rows = this.ctx.storage.sql.exec<Row>('SELECT * FROM dm_messages WHERE seq<? AND seq>? ORDER BY seq ' + (forward ? 'ASC' : 'DESC') + ' LIMIT ?', before, after, limit + 1).toArray();
        const more = rows.length > limit;
        const page = rows.slice(0, limit);
        if (!forward) page.reverse();
        return { conversation: this.snapshot(state, actor.id), messages: page.map(row => this.message(row)), more };
      }
      if (action === 'checkpoint') {
        const seq = sequence(input.seq);
        if (seq > state.lastSeq) return fail('invalid_sequence');
        // The per-recipient count is monotonic; the index can seek to the last
        // matching message without scanning the recipient's entire history.
        const row = seq ? this.ctx.storage.sql.exec<{ incoming: number }>('SELECT incoming FROM dm_messages WHERE recipient_id=? AND seq<=? ORDER BY seq DESC LIMIT 1', actor.id, seq).toArray()[0] : undefined;
        return { seq, incoming: row?.incoming || 0, conversation: this.snapshot(state, actor.id) };
      }
      let sent: Message | undefined;
      if (['send', 'accept', 'reject', 'refuse', 'sync'].includes(action)) {
        await this.ctx.storage.transaction(async () => {
          state = this.state();
          this.member(state, actor);
          const peer = state.users.find(user => user.id !== actor.id)!;
          if (action === 'send') {
            const clientId = identifier(input.clientMessageId);
            const content = payload(input);
            const encoded = JSON.stringify(content);
            const existing = this.ctx.storage.sql.exec<Row>('SELECT * FROM dm_messages WHERE sender_id=? AND client_id=?', actor.id, clientId).toArray()[0];
            if (existing) {
              if (existing.payload !== encoded) return fail('message_id_conflict', 409);
              sent = this.message(existing);
              return;
            }
            if (state.refused[peer.id]) return fail('recipient_refused', 403);
            if (state.state === 'pending') return fail('request_pending', 409);
            if (state.state === 'rejected') return fail('request_rejected', 403);
            if (content.replyTo && !this.ctx.storage.sql.exec('SELECT 1 FROM dm_messages WHERE seq=?', content.replyTo).toArray().length) return fail('invalid_reply');
            const bytes = new TextEncoder().encode(encoded).length + 256;
            if (state.bytes + bytes > positive(this.env.DM_MAX_BYTES, 52428800)) return fail('conversation_full', 507);
            if (state.state === 'none') { state.state = 'pending'; state.initiator = actor.id; }
            const seq = ++state.lastSeq;
            const incoming = (state.incoming[peer.id] || 0) + 1;
            state.incoming[peer.id] = incoming;
            state.bytes += bytes;
            state.updatedAt = Math.max(Date.now(), state.updatedAt + 1);
            state.lastSenderId = actor.id;
            state.users = state.users.map(user => user.id === actor.id ? actor : user);
            this.ctx.storage.sql.exec('INSERT INTO dm_messages VALUES(?,?,?,?,?,?,?)', seq, actor.id, peer.id, incoming, clientId, encoded, state.updatedAt);
            sent = { ...content, seq, senderId: actor.id, clientMessageId: clientId, timestamp: state.updatedAt };
          } else if (action === 'accept' || action === 'reject') {
            if (!state.initiator || state.initiator === actor.id) return fail('request_not_yours', 403);
            if (action === 'reject' && state.state === 'accepted') return fail('request_already_accepted', 409);
            const target = action === 'accept' ? 'accepted' : 'rejected';
            if (state.state === target) return;
            state.state = target;
          } else if (action === 'refuse') {
            const refused = boolean(input.refuseIncoming);
            if (!!state.refused[actor.id] === refused) return;
            state.refused[actor.id] = refused;
          }
          await this.changed(state, state.state === 'none' ? actor.id : undefined);
          mutated = true;
        });
      } else if (action !== 'initialize') return fail('not_found', 404);
      if (mutated) this.ctx.waitUntil(this.deliver());
      state = this.state()!;
      return { conversation: this.snapshot(state, actor.id), ...(sent ? { message: sent } : {}) };
    });
  }
  private async schedule() {
    const next = this.ctx.storage.sql.exec<{ due: number | null }>('SELECT MIN(due) AS due FROM dm_outbox').one().due;
    const alarm = await this.ctx.storage.getAlarm();
    if (next !== null) {
      const deadline = Math.max(Date.now() + 100, next);
      if (alarm !== deadline) await this.ctx.storage.setAlarm(deadline);
    } else if (alarm !== null) await this.ctx.storage.deleteAlarm();
  }
  private deliver(): Promise<void> {
    this.deliverAgain = true;
    if (this.delivery) return this.delivery;
    this.delivery = (async () => {
      try {
        // Bound each drain; persisted alarms cover work beyond this batch budget.
        for (let batch = 0; batch < 4 && this.deliverAgain; batch++) {
          this.deliverAgain = false;
          await this.deliverBatch();
        }
      } finally { this.delivery = null; }
    })();
    return this.delivery;
  }
  private async deliverBatch() {
    const rows = this.ctx.storage.sql.exec<Pending>('SELECT * FROM dm_outbox WHERE due<=? LIMIT 2', Date.now()).toArray();
    await Promise.allSettled(rows.map(async row => {
      try {
        await this.env.DM_INBOXES.getByName(row.owner_id).apply(JSON.parse(row.snapshot));
        this.ctx.storage.sql.exec('DELETE FROM dm_outbox WHERE owner_id=? AND version=?', row.owner_id, row.version);
      } catch {
        const delay = Math.min(300000, 1000 * 2 ** Math.min(row.attempts, 8)) + Math.floor(Math.random() * 500);
        this.ctx.storage.sql.exec('UPDATE dm_outbox SET attempts=attempts+1,due=? WHERE owner_id=? AND version=?', Date.now() + delay, row.owner_id, row.version);
        console.warn(JSON.stringify({ event: 'dm_delivery_retry', attempts: row.attempts + 1 }));
      }
    }));
    // Re-read inside a transaction: concurrent commands must not lose their wakeup.
    await this.ctx.storage.transaction(() => this.schedule());
  }
  async alarm() {
    try { await this.deliver(); }
    catch { await this.ctx.storage.setAlarm(Date.now() + 10000); }
  }
}
