/* SPDX-License-Identifier: AGPL-3.0-only */
import type { ChatEnv } from '../guest';
import type { Profile } from '../identity';
import { fail, hash, identifier, positive, settings } from './protocol';
export type Creation = { account_id: string; request_id: string; room_id: string; payload_hash: string; payload: string; state: string };
export const primary = (env: ChatEnv) => env.ROOM_DIRECTORY.withSession('first-primary');
export function unwrap(value: { status: number; json: string }): Record<string, unknown> {
  const data = JSON.parse(value.json);
  if (value.status !== 200 && value.status !== 202) fail(String(data.code), value.status);
  return data;
}
export async function create(env: ChatEnv, actor: Profile, input: Record<string, unknown>) {
  const requestId = identifier(input.requestId), content = settings(input), payload = JSON.stringify(content), digest = await hash(payload);
  const db = primary(env), id = 'r_' + crypto.randomUUID().replaceAll('-', '');
  // One conditional statement serializes both quota checks and the reservation.
  await db.prepare(`INSERT INTO room_creations SELECT ?,?,?,'pending',?,?,? WHERE
    (SELECT COUNT(*) FROM room_creations) < ? AND (SELECT COUNT(*) FROM room_creations WHERE account_id=?) < ?
    ON CONFLICT(account_id,request_id) DO NOTHING`).bind(actor.id, requestId, id, digest, payload, Date.now(),
    positive(env.ROOMS_MAX_TOTAL, 100), actor.id, positive(env.ROOMS_MAX_OWNED, 3)).run();
  const row = await db.prepare('SELECT * FROM room_creations WHERE account_id=? AND request_id=?').bind(actor.id, requestId).first<Creation>();
  if (!row) return fail('creation_quota', 429);
  if (row.payload_hash !== digest) return fail('request_id_conflict', 409);
  return initialize(env, actor, row);
}
export async function initialize(env: ChatEnv, actor: Profile, row: Creation) {
  const value = unwrap(await env.MANAGED_ROOMS.getByName(row.room_id).initialize(actor, row));
  await primary(env).prepare("UPDATE room_creations SET state='ready' WHERE account_id=? AND request_id=? AND state='pending'").bind(actor.id, row.request_id).run();
  return value;
}
export async function listing(env: ChatEnv, cursor: string, accountId?: string) {
  if (cursor.length > 200) return fail('invalid_cursor');
  const db = primary(env);
  if (accountId) {
    const { results } = await db.prepare("SELECT room_id AS id,name_at_join AS name FROM account_room_refs WHERE account_id=? AND status='active' AND room_id>? ORDER BY room_id LIMIT 21").bind(accountId, cursor).all<{ id: string; name: string }>();
    return { rooms: results.slice(0, 20), cursor: results.length > 20 ? results[19].id : null };
  }
  let time = 0, id = '';
  if (cursor) { const parts = cursor.split(':'); time = Number(parts[0]); id = parts[1]; if (!Number.isSafeInteger(time) || !/^r_[a-f0-9]{32}$/.test(id)) return fail('invalid_cursor'); }
  const { results } = await db.prepare('SELECT room_id AS id,name,description,listed_at FROM room_directory WHERE listed=1 AND moderated_hidden=0 AND (listed_at,room_id)>(?,?) ORDER BY listed_at,room_id LIMIT 21').bind(time, id).all<{ id: string; name: string; description: string; listed_at: number }>();
  return { rooms: results.slice(0, 20), cursor: results.length > 20 ? results[19].listed_at + ':' + results[19].id : null };
}
export async function apply(env: ChatEnv, destination: string, version: number, payload: string) {
  const p = JSON.parse(payload), db = primary(env);
  if (destination === 'directory') {
    await db.prepare(`INSERT INTO room_directory(room_id,publication_version,listed,name,description,listed_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(room_id) DO UPDATE SET publication_version=excluded.publication_version,listed=excluded.listed,name=excluded.name,description=excluded.description,listed_at=excluded.listed_at WHERE excluded.publication_version>room_directory.publication_version`)
      .bind(p.roomId, version, p.listed, p.name, p.description, p.listedAt).run();
  } else {
    await db.prepare(`INSERT INTO account_room_refs VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,room_id) DO UPDATE SET
      membership_version=excluded.membership_version,status=excluded.status,name_at_join=excluded.name_at_join,joined_at=excluded.joined_at WHERE excluded.membership_version>account_room_refs.membership_version`)
      .bind(p.accountId, p.roomId, version, p.status, p.name, p.joinedAt).run();
  }
}
