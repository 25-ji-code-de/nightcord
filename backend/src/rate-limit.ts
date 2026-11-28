/* SPDX-License-Identifier: AGPL-3.0-only */
// Rolling windows, shared by all rooms using the same IP or verified guest ID.
// Keep the longest window last; each log is bounded by that window's allowance.
export const RATE_POLICIES = {
  connection: [[60000, 20]],
  'guest-session': [[60000, 12], [3600000, 120]],
  'guest-identity': [[60000, 3], [3600000, 20]],
  'guest-room': [[60000, 2], [3600000, 10]],
  'guest-join': [[60000, 6], [3600000, 40]],
  'guest-ip-join': [[60000, 12], [3600000, 120]],
  'guest-message': [[10000, 2], [60000, 6], [3600000, 120]],
  'guest-ip-message': [[10000, 4], [60000, 12], [3600000, 240]],
  'guest-frame': [[10000, 20]],
} as const;
export type RatePolicy = keyof typeof RATE_POLICIES;
export type RateDecision = { allowed: boolean; retryAfter: number };

export function consumeRate(policy: RatePolicy, previous: number[], now: number): RateDecision & { events: number[] } {
  const windows = RATE_POLICIES[policy];
  const events = previous.filter(at => at > now - windows[windows.length - 1][0]);
  let retryAfter = 0;
  for (const [period, limit] of windows) {
    const active = events.filter(at => at > now - period);
    if (active.length >= limit) retryAfter = Math.max(retryAfter, Math.ceil((active[active.length - limit] + period - now) / 1000));
  }
  return { allowed: retryAfter === 0, retryAfter, events: retryAfter ? events : [...events, now] };
}
