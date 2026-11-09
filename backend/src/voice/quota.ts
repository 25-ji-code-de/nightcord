/* SPDX-License-Identifier: AGPL-3.0-only */
import { DurableObject } from 'cloudflare:workers';
import type { ChatEnv } from '../guest';
import { quotaLimits, quotaPeriods } from './quota-policy';

const MINUTE = 60000;
export const QUOTA_LEASE_MS = MINUTE;
const DAY = 86400000;

type Slice = { from: number; until: number; month: string; day: string };
type Lease = { roomId: string; userId: string; until: number; slices: Slice[]; closed?: boolean };
type Meter = { usedMinutes: number; reservedMinutes: number; limitMinutes: number; resetsAt: number };
export type VoiceUsage = { sampledAt: number; monthly: Meter; daily: Meter };
export type QuotaCode = 'voice_monthly_limit' | 'voice_daily_limit' | 'voice_quota_expired' | 'voice_quota_unavailable';
type Grant = { ok: true; until: number; usage: VoiceUsage } | { ok: false; code: QuotaCode };

// One coordination atom for this deployment's shared minute budget. Rooms only
// renew short time grants here; SDP, media operations and chat stay in their DOs.
export class VoiceQuota extends DurableObject<ChatEnv> {
  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_quota_totals (scope TEXT NOT NULL, period TEXT NOT NULL, subject TEXT NOT NULL, spent_ms INTEGER NOT NULL, PRIMARY KEY(scope,period,subject))');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_quota_leases (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL, reserved_until INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS voice_quota_active ON voice_quota_leases (reserved_until)');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS voice_quota_retention ON voice_quota_leases (updated_at)');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS voice_quota_period ON voice_quota_totals (period)');
  }
  private total(scope: string, period: string, subject: string) {
    return this.ctx.storage.sql.exec<{ spent_ms: number }>('SELECT spent_ms FROM voice_quota_totals WHERE scope=? AND period=? AND subject=?', scope, period, subject).toArray()[0]?.spent_ms || 0;
  }
  private add(scope: string, period: string, subject: string, ms: number) {
    this.ctx.storage.sql.exec('INSERT INTO voice_quota_totals VALUES (?,?,?,?) ON CONFLICT(scope,period,subject) DO UPDATE SET spent_ms=MAX(0,spent_ms+excluded.spent_ms)', scope, period, subject, ms);
  }
  private lease(id: string): Lease | undefined {
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM voice_quota_leases WHERE id=?', id).toArray()[0];
    return row ? JSON.parse(row.data) : undefined;
  }
  private save(id: string, lease: Lease, now: number) {
    this.ctx.storage.sql.exec('INSERT INTO voice_quota_leases VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,reserved_until=excluded.reserved_until', id, JSON.stringify(lease), now, lease.closed ? 0 : lease.until);
  }
  private usage(userId: string, now: number): VoiceUsage {
    const periods = quotaPeriods(now), limits = quotaLimits(this.env);
    let monthlyReserved = 0, dailyReserved = 0;
    for (const row of this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM voice_quota_leases WHERE reserved_until>?', now).toArray()) {
      const lease: Lease = JSON.parse(row.data);
      if (lease.closed) continue;
      for (const slice of lease.slices) {
        const reserved = Math.max(0, slice.until - Math.max(now, slice.from));
        if (slice.month === periods.month) monthlyReserved += reserved;
        if (lease.userId === userId && slice.day === periods.day) dailyReserved += reserved;
      }
    }
    return { sampledAt: now,
      monthly: { usedMinutes: Math.max(0, this.total('month', periods.month, '*') - monthlyReserved) / MINUTE, reservedMinutes: monthlyReserved / MINUTE, limitMinutes: limits.monthly, resetsAt: periods.monthResetsAt },
      daily: { usedMinutes: Math.max(0, this.total('day', periods.day, userId) - dailyReserved) / MINUTE, reservedMinutes: dailyReserved / MINUTE, limitMinutes: limits.daily, resetsAt: periods.dayResetsAt },
    };
  }
  grant(id: string, roomId: string, userId: string, deadline: number): Grant {
    const now = Date.now(), limits = quotaLimits(this.env);
    if (!limits.valid || !Number.isSafeInteger(deadline) || deadline <= now) return { ok: false, code: 'voice_quota_unavailable' };
    return this.ctx.storage.transactionSync(() => {
      // Keep recent closed IDs so a delayed/retried RPC cannot resurrect a grant.
      this.ctx.storage.sql.exec('DELETE FROM voice_quota_leases WHERE updated_at<?', now - 60 * DAY);
      this.ctx.storage.sql.exec('DELETE FROM voice_quota_totals WHERE period<?', quotaPeriods(now - 60 * DAY).month);
      let lease = this.lease(id);
      if (lease && (lease.closed || lease.roomId !== roomId || lease.userId !== userId)) return { ok: false, code: 'voice_quota_expired' };
      const periods = quotaPeriods(now);
      const exhausted = (): QuotaCode => this.total('day', periods.day, userId) >= limits.daily * MINUTE ? 'voice_daily_limit'
        : this.total('month', periods.month, '*') >= limits.monthly * MINUTE ? 'voice_monthly_limit' : 'voice_quota_expired';
      // Missing renewals consume their reservation, rather than granting free time
      // after a room crash. The room must close its media and join again.
      if (lease && lease.until <= now) return { ok: false, code: exhausted() };
      lease ??= { roomId, userId, until: now, slices: [] };
      lease.slices = lease.slices.filter(slice => slice.until > now);
      const target = Math.min(now + QUOTA_LEASE_MS, deadline);
      let denied: QuotaCode = 'voice_quota_expired';
      while (lease.until < target) {
        const window = quotaPeriods(lease.until);
        const monthlyLeft = Math.max(0, limits.monthly * MINUTE - this.total('month', window.month, '*'));
        const dailyLeft = Math.max(0, limits.daily * MINUTE - this.total('day', window.day, userId));
        const ms = Math.min(target - lease.until, window.monthResetsAt - lease.until, window.dayResetsAt - lease.until, monthlyLeft, dailyLeft);
        if (ms <= 0) { denied = dailyLeft <= 0 ? 'voice_daily_limit' : 'voice_monthly_limit'; break; }
        this.add('month', window.month, '*', ms); this.add('day', window.day, userId, ms);
        const last = lease.slices.at(-1);
        if (last?.month === window.month && last.day === window.day && last.until === lease.until) last.until += ms;
        else lease.slices.push({ from: lease.until, until: lease.until + ms, month: window.month, day: window.day });
        lease.until += ms;
      }
      if (lease.until <= now) return { ok: false, code: denied };
      this.save(id, lease, now);
      return { ok: true, until: lease.until, usage: this.usage(userId, now) };
    });
  }
  release(id: string, roomId: string) {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const lease = this.lease(id);
      if (!lease) { this.save(id, { roomId, userId: '', until: now, slices: [], closed: true }, now); return; }
      if (lease.closed || lease.roomId !== roomId) return;
      for (const slice of lease.slices) {
        const unused = Math.max(0, slice.until - Math.max(now, slice.from));
        if (unused) { this.add('month', slice.month, '*', -unused); this.add('day', slice.day, lease.userId, -unused); }
      }
      // Closing can finish after the grant expires. Keep that elapsed time in
      // the counters too; a slow/failed close must not make minutes disappear.
      for (let from = lease.until; from < now;) {
        const window = quotaPeriods(from);
        const until = Math.min(now, window.monthResetsAt, window.dayResetsAt);
        this.add('month', window.month, '*', until - from); this.add('day', window.day, lease.userId, until - from);
        from = until;
      }
      lease.closed = true; lease.slices = []; this.save(id, lease, now);
    });
  }
}
