/* SPDX-License-Identifier: AGPL-3.0-only */
import type { Profile } from '../identity';
import { account, fail, reply as messagingReply, type Payload } from '../messaging/protocol';
export type { Payload, Reply } from '../messaging/protocol';
export { MessagingError as DMError, fail, positive, object, body, account, identifier, sequence, boolean, payload, authenticate, bearer } from '../messaging/protocol';

export interface DMSettings {
  DM_MODE?: string;
  DM_MAX_BYTES?: string;
  DM_REQUESTS_HOUR?: string;
  DM_REQUESTS_DAY?: string;
}
export type RequestState = 'none' | 'pending' | 'accepted' | 'rejected';
export type Message = Payload & { seq: number; senderId: string; clientMessageId: string; timestamp: number };
export type Snapshot = {
  id: string; ownerId: string; peer: Profile; version: number; state: RequestState;
  initiator: string | null; refuseIncoming: boolean; lastSeq: number; incoming: number;
  updatedAt: number; lastSenderId: string | null;
};
export function mode(env: DMSettings) { return env.DM_MODE === 'on' ? 'on' : env.DM_MODE === 'read-only' ? 'read-only' : 'off'; }
export function available(env: DMSettings, write = false) {
  if (mode(env) === 'off') fail('dm_disabled', 503);
  if (write && mode(env) !== 'on') fail('dm_read_only', 503);
}
export async function roomKey(a: string, b: string): Promise<string> {
  account(a); account(b);
  if (a === b) return fail('same_account');
  const data = new TextEncoder().encode(JSON.stringify(['nightcord:dm:v1', ...[a, b].sort()]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), n => n.toString(16).padStart(2, '0')).join('');
}

export async function reply(action: Parameters<typeof messagingReply>[0]) {
  const result = await messagingReply(action);
  if (result.data.code === 'service_unavailable') result.data.code = 'dm_unavailable';
  return result;
}
