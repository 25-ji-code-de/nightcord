/* SPDX-License-Identifier: AGPL-3.0-only */
import { AUTH_LEASE_MS, ISSUER, profileFromUserInfo, type Profile } from '../identity';
import type { ChatEnv } from '../guest';
import { readJson } from '../voice/protocol';

export interface DMSettings {
  DM_MODE?: string;
  DM_MAX_BYTES?: string;
  DM_REQUESTS_HOUR?: string;
  DM_REQUESTS_DAY?: string;
}
export type RequestState = 'none' | 'pending' | 'accepted' | 'rejected';
export type Payload = { kind: 'text' | 'sticker'; text: string; replyTo?: number };
export type Message = Payload & { seq: number; senderId: string; clientMessageId: string; timestamp: number };
export type Snapshot = {
  id: string; ownerId: string; peer: Profile; version: number; state: RequestState;
  initiator: string | null; refuseIncoming: boolean; lastSeq: number; incoming: number;
  updatedAt: number; lastSenderId: string | null;
};
export type Reply = { status: number; data: Record<string, unknown> };
export class DMError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
export const fail = (code: string, status = 400): never => { throw new DMError(code, status); };
export async function reply(action: () => Record<string, unknown> | Promise<Record<string, unknown>>): Promise<Reply> {
  try { return { status: 200, data: await action() }; }
  catch (error) {
    if (error instanceof DMError) return { status: error.status, data: { code: error.code } };
    console.error(JSON.stringify({ event: 'dm_error', code: 'dm_unavailable' }));
    return { status: 503, data: { code: 'dm_unavailable' } };
  }
}
export function mode(env: DMSettings) { return env.DM_MODE === 'on' ? 'on' : env.DM_MODE === 'read-only' ? 'read-only' : 'off'; }
export function available(env: DMSettings, write = false) {
  if (mode(env) === 'off') fail('dm_disabled', 503);
  if (write && mode(env) !== 'on') fail('dm_read_only', 503);
}
export function positive(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid_request');
  return value as Record<string, unknown>;
}
export async function body(request: Request) {
  try { return object(await readJson(request, 8192)); } catch { return fail('invalid_request'); }
}
export function account(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('sekai:') || value.length <= 6 || value.length > 134) return fail('invalid_account');
  return value;
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(value)) return fail('invalid_message_id');
  return value;
}
export function sequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail('invalid_sequence');
  return value;
}
export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return fail('invalid_request');
  return value;
}
export function payload(input: Record<string, unknown>): Payload {
  const kind = input.kind === undefined ? 'text' : input.kind;
  if (kind !== 'text' && kind !== 'sticker') return fail('unsupported_message');
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 256) return fail('invalid_message');
  // The text renderer treats all markup as text. Stickers use a fixed resource host.
  if (kind === 'sticker') {
    const parts = input.text.split('/');
    if (parts.length !== 2 || parts.some(part => !part || part === '.' || part === '..' || /[\u0000-\u001f\\]/.test(part))) return fail('invalid_sticker');
  }
  const result: Payload = { kind, text: input.text };
  if (input.replyTo !== undefined) {
    result.replyTo = sequence(input.replyTo);
    if (!result.replyTo) return fail('invalid_sequence');
  }
  return result;
}
export async function roomKey(a: string, b: string): Promise<string> {
  account(a); account(b);
  if (a === b) return fail('same_account');
  const data = new TextEncoder().encode(JSON.stringify(['nightcord:dm:v1', ...[a, b].sort()]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), n => n.toString(16).padStart(2, '0')).join('');
}
export async function authenticate(env: ChatEnv, token: unknown): Promise<{ user: Profile; expiresAt: number }> {
  if (typeof token !== 'string' || !token || token.length > 4096) return fail('login_required', 401);
  let response: Response;
  try {
    response = await env.SEKAI_PASS.fetch(ISSUER + '/oauth/userinfo', {
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10_000),
    });
  } catch { return fail('auth_unavailable', 503); }
  if (response.status === 401 || response.status === 403) return fail('login_required', 401);
  if (!response.ok) return fail('auth_unavailable', 503);
  try { return { user: profileFromUserInfo(await readJson(response, 16384)), expiresAt: Date.now() + AUTH_LEASE_MS }; }
  catch { return fail('auth_unavailable', 503); }
}
export function bearer(request: Request) { return /^Bearer (.+)$/.exec(request.headers.get('Authorization') || '')?.[1]; }
