/* SPDX-License-Identifier: AGPL-3.0-only */
import type { Profile } from '../identity';
import { available, fail, identifier, payload, positive, sequence, type RoomSettings } from './protocol';
import { RoomStore } from './schema';
import { requireMember } from './membership';
type Row = { seq: number; sender_id: string; client_id: string; payload: string; profile: string; timestamp: number };
const message = (row: Row) => ({ ...JSON.parse(row.payload), seq: row.seq, senderId: row.sender_id, sender: JSON.parse(row.profile), clientMessageId: row.client_id, timestamp: row.timestamp });
export function history(store: RoomStore, actor: Profile, input: Record<string, unknown>) {
  requireMember(store, actor);
  if (input.beforeSeq !== undefined && input.afterSeq !== undefined) return fail('invalid_sequence');
  const s = store.state(), forward = input.afterSeq !== undefined;
  const before = input.beforeSeq === undefined ? s.lastSeq + 1 : sequence(input.beforeSeq);
  const after = forward ? sequence(input.afterSeq) : 0, limit = Math.min(50, positive(input.limit, 50));
  const rows = store.sql.exec<Row>('SELECT * FROM messages WHERE seq>? AND seq<? ORDER BY seq ' + (forward ? 'ASC' : 'DESC') + ' LIMIT ?', after, before, limit + 1).toArray();
  const page = rows.slice(0, limit); if (!forward) page.reverse();
  return { messages: page.map(message), more: rows.length > limit, latestSeq: s.lastSeq };
}
export function send(store: RoomStore, env: RoomSettings, actor: Profile, input: Record<string, unknown>) {
  return store.storage.transactionSync(() => {
    const member = requireMember(store, actor), s = store.state();
    const id = identifier(input.clientMessageId), content = payload(input), encoded = JSON.stringify(content);
    const existing = store.sql.exec<Row>('SELECT * FROM messages WHERE sender_id=? AND client_id=?', actor.id, id).toArray()[0];
    if (existing) {
      if (existing.payload !== encoded) return fail('message_id_conflict', 409);
      return { message: message(existing), duplicate: true };
    }
    available(env, true);
    if (s.status !== 'active') return fail('room_archived', 409);
    if (member.next_send_at > Date.now()) return fail('rate_limited', 429);
    const day = new Date().toISOString().slice(0, 10);
    if (day !== s.quotaDay) { s.quotaDay = day; s.sentToday = 0; }
    if (s.sentToday >= positive(env.ROOMS_DAILY_MESSAGES, 1000)) return fail('daily_limit', 429);
    const profile = JSON.stringify(actor), bytes = new TextEncoder().encode(encoded + profile).length + 128;
    if (s.bytes + bytes > positive(env.ROOMS_MAX_BYTES, 8388608)) return fail('room_capacity', 507);
    if (content.replyTo && !store.sql.exec('SELECT 1 FROM messages WHERE seq=?', content.replyTo).toArray().length) return fail('invalid_reply');
    const row = { seq: ++s.lastSeq, sender_id: actor.id, client_id: id, payload: encoded, profile, timestamp: Date.now() };
    store.sql.exec('INSERT INTO messages VALUES(?,?,?,?,?,?)', row.seq, actor.id, id, encoded, profile, row.timestamp);
    store.sql.exec('UPDATE members SET next_send_at=? WHERE account_id=?', Date.now() + 750, actor.id);
    s.bytes += bytes; s.sentToday++; store.save(s);
    return { message: message(row), duplicate: false };
  });
}
