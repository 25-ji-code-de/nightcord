/* SPDX-License-Identifier: AGPL-3.0-only */
export const ISSUER = 'https://id.nightcord.de5.net';
export const AUTH_LEASE_MS = 5 * 60 * 1000;

export interface Profile {
  id: string;
  issuer: string | null;
  sub: string | null;
  authenticated: boolean;
  isMobile: boolean;
  displayName: string;
  username: string;
  avatarUrl: string | null;
  bio: string;
}

function firstString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === 'string' && !!value.trim())?.trim() || '';
}

export function profileFromUserInfo(value: unknown, isMobile = false): Profile {
  if (!value || typeof value !== 'object' || !('sub' in value) || typeof value.sub !== 'string' || !value.sub || value.sub.length > 128) {
    throw new Error('Invalid userinfo subject');
  }
  const info = value as Record<string, unknown>;
  const avatar = firstString(info.picture, info.avatar_url);
  let avatarUrl: string | null = null;
  try {
    const url = new URL(avatar);
    if (url.protocol === 'https:' && !url.username && !url.password && avatar.length <= 1024) avatarUrl = url.href;
  } catch { /* Missing or unsafe avatars use the generated fallback. */ }
  return {
    id: `sekai:${value.sub}`, sub: value.sub, issuer: ISSUER, authenticated: true, isMobile,
    displayName: firstString(info.name, info.display_name, info.preferred_username, info.username, value.sub).slice(0, 50),
    username: firstString(info.preferred_username, info.username).slice(0, 50), avatarUrl,
    // SEKAI Pass calls its existing bio field “个性签名” in account settings.
    bio: firstString(info.bio).slice(0, 200),
  };
}

export function guestProfile(name: string, id: string, isMobile = false): Profile {
  return { id, issuer: null, sub: null, authenticated: false, isMobile,
    displayName: name, username: '', avatarUrl: null, bio: '' };
}
