/* SPDX-License-Identifier: AGPL-3.0-only */
import type { VoiceSecrets } from './protocol';

const DAY = 86400000;
const SHANGHAI_OFFSET = 8 * 3600000;
export function quotaLimits(env: VoiceSecrets) {
  const monthly = Number(env.VOICE_MONTHLY_MINUTES ?? 230000);
  const daily = Number(env.VOICE_DAILY_MINUTES ?? 240);
  const valid = [monthly, daily].every(value => Number.isSafeInteger(value) && value > 0 && value <= 10000000);
  return { monthly, daily, valid };
}
export function quotaPeriods(now: number) {
  const utc = new Date(now);
  const local = new Date(now + SHANGHAI_OFFSET);
  return {
    month: utc.toISOString().slice(0, 7), day: local.toISOString().slice(0, 10),
    monthResetsAt: Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth() + 1, 1),
    dayResetsAt: Math.floor((now + SHANGHAI_OFFSET) / DAY + 1) * DAY - SHANGHAI_OFFSET,
  };
}
