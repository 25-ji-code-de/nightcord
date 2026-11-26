CREATE TABLE room_directory (
  room_id TEXT PRIMARY KEY, publication_version INTEGER NOT NULL, listed INTEGER NOT NULL,
  name TEXT NOT NULL, description TEXT NOT NULL, listed_at INTEGER NOT NULL, moderated_hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX directory_page ON room_directory(listed,moderated_hidden,listed_at,room_id);
CREATE TABLE account_room_refs (
  account_id TEXT NOT NULL, room_id TEXT NOT NULL, membership_version INTEGER NOT NULL,
  status TEXT NOT NULL, name_at_join TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY(account_id,room_id)
);
CREATE INDEX account_rooms_page ON account_room_refs(account_id,status,room_id);
CREATE TABLE room_creations (
  account_id TEXT NOT NULL, request_id TEXT NOT NULL, room_id TEXT UNIQUE NOT NULL, state TEXT NOT NULL,
  payload_hash TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(account_id,request_id)
);
CREATE INDEX creation_account ON room_creations(account_id,state);
CREATE TABLE room_moderation_log (id INTEGER PRIMARY KEY, actor_id TEXT NOT NULL, room_id TEXT NOT NULL, hidden INTEGER NOT NULL, reason TEXT NOT NULL, timestamp INTEGER NOT NULL);
