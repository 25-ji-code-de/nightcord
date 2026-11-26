/* SPDX-License-Identifier: AGPL-3.0-only */
import type { Profile } from '../identity';
import { account, fail, positive, settings, summary, type Member, type State } from './protocol';
import { RoomStore } from './schema';
type Invite = { id: string; secret_hash: string; issuer_id: string; target_id: string | null; expires_at: number; max_uses: number; uses: number; revoked: number };
export function requireMember(store: RoomStore, actor: Profile) {
  return actor.authenticated && store.require(actor.id) || fail('not_found', 404);
}
export function requireOwner(store: RoomStore, s: State, actor: Profile) {
  requireMember(store, actor); if (s.ownerId !== actor.id) fail('owner_required', 403);
}
function invitation(store: RoomStore, s: State, actor: Profile, digest: string): Invite {
  const row = store.sql.exec<Invite>('SELECT * FROM invites WHERE secret_hash=?', digest).toArray()[0];
  if (s.status !== 'active' || !row || row.revoked || row.expires_at <= Date.now() || row.issuer_id !== s.ownerId ||
      (row.target_id && row.target_id !== actor.id) || store.member(actor.id)?.status === 'banned') return fail('invite_unavailable', 404);
  const used = store.sql.exec('SELECT 1 FROM invite_uses WHERE invite_id=? AND account_id=?', row.id, actor.id).toArray().length;
  if (row.uses >= row.max_uses && !(used && store.require(actor.id))) return fail('invite_unavailable', 404);
  if (used && !store.require(actor.id)) return fail('invite_unavailable', 404);
  return row;
}
export function memberPage(store: RoomStore, actor: Profile, input: Record<string, unknown>) {
  requireMember(store, actor);
  if (input.view === 'roster' || store.state().ownerId !== actor.id) {
    if (!store.visibilityAllowed(actor.id)) return fail('visibility_confirmation_required', 409);
    return { members: store.visibleMembers(), cursor: null };
  }
  const cursor = typeof input.cursor === 'string' ? input.cursor : '';
  if (cursor.length > 134) return fail('invalid_cursor');
  const owner = store.state().ownerId === actor.id;
  const rows = store.sql.exec<Member>(`SELECT * FROM members WHERE ${owner ? "status IN ('active','banned')" : "status='active'"} AND account_id>? ORDER BY account_id LIMIT 51`, cursor).toArray();
  return { members: rows.slice(0, 50).map(m => ({ ...JSON.parse(m.profile), status: m.status })), cursor: rows.length > 50 ? rows[49].account_id : null };
}
export function manage(store: RoomStore, actor: Profile, action: string, input: Record<string, unknown>, digest = '') {
  const s = store.state(); let changed = false, publish = false;
  let extra: Record<string, unknown> = {};
  const member = store.member(actor.id);
  if (action === 'get') {
    if (member?.status !== 'active' && (s.joinPolicy !== 'open' || s.status !== 'active' || member?.status === 'banned')) return fail('not_found', 404);
    return { room: summary(s), role: member?.status === 'active' ? s.ownerId === actor.id ? 'owner' : 'member' : null };
  }
  if (action === 'preview') { invitation(store, s, actor, digest); return { room: summary(s), role: member?.status === 'active' ? 'member' : null }; }
  if (action === 'leave' && member?.status === 'left') return { role: null };
  if (action === 'members') return memberPage(store, actor, input);
  if (action === 'join' || action === 'accept') {
    if (s.status !== 'active' || member?.status === 'banned') return fail('not_found', 404);
    const invite = action === 'accept' ? invitation(store, s, actor, digest) : null;
    if (!invite && s.joinPolicy !== 'open' && member?.status !== 'active') return fail('not_found', 404);
    if (member?.status !== 'active') {
      if (store.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE status='active'").one().n >= 50) return fail('room_full', 409);
      store.sql.exec("INSERT INTO members VALUES(?,?,'active',?,?,0) ON CONFLICT(account_id) DO UPDATE SET profile=excluded.profile,status='active',version=excluded.version,joined_at=excluded.joined_at", actor.id, JSON.stringify(actor), (member?.version || 0) + 1, Date.now());
      if (invite) {
        store.sql.exec('UPDATE invites SET uses=uses+1 WHERE id=?', invite.id);
        store.sql.exec('INSERT INTO invite_uses VALUES(?,?)', invite.id, actor.id);
      }
      store.reference(s, store.member(actor.id)!); changed = true;
    }
  } else {
    requireMember(store, actor);
    if (action === 'leave') {
      if (s.ownerId === actor.id) return fail('transfer_required', 409);
      store.sql.exec("UPDATE members SET status='left',version=version+1 WHERE account_id=?", actor.id);
      store.reference(s, store.member(actor.id)!); changed = true;
    } else {
      requireOwner(store, s, actor);
      if (action === 'update') {
        const next = settings({ ...s, ...input });
        if (Object.keys(next).some(key => next[key as keyof typeof next] !== s[key as keyof typeof next])) {
          Object.assign(s, next); changed = publish = true;
        }
      } else if (action === 'archive') {
        if (s.status !== 'archived') { s.status = 'archived'; store.sql.exec('UPDATE invites SET revoked=1 WHERE revoked=0'); changed = publish = true; }
      } else if (action === 'transfer') {
        const target = account(input.accountId);
        if (!store.require(target) || s.status !== 'active') return fail('not_found', 404);
        if (target !== s.ownerId) { s.ownerId = target; store.sql.exec('UPDATE invites SET revoked=1 WHERE revoked=0'); changed = true; }
      } else if (['remove', 'ban', 'unban'].includes(action)) {
        const target = account(input.accountId);
        if (target === s.ownerId) return fail('transfer_required', 409);
        const m = store.member(target); if (!m) return fail('not_found', 404);
        const status = action === 'ban' ? 'banned' : 'left';
        if (m.status !== status && (action !== 'remove' || m.status === 'active') && (action !== 'unban' || m.status === 'banned')) {
          store.sql.exec('UPDATE members SET status=?,version=version+1 WHERE account_id=?', status, target);
          store.reference(s, store.member(target)!); changed = true;
        }
      } else if (action === 'invite') {
        if (s.status !== 'active') return fail('room_archived', 409);
        if (store.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM invites WHERE revoked=0 AND expires_at>?', Date.now()).one().n >= 20) return fail('invite_limit', 429);
        const expiresAt = Date.now() + Math.min(604800, positive(input.expiresIn, 86400)) * 1000;
        const id = crypto.randomUUID();
        store.sql.exec('INSERT INTO invites VALUES(?,?,?,?,?,?,0,0)', id, digest, actor.id, input.targetAccountId ? account(input.targetAccountId) : null, expiresAt, Math.min(50, positive(input.maxUses, 1)));
        extra = { inviteId: id, expiresAt }; changed = true;
      } else if (action === 'revoke') {
        if (typeof input.inviteId !== 'string' || input.inviteId.length > 80) return fail('invalid_request');
        const row = store.sql.exec<Invite>('SELECT * FROM invites WHERE id=?', input.inviteId).toArray()[0];
        if (!row) return fail('not_found', 404);
        if (!row.revoked) { store.sql.exec('UPDATE invites SET revoked=1 WHERE id=?', row.id); changed = true; }
      } else if (action === 'invites') {
        extra = { invites: store.sql.exec('SELECT id,expires_at,max_uses,uses,target_id FROM invites WHERE revoked=0 AND expires_at>? ORDER BY expires_at LIMIT 20', Date.now()).toArray() };
      } else return fail('not_found', 404);
    }
  }
  if (changed) {
    s.revision++; if (publish) store.publish(s); store.save(s);
    store.audit(actor.id, action, typeof input.accountId === 'string' ? input.accountId : null);
  }
  return { room: summary(s), role: store.require(actor.id) ? s.ownerId === actor.id ? 'owner' : 'member' : null, ...extra };
}
