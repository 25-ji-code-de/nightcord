/* SPDX-License-Identifier: AGPL-3.0-only */
import { MessagePolicy, type RepeatEntry } from '../../../js/services/message-policy.js';

/** Room-scoped history survives reconnects, renames and DO hibernation. */
export class ChatModeration {
  constructor(private sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS chat_moderation (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS chat_moderation_time ON chat_moderation(timestamp)');
  }

  // Call inside the same transaction that stores the accepted message. Rejected
  // attempts neither extend the waiting period nor become evidence for others.
  accept(actor: string, text: string, now = Date.now()) {
    const content = MessagePolicy.fingerprint(text);
    const recent = this.sql.exec<RepeatEntry>('SELECT actor,content,timestamp FROM chat_moderation WHERE timestamp>?', now - MessagePolicy.WINDOW_MS).toArray();
    const result = MessagePolicy.decide(recent, actor, content, now);
    if (!result.allowed) return result;
    this.sql.exec('DELETE FROM chat_moderation WHERE timestamp<=?', now - MessagePolicy.WINDOW_MS);
    if (content) this.sql.exec('INSERT INTO chat_moderation(actor,content,timestamp) VALUES(?,?,?)', actor, content, now);
    return result;
  }
}
