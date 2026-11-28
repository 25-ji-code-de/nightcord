/* SPDX-License-Identifier: AGPL-3.0-only */
import { VoiceError } from './protocol';

export type RetryState = { attempts: number; nextAttemptAt: number; firstFailedAt?: number; lastCode?: string };
export type CleanupKind = 'media' | 'uncertain' | 'turn' | 'quota';

// Only bounded, public diagnostics cross this boundary. Never retain response text.
export class UpstreamError extends VoiceError {
  constructor(
    public operation: string, public httpStatus = 0, public publicCode = 'unknown',
    public timedOut = false, public elapsedMs = 0, public retryAfterMs = 0,
  ) { super('upstream_unavailable', 502); }
}

export function retryAfter(previous: RetryState | undefined, kind: CleanupKind, error: unknown, operation: string, taskId: string): RetryState {
  const now = Date.now(), attempts = (previous?.attempts || 0) + 1;
  const firstFailedAt = previous?.firstFailedAt ?? now;
  const upstream = error instanceof UpstreamError ? error : undefined;
  const code = upstream ? `${upstream.httpStatus}:${upstream.publicCode}:${upstream.timedOut ? 'timeout' : 'response'}`
    : error instanceof VoiceError ? error.code : 'cleanup_failed';
  let delays = kind === 'turn' ? [5000, 15000, 60000, 300000] : [2000, 5000, 15000, 30000, 60000];
  // Known allocations can also remain unreachable for days (e.g. SFU timeouts).
  // Keep their closure records, but stop paying for one request per minute per
  // session once the initial recovery window has passed.
  if ((kind === 'uncertain' || kind === 'media') && now - firstFailedAt >= 300000) delays = [120000, 300000, 900000];
  let delay = delays[Math.min(attempts - 1, delays.length - 1)];
  if (upstream && [400, 401, 403, 404].includes(upstream.httpStatus)) delay = Math.max(delay, 300000);
  delay = Math.max(delay, Math.min(upstream?.retryAfterMs || 0, 3600000));
  // Non-security jitter; persist it once so hibernation never resets the delay.
  const nextAttemptAt = now + Math.ceil(delay * (1 + Math.random() * 0.1));
  if (attempts === 1 || previous?.lastCode !== code || (attempts & (attempts - 1)) === 0) {
    console.warn(JSON.stringify({ event: 'voice_cleanup_retry', taskId, operation: upstream?.operation || operation,
      code, attempts, nextAttemptAt, elapsedMs: upstream?.elapsedMs, httpStatus: upstream?.httpStatus, timeout: upstream?.timedOut }));
  }
  return { attempts, nextAttemptAt, firstFailedAt, lastCode: code };
}

export function cleanupComplete(taskId: string, operation: string, reason: string, attempts = 0) {
  console.info(JSON.stringify({ event: 'voice_cleanup_complete', taskId, operation, reason, attempts }));
}
