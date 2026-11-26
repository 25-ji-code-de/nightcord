/* SPDX-License-Identifier: AGPL-3.0-only */
import { fail } from '../messaging/protocol';
export * from '../messaging/protocol';
export interface RoomSettings {
  ROOMS_MODE?: string; ROOMS_DISCOVERY?: string; ROOMS_CREATE?: string;
  ROOMS_OFFICIAL?: unknown;
  ROOMS_MAX_TOTAL?: string; ROOMS_MAX_OWNED?: string; ROOMS_MAX_BYTES?: string;
  ROOMS_DAILY_MESSAGES?: string; ROOMS_MODERATORS?: string;
}
export type Settings = { name: string; description: string; discoverability: 'listed' | 'unlisted'; joinPolicy: 'open' | 'invite' };
export type State = Settings & { id: string; ownerId: string; status: 'active' | 'archived'; revision: number;
  publicationVersion: number; createdAt: number; lastSeq: number; bytes: number; quotaDay: string; sentToday: number };
export type Member = { account_id: string; profile: string; status: string; version: number; joined_at: number; next_send_at: number };
export function available(env: RoomSettings, write = false) {
  if (!['on', 'read-only'].includes(env.ROOMS_MODE || '')) fail('rooms_disabled', 503);
  if (write && env.ROOMS_MODE !== 'on') fail('rooms_read_only', 503);
}
export const roomId = (value: unknown): string => typeof value === 'string' && /^r_[a-f0-9]{32}$/.test(value) ? value : fail('not_found', 404);
export function settings(input: Record<string, unknown>): Settings {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60 ||
      typeof input.description !== 'string' || input.description.length > 280 ||
      !['listed', 'unlisted'].includes(String(input.discoverability)) || !['open', 'invite'].includes(String(input.joinPolicy)) ||
      (input.discoverability === 'listed' && input.joinPolicy !== 'open')) fail('invalid_room');
  return { name: (input.name as string).trim(), description: input.description as string,
    discoverability: input.discoverability as Settings['discoverability'], joinPolicy: input.joinPolicy as Settings['joinPolicy'] };
}
export async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2, '0')).join('');
}
export const summary = (s: State) => ({ id: s.id, name: s.name, description: s.description, kind: 'community',
  discoverability: s.discoverability, joinPolicy: s.joinPolicy, ownerId: s.ownerId, status: s.status, revision: s.revision });
