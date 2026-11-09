/* SPDX-License-Identifier: AGPL-3.0-only */
export interface VoiceSecrets {
  VOICE_MODE?: string;
  VOICE_ALLOWED_ROOMS?: string;
  VOICE_REQUIRE_PASS?: string;
  VOICE_MONTHLY_MINUTES?: string;
  VOICE_DAILY_MINUTES?: string;
  REALTIME_SFU_APP_ID?: string;
  REALTIME_SFU_APP_SECRET?: string;
  REALTIME_TURN_KEY_ID?: string;
  REALTIME_TURN_API_TOKEN?: string;
}
export class VoiceError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
export type VoiceResult = { ok: true; value: Record<string, unknown> } | { ok: false; code: string; status: number };
export const fail = (code: string, status = 400): never => { throw new VoiceError(code, status); };
export function configuration(env: VoiceSecrets, room: string) {
  const configured = !!(env.REALTIME_SFU_APP_ID && env.REALTIME_SFU_APP_SECRET && env.REALTIME_TURN_KEY_ID && env.REALTIME_TURN_API_TOKEN);
  const allowed = (env.VOICE_ALLOWED_ROOMS || '').split(',').map(value => value.trim()).includes(room);
  return { enabled: configured && allowed && env.VOICE_MODE === 'on', capacity: 8, loginRequired: env.VOICE_REQUIRE_PASS !== 'false' };
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid_request');
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(value)) return fail('invalid_request');
  return value;
}
export function capability(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return fail('invalid_token', 401);
  return value;
}
export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function description(value: unknown, type: 'offer' | 'answer', publish = false): { type: string; sdp: string } {
  const input = record(value);
  if (input.type !== type || typeof input.sdp !== 'string' || input.sdp.length > 32768 || !input.sdp.startsWith('v=0')) return fail('invalid_sdp');
  // Inspect every media section; JSON kind claims cannot authorize hidden video/data.
  const sections = input.sdp.split(/\r?\nm=/).slice(1);
  if (!sections.length || sections.length > 8 || sections.some(section => !section.startsWith('audio '))) return fail('audio_only');
  if (publish && (sections.length !== 1 || !/^a=sendonly\r?$/m.test(sections[0]) || !/ opus\/48000\//i.test(sections[0]))) return fail('audio_only');
  return { type, sdp: input.sdp };
}
export async function readJson(request: Request | Response, maxBytes = 65536): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return fail('invalid_request');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); return fail('request_too_large', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return fail('invalid_request'); }
}
