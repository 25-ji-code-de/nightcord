/* SPDX-License-Identifier: AGPL-3.0-only */
import type { ChatEnv } from '../guest';
import { apply } from './directory';
import { RoomStore } from './schema';
export type Session = { user: import('../identity').Profile | null; expiresAt: number; closed?: boolean; busy?: boolean; readAt?: number; authAt?: number; visibilityBlocked?: boolean; pushDevice?: string; pushViewing?: boolean };
type Pending = { destination: string; version: number; payload: string; attempts: number; due: number };
export class RoomDelivery {
  pushDue: () => number | null = () => null;
  private work: Promise<void> | null = null;
  constructor(private ctx: DurableObjectState, private env: ChatEnv, private store: RoomStore) {}
  async schedule() {
    const deadlines = this.ctx.getWebSockets().map(ws => ws.deserializeAttachment() as Session).filter(s => !s.closed).map(s => s.expiresAt);
    const pushDue = this.pushDue(); if (pushDue !== null) deadlines.push(Math.max(Date.now() + 1000, pushDue));
    if (this.store.exists()) {
      const due = this.store.sql.exec<{ due: number | null }>('SELECT MIN(due) AS due FROM outbox').one().due;
      if (due !== null) deadlines.push(Math.max(Date.now() + 1000, due));
    }
    const next = deadlines.length ? Math.min(...deadlines) : null, old = await this.ctx.storage.getAlarm();
    if (next !== null && (!old || old > next)) await this.ctx.storage.setAlarm(next);
    else if (next === null && old !== null) await this.ctx.storage.deleteAlarm();
  }
  drain() {
    if (this.work) return this.work;
    this.work = this.run().finally(() => { this.work = null; });
    return this.work;
  }
  private async run() {
    // Bounded batches; remaining/new work retains its durable wakeup.
    for (let batch = 0; batch < 4; batch++) {
      const rows = this.store.sql.exec<Pending>('SELECT * FROM outbox WHERE due<=? ORDER BY due LIMIT 8', Date.now()).toArray();
      if (!rows.length) break;
      for (const row of rows) {
        try {
          await apply(this.env, row.destination, row.version, row.payload);
          this.store.sql.exec('DELETE FROM outbox WHERE destination=? AND version=?', row.destination, row.version);
        } catch (error) {
          const quota = /D1.*(?:daily|daily.*limit)|daily.*(?:read|write).*limit/i.test(String(error));
          const delay = quota ? (86400000 - Date.now() % 86400000) + 60000 + Math.random() * 60000
            : Math.min(300000, 2000 * 2 ** Math.min(row.attempts, 8)) * (0.75 + Math.random() * 0.25);
          this.store.sql.exec('UPDATE outbox SET attempts=attempts+1,due=? WHERE destination=? AND version=?', Date.now() + delay, row.destination, row.version);
        }
      }
    }
    await this.ctx.storage.transaction(() => this.schedule());
  }
}
