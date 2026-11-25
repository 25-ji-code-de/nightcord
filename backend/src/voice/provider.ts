/* SPDX-License-Identifier: AGPL-3.0-only */
import { fail, readJson, record, VoiceError, type VoiceSecrets } from './protocol';
import { UpstreamError, type RetryState } from './cleanup';

export type MediaSession = {
  id: string; memberId: string; direction: 'publisher' | 'receiver'; generation: number;
  providerId?: string; appId?: string; mids: string[]; retired: boolean; uncertain?: boolean;
  cleanupAttempts?: number; cleanup?: RetryState; cleanupMids?: string[]; closedMids?: string[];
  retiredAt?: number; allocationStartedAt?: number; expectedTracks?: number;
  operationId: string; phase: 'allocating' | 'mutating' | 'answer' | 'ready'; deadline: number;
};
export type CloseProgress = { done: boolean; reason: string; pending: string[]; closed: string[]; failure?: UpstreamError };
const PUBLIC_CODES = new Set(['unauthorized', 'not_found', 'session_error', 'invalid_params', 'decoding_error',
  'close_track_error', 'retryable_transient_error', 'temporarily_unavailable_error', 'backend_error', 'internal_error']);
const publicCode = (value: unknown) => typeof value === 'string' && PUBLIC_CODES.has(value) ? value : 'unknown';

export class Provider {
  constructor(private env: VoiceSecrets) {}
  private async request(path: string, token: string, method: string, body?: unknown, timeoutMs = 10000, operation = 'sfu.mutate') {
    const abort = new AbortController(), started = Date.now();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetch(`https://rtc.live.cloudflare.com/v1/${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: abort.signal,
      });
      if (!response.ok || operation === 'turn.revoke' && response.status !== 204) {
        let code = 'unknown';
        try { code = publicCode(record(await readJson(response, 8192)).errorCode); } catch { /* bounded, optional error body */ }
        const retry = response.headers.get('Retry-After');
        const retryAfterMs = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now())) : 0;
        throw new UpstreamError(operation, response.status, code, abort.signal.aborted, Date.now() - started, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
      }
      if (response.status === 204) { await response.body?.cancel(); return {}; }
      return record(await readJson(response, 262144));
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(operation, 0, error instanceof VoiceError ? 'invalid_response' : 'network_error', abort.signal.aborted, Date.now() - started);
    } finally { clearTimeout(timer); }
  }
  async sfu(path: string, method: string, body?: unknown) {
    return this.request(`apps/${encodeURIComponent(this.env.REALTIME_SFU_APP_ID!)}/${path}`, this.env.REALTIME_SFU_APP_SECRET!, method, body);
  }
  async ice() {
    const data = await this.request(`turn/keys/${encodeURIComponent(this.env.REALTIME_TURN_KEY_ID!)}/credentials/generate-ice-servers`, this.env.REALTIME_TURN_API_TOKEN!, 'POST', { ttl: 3600 }, 10000, 'turn.issue');
    if (!Array.isArray(data.iceServers) || data.iceServers.length > 8) return fail('upstream_unavailable', 502);
    const servers = data.iceServers.map(value => {
      const item = record(value);
      const urls = (Array.isArray(item.urls) ? item.urls : [item.urls]).filter((url): url is string => typeof url === 'string' && /^(?:stun|turn|turns):/.test(url) && !/:53(?:\?|$)/.test(url));
      if (!urls.length || urls.length > 12) return fail('upstream_unavailable', 502);
      return { urls, ...(typeof item.username === 'string' && typeof item.credential === 'string' ? { username: item.username, credential: item.credential } : {}) };
    });
    return { iceServers: servers, iceExpiresAt: Date.now() + 3600000 };
  }
  async revoke(username: string, keyId: string, timeoutMs = 10000) {
    if (keyId !== this.env.REALTIME_TURN_KEY_ID) throw new UpstreamError('turn.revoke', 403, 'key_changed');
    // Only explicit success completes revocation. Expiry is handled by the owner.
    await this.request(`turn/keys/${encodeURIComponent(keyId)}/credentials/${encodeURIComponent(username)}/revoke`, this.env.REALTIME_TURN_API_TOKEN!, 'POST', undefined, timeoutMs, 'turn.revoke');
  }
  async closeStep(session: MediaSession, timeoutMs = 10000): Promise<CloseProgress> {
    if (!session.providerId) return { done: true, reason: 'unallocated', pending: [], closed: [] };
    if (session.appId && session.appId !== this.env.REALTIME_SFU_APP_ID) throw new UpstreamError('sfu.inspect', 403, 'app_changed');
    const path = `apps/${encodeURIComponent(session.appId || this.env.REALTIME_SFU_APP_ID!)}/sessions/${encodeURIComponent(session.providerId)}`;
    const closed = new Set(session.closedMids || []);
    try {
      if (!session.cleanupMids?.length) {
        const info = await this.request(path, this.env.REALTIME_SFU_APP_SECRET!, 'GET', undefined, timeoutMs, 'sfu.inspect');
        if (info.errorCode || !Array.isArray(info.tracks)) throw new UpstreamError('sfu.inspect', 200, publicCode(info.errorCode));
        const pending = new Set(session.mids.filter(mid => !closed.has(mid)));
        for (const value of info.tracks) {
          const track = record(value);
          if (typeof track.mid !== 'string') throw new UpstreamError('sfu.inspect', 200, 'invalid_response');
          if (track.status === 'inactive') { closed.add(track.mid); pending.delete(track.mid); }
          else { closed.delete(track.mid); pending.add(track.mid); }
        }
        return { done: !session.uncertain && !pending.size, reason: pending.size ? 'close_pending' : session.uncertain ? 'outcome_unknown' : 'tracks_closed', pending: [...pending], closed: [...closed] };
      }
      const pending = new Set(session.cleanupMids);
      const result = await this.request(path + '/tracks/close', this.env.REALTIME_SFU_APP_SECRET!, 'PUT',
        { force: true, tracks: [...pending].map(mid => ({ mid })) }, timeoutMs, 'sfu.close');
      let failure: UpstreamError | undefined;
      if (result.errorCode || !Array.isArray(result.tracks)) failure = new UpstreamError('sfu.close', 200, publicCode(result.errorCode));
      else for (const value of result.tracks) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) { failure = new UpstreamError('sfu.close', 200, 'invalid_response'); continue; }
        const track = value as Record<string, unknown>;
        if (typeof track.mid !== 'string' || !pending.has(track.mid)) { failure = new UpstreamError('sfu.close', 200, 'invalid_response'); continue; }
        if (!track.errorCode || track.errorCode === 'close_track_error') { pending.delete(track.mid); closed.add(track.mid); }
        else failure = new UpstreamError('sfu.close', 200, publicCode(track.errorCode));
      }
      if (pending.size) failure ??= new UpstreamError('sfu.close', 200, 'incomplete_response');
      return { done: !failure && !pending.size && !session.uncertain, reason: failure ? 'close_pending' : session.uncertain ? 'outcome_unknown' : 'tracks_closed', pending: [...pending], closed: [...closed], failure };
    } catch (error) {
      if (error instanceof UpstreamError && error.httpStatus === 410 && error.publicCode === 'session_error') {
        return { done: true, reason: 'session_gone', pending: [], closed: [...closed] };
      }
      throw error;
    }
  }
}
