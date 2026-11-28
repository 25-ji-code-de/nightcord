/* SPDX-License-Identifier: AGPL-3.0-only */
import { visibilityAllowed, type Member, type State, type Visibility } from './protocol';
import type { Profile } from '../identity';
import { ChatModeration } from '../messaging/moderation';
export class RoomStore {
  private contentModeration?: ChatModeration;
  constructor(public storage: DurableObjectStorage) {
    if (this.exists()) this.contentModeration = new ChatModeration(this.sql);
  }
  get moderation() { return this.contentModeration ||= new ChatModeration(this.sql); }
  get sql() { return this.storage.sql; }
  exists() { return !!this.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='room_meta'").toArray().length; }
  initialize() {
    this.initializeVisibility();
    this.contentModeration = new ChatModeration(this.sql);
    this.sql.exec('CREATE TABLE IF NOT EXISTS room_meta (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS members (account_id TEXT PRIMARY KEY, profile TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, joined_at INTEGER NOT NULL, next_send_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY, sender_id TEXT NOT NULL, client_id TEXT NOT NULL, payload TEXT NOT NULL, profile TEXT NOT NULL, timestamp INTEGER NOT NULL, UNIQUE(sender_id,client_id))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, secret_hash TEXT UNIQUE NOT NULL, issuer_id TEXT NOT NULL, target_id TEXT, expires_at INTEGER NOT NULL, max_uses INTEGER NOT NULL, uses INTEGER NOT NULL, revoked INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS invite_uses (invite_id TEXT NOT NULL, account_id TEXT NOT NULL, PRIMARY KEY(invite_id,account_id))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS audit_log (seq INTEGER PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT, timestamp INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS outbox (destination TEXT PRIMARY KEY, version INTEGER NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL, due INTEGER NOT NULL)');
  }
  initializeVisibility() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS room_visibility (account_id TEXT PRIMARY KEY, visibility TEXT NOT NULL CHECK(visibility IN ('online','offline','hidden')))");
  }
  visibility(id: string): Visibility {
    return this.sql.exec<{ visibility: Visibility }>('SELECT visibility FROM room_visibility WHERE account_id=?', id).toArray()[0]?.visibility || 'online';
  }
  visibilityAllowed(id: string) { return visibilityAllowed(this.state().visibilityPolicy, this.visibility(id)); }
  visibleMembers(): (Profile & { status: string })[] {
    return this.sql.exec<Member>(`SELECT m.* FROM members m LEFT JOIN room_visibility v ON v.account_id=m.account_id
      WHERE m.status='active' AND (v.visibility IS NULL OR v.visibility!='hidden') ORDER BY m.account_id`).toArray()
      .map(m => ({ ...JSON.parse(m.profile), status: m.status }));
  }
  state(): State { return { visibilityPolicy: 'hidden', ...JSON.parse(this.sql.exec<{ data: string }>('SELECT data FROM room_meta WHERE id=1').one().data) }; }
  save(s: State) { this.sql.exec('INSERT INTO room_meta VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', JSON.stringify(s)); }
  member(id: string) { return this.sql.exec<Member>('SELECT * FROM members WHERE account_id=?', id).toArray()[0]; }
  require(id: string) { const m = this.member(id); return m?.status === 'active' ? m : undefined; }
  audit(actor: string, action: string, target: string | null = null) {
    this.sql.exec('INSERT INTO audit_log(actor_id,action,target_id,timestamp) VALUES(?,?,?,?)', actor, action, target, Date.now());
  }
  enqueue(destination: string, version: number, payload: unknown) {
    this.sql.exec('INSERT INTO outbox VALUES(?,?,?,0,?) ON CONFLICT(destination) DO UPDATE SET version=excluded.version,payload=excluded.payload,attempts=0,due=excluded.due', destination, version, JSON.stringify(payload), Date.now());
  }
  publish(s: State) { this.enqueue('directory', ++s.publicationVersion, { ...summaryForDirectory(s) }); }
  reference(s: State, m: Member) { this.enqueue(m.account_id, m.version, { roomId: s.id, accountId: m.account_id, status: m.status, name: s.name, joinedAt: m.joined_at }); }
}
const summaryForDirectory = (s: State) => ({ roomId: s.id, listed: s.status === 'active' && s.discoverability === 'listed' ? 1 : 0,
  name: s.name, description: s.description, listedAt: s.createdAt });
