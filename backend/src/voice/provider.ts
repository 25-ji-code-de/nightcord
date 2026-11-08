/* SPDX-License-Identifier: AGPL-3.0-only */
import { fail, readJson, record, VoiceError, type VoiceSecrets } from './protocol';

export type MediaSession = {
  id: string; memberId: string; direction: 'publisher' | 'receiver'; generation: number;
  providerId?: string; mids: string[]; retired: boolean; uncertain?: boolean;
  cleanupAttempts?: number;
  operationId: string; phase: 'allocating' | 'mutating' | 'answer' | 'ready'; deadline: number;
};

export class Provider {
  constructor(private env: VoiceSecrets) {}
  private async request(path: string, token: string, method: string, body?: unknown) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10000);
    try {
      const response = await fetch(`https://rtc.live.cloudflare.com/v1/${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: abort.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new VoiceError(response.status === 404 || response.status === 410 ? 'upstream_absent' : 'upstream_unavailable', 502);
      }
      if (response.status === 204) { await response.body?.cancel(); return {}; }
      return record(await readJson(response, 262144));
    } catch (error) {
      if (error instanceof VoiceError) throw error;
      throw new VoiceError('upstream_unavailable', 502);
    } finally { clearTimeout(timer); }
  }
  async sfu(path: string, method: string, body?: unknown) {
    const result = await this.request(`apps/${encodeURIComponent(this.env.REALTIME_SFU_APP_ID!)}/${path}`, this.env.REALTIME_SFU_APP_SECRET!, method, body);
    return result;
  }
  async ice() {
    const data = await this.request(`turn/keys/${encodeURIComponent(this.env.REALTIME_TURN_KEY_ID!)}/credentials/generate-ice-servers`, this.env.REALTIME_TURN_API_TOKEN!, 'POST', { ttl: 3600 });
    if (!Array.isArray(data.iceServers) || data.iceServers.length > 8) return fail('upstream_unavailable', 502);
    const servers = data.iceServers.map(value => {
      const item = record(value);
      const urls = (Array.isArray(item.urls) ? item.urls : [item.urls]).filter((url): url is string => typeof url === 'string' && /^(?:stun|turn|turns):/.test(url) && !/:53(?:\?|$)/.test(url));
      if (!urls.length || urls.length > 12) return fail('upstream_unavailable', 502);
      return { urls, ...(typeof item.username === 'string' && typeof item.credential === 'string' ? { username: item.username, credential: item.credential } : {}) };
    });
    return { iceServers: servers, iceExpiresAt: Date.now() + 3600000 };
  }
  async revoke(username: string) {
    try {
      await this.request(`turn/keys/${encodeURIComponent(this.env.REALTIME_TURN_KEY_ID!)}/credentials/${encodeURIComponent(username)}/revoke`, this.env.REALTIME_TURN_API_TOKEN!, 'POST');
    } catch (error) { if (!(error instanceof VoiceError) || error.code !== 'upstream_absent') throw error; }
  }
  async close(session: MediaSession) {
    if (!session.providerId) return;
    let info;
    try { info = await this.sfu(`sessions/${encodeURIComponent(session.providerId)}`, 'GET'); }
    catch (error) { if (error instanceof VoiceError && error.code === 'upstream_absent') return; throw error; }
    if (!Array.isArray(info.tracks)) return fail('upstream_unavailable', 502);
    const mids = new Set(session.mids);
    for (const value of info.tracks) {
      const track = record(value);
      if (typeof track.mid === 'string' && track.status !== 'inactive') mids.add(track.mid);
    }
    if (!mids.size) return;
    const result = await this.sfu(`sessions/${encodeURIComponent(session.providerId)}/tracks/close`, 'PUT', { force: true, tracks: [...mids].map(mid => ({ mid })) });
    if (result.errorCode || !Array.isArray(result.tracks) || result.tracks.length !== mids.size) return fail('upstream_unavailable', 502);
    for (const value of result.tracks) {
      const track = record(value);
      // This is the documented already-absent result, not every close_track_error.
      if (!mids.has(String(track.mid)) || (track.errorCode && !(track.errorCode === 'close_track_error' && track.errorDescription === "Track doesn't exist or was already closed"))) return fail('upstream_unavailable', 502);
      mids.delete(String(track.mid));
    }
    if (mids.size) return fail('upstream_unavailable', 502);
  }
}
