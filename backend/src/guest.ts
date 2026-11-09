/* SPDX-License-Identifier: AGPL-3.0-only */
export interface GuestEnv {
  GUEST_SIGNING_KEY?: string;
  GUEST_PREVIOUS_SIGNING_KEY?: string;
  CHAT_ALLOWED_ORIGINS: string;
}

export type ChatEnv = Omit<Env, 'VOICE_MODE' | 'VOICE_ALLOWED_ROOMS' | 'VOICE_REQUIRE_PASS' | 'VOICE_MONTHLY_MINUTES' | 'VOICE_DAILY_MINUTES'> & GuestEnv & import('./voice/protocol').VoiceSecrets;
export type GuestIdentity = { id: string; expiresAt: number };
const COOKIE = '__Host-nightcord_guest';
const LIFETIME = 180 * 86400;
const RENEW_BEFORE = 30 * 86400;
const PURPOSE = 'nightcord-chat/guest/v1\n';
const LOCAL_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const bytes = (value: string) => Uint8Array.from(value.match(/../g)!, pair => parseInt(pair, 16));

export function allowedOrigin(request: Request, env: GuestEnv): string | null {
  const origin = request.headers.get('Origin');
  return origin && origin !== 'null' && env.CHAT_ALLOWED_ORIGINS.split(',').map(s => s.trim()).includes(origin) ? origin : null;
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin', 'Cache-Control': 'no-store',
  };
}

async function signingKey(secret: string | undefined) {
  if (!secret || !/^[0-9a-f]{64}$/.test(secret)) throw new Error('Guest signing key is not configured');
  const raw = bytes(secret);
  const id = hex(await crypto.subtle.digest('SHA-256', raw)).slice(0, 16);
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return { id, key };
}

export async function verifyGuest(request: Request, env: GuestEnv): Promise<(GuestIdentity & { keyId: string }) | null> {
  const values = (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).filter(s => s.startsWith(COOKIE + '='));
  if (values.length !== 1) return null;
  const value = values[0].slice(COOKIE.length + 1);
  const match = /^v1\.([0-9a-f]{16})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9]{1,12})\.([0-9]{1,12})\.([0-9a-f]{64})$/.exec(value);
  if (!match) return null;
  const [, keyId, uuid, issued, expiry, signature] = match;
  const now = Math.floor(Date.now() / 1000);
  if (+issued > now + 60 || +expiry <= now || +expiry <= +issued || +expiry - +issued > LIFETIME) return null;
  for (const secret of [env.GUEST_SIGNING_KEY, env.GUEST_PREVIOUS_SIGNING_KEY]) {
    if (!secret) continue;
    const signer = await signingKey(secret);
    if (signer.id !== keyId) continue;
    const payload = value.slice(0, -(signature.length + 1));
    if (await crypto.subtle.verify('HMAC', signer.key, bytes(signature), encoder.encode(PURPOSE + payload))) {
      return { id: `guest:${uuid}`, expiresAt: +expiry * 1000, keyId };
    }
  }
  return null;
}

export async function guestSession(request: Request, env: GuestEnv, origin: string): Promise<Response> {
  const current = await signingKey(env.GUEST_SIGNING_KEY);
  const existing = await verifyGuest(request, env);
  const headers = new Headers(corsHeaders(origin));
  let identity: GuestIdentity;
  const crossSiteLocal = LOCAL_ORIGIN.test(origin);
  if (existing && existing.keyId === current.id && existing.expiresAt - Date.now() > RENEW_BEFORE * 1000 && !crossSiteLocal) {
    identity = { id: existing.id, expiresAt: existing.expiresAt };
  } else {
    const uuid = existing?.id.slice(6) || crypto.randomUUID();
    const issued = Math.floor(Date.now() / 1000);
    const expires = issued + LIFETIME;
    const payload = `v1.${current.id}.${uuid}.${issued}.${expires}`;
    const signature = hex(await crypto.subtle.sign('HMAC', current.key, encoder.encode(PURPOSE + payload)));
    // Local HTTP development is cross-site with the production chat hostname;
    // its credentialed fetch/WebSocket needs SameSite=None. Production stays Lax.
    const sameSite = crossSiteLocal ? 'None' : 'Lax';
    headers.set('Set-Cookie', `${COOKIE}=${payload}.${signature}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${LIFETIME}`);
    identity = { id: `guest:${uuid}`, expiresAt: expires * 1000 };
  }
  return Response.json(identity, { headers });
}
