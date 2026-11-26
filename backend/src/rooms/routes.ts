/* SPDX-License-Identifier: AGPL-3.0-only */
import { corsHeaders, type ChatEnv } from '../guest';
import { authenticate, available, bearer, body, fail, reply, roomId } from './protocol';
import { create, initialize, listing, primary, unwrap, type Creation } from './directory';
import { officialRooms } from './official';
export async function roomsRoute(request: Request, env: ChatEnv, origin: string) {
  const url = new URL(request.url), path = url.pathname;
  const headers = { ...corsHeaders(origin), 'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Max-Age': '86400' } });
  if (path === '/api/rooms/config' && request.method === 'GET') return Response.json({ mode: env.ROOMS_MODE || 'off', create: env.ROOMS_CREATE !== 'off', discovery: env.ROOMS_DISCOVERY !== 'off', official: officialRooms(env) }, { headers });
  const match = /^\/api\/rooms\/(r_[a-f0-9]{32})(?:\/(.*))?$/.exec(path);
  if (match?.[2] === 'websocket' && request.method === 'GET') {
    const result = await reply(async () => {
      available(env);
      if (!await env.LIMITERS.getByName('rooms-ip:' + (request.headers.get('CF-Connecting-IP') || 'local')).check()) return fail('rate_limited', 429);
      return {};
    });
    if (result.status !== 200) return Response.json(result.data, { status: result.status, headers });
    return env.MANAGED_ROOMS.getByName(match[1]).fetch(request);
  }
  let pending = false;
  const result = await reply(async () => {
    available(env);
    if (path === '/api/rooms' && request.method === 'GET') {
      if (env.ROOMS_DISCOVERY === 'off') return fail('discovery_paused', 503);
      return listing(env, url.searchParams.get('cursor') || '');
    }
    const { user } = await authenticate(env, bearer(request));
    if (path === '/api/me/rooms' && request.method === 'GET') {
      if (env.ROOMS_MODE === 'on') {
        const rows = await primary(env).prepare("SELECT * FROM room_creations WHERE account_id=? AND state='pending' LIMIT 3").bind(user.id).all<Creation>();
        for (const row of rows.results) await initialize(env, user, row);
      }
      return listing(env, url.searchParams.get('cursor') || '', user.id);
    }
    if (!['GET', 'POST', 'PATCH'].includes(request.method)) return fail('method_not_allowed', 405);
    const input: Record<string, unknown> = request.method === 'GET' ? { cursor: url.searchParams.get('cursor') || '', view: url.searchParams.get('view') } : await body(request);
    if (request.method !== 'GET' && !await env.LIMITERS.getByName('rooms-control:' + user.id).check()) return fail('rate_limited', 429);
    if (path === '/api/rooms' && request.method === 'POST') {
      available(env, true); if (env.ROOMS_CREATE === 'off') return fail('creation_paused', 503);
      return create(env, user, input);
    }
    if (!match) return fail('not_found', 404);
    const id = roomId(match[1]), endpoint = match[2] || '';
    if (endpoint === 'moderation' && request.method === 'POST') {
      if (!(env.ROOMS_MODERATORS || '').split(',').includes(user.id)) return fail('not_found', 404);
      if (typeof input.hidden !== 'boolean' || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 280) return fail('invalid_request');
      const db = primary(env);
      await db.batch([
        db.prepare("INSERT INTO room_directory VALUES(?,0,0,'','',0,?) ON CONFLICT(room_id) DO UPDATE SET moderated_hidden=excluded.moderated_hidden").bind(id, +input.hidden),
        db.prepare('INSERT INTO room_moderation_log(actor_id,room_id,hidden,reason,timestamp) VALUES(?,?,?,?,?)').bind(user.id, id, +input.hidden, input.reason, Date.now()),
      ]);
      return { hidden: input.hidden };
    }
    let action = '';
    if (request.method === 'GET') action = ({ '': 'get', members: 'members', invites: 'invites' } as Record<string, string>)[endpoint];
    if (request.method === 'PATCH' && !endpoint) action = 'update';
    if (request.method === 'POST') action = ({ join: 'join', leave: 'leave', transfer: 'transfer', archive: 'archive', invites: 'invite', 'invites/preview': 'preview', 'invites/accept': 'accept' } as Record<string, string>)[endpoint];
    const member = /^members\/([^/]+)\/(remove|ban|unban)$/.exec(endpoint), invite = /^invites\/([^/]+)\/revoke$/.exec(endpoint);
    if (request.method === 'POST' && member) { action = member[2]; input.accountId = decodeURIComponent(member[1]); }
    if (request.method === 'POST' && invite) { action = 'revoke'; input.inviteId = invite[1]; }
    if (!action) return fail('method_not_allowed', 405);
    const value = await env.MANAGED_ROOMS.getByName(id).handle(user, action, input);
    pending = value.status === 202; return unwrap(value);
  });
  return Response.json(result.data, { status: pending && result.status === 200 ? 202 : result.status, headers });
}
