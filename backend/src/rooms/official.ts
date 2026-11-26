/* SPDX-License-Identifier: AGPL-3.0-only */
import type { RoomSettings } from './protocol';

const defaults = [{ id: 'nightcord-default', name: '作业', description: 'Nightcord 官方公共聊天室。', kind: 'official' }];

// Only explicit operator configuration can label a legacy public channel official.
export function officialRooms(env: RoomSettings) {
  let configured = env.ROOMS_OFFICIAL;
  if (configured === undefined) return defaults;
  if (typeof configured === 'string') {
    try { configured = JSON.parse(configured); } catch { return defaults; }
  }
  if (!Array.isArray(configured)) return defaults;
  const seen = new Set<string>();
  return configured.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const room = entry as Record<string, unknown>;
    // Match public channel IDs exactly; managed rooms and private IDs are excluded.
    if (typeof room.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(room.id) || seen.has(room.id)
      || typeof room.name !== 'string' || !room.name.trim() || room.name.length > 60
      || (room.description !== undefined && (typeof room.description !== 'string' || room.description.length > 280))) return [];
    seen.add(room.id);
    return [{ id: room.id, name: room.name.trim(), description: typeof room.description === 'string' ? room.description : '', kind: 'official' }];
  });
}
