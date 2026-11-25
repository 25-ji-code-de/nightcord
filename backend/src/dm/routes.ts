/* SPDX-License-Identifier: AGPL-3.0-only */
import type { ChatEnv } from '../guest';
import { corsHeaders } from '../guest';
import { account, authenticate, available, bearer, body, fail, mode, reply, roomKey, type Reply, type Snapshot } from './protocol';

export async function dmRoute(request: Request, env: ChatEnv, origin: string): Promise<Response> {
  const url = new URL(request.url);
  const headers = { ...corsHeaders(origin), 'Cache-Control': 'no-store',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204,
    headers: { ...headers, 'Access-Control-Max-Age': '86400' } });
  if (url.pathname === '/api/dm/config' && request.method === 'GET') return Response.json({ mode: mode(env), enabled: mode(env) !== 'off' }, { headers });
  const result = await reply(async () => {
    available(env);
    if (url.pathname === '/api/dm/events' && request.method === 'GET') return {};
    const { user } = await authenticate(env, bearer(request));
    const inbox = env.DM_INBOXES.getByName(user.id);
    if (request.method === 'GET' && url.pathname === '/api/dm/conversations') {
      return unwrap(await inbox.handle(user, 'list', { cursor: url.searchParams.get('cursor') || '' }));
    }
    if (request.method !== 'GET' && request.method !== 'POST') return fail('method_not_allowed', 405);
    const input = request.method === 'POST' ? await body(request) : {};
    if (request.method === 'POST' && !url.pathname.endsWith('/read')) {
      const limiter = env.LIMITERS.getByName((url.pathname.endsWith('/messages') ? 'user:' : 'dm-control:') + user.id);
      if (!await limiter.check()) return fail('rate_limited', 429);
    }
    if (url.pathname === '/api/dm/conversations' && request.method === 'POST') {
      available(env, true);
      const peerId = account(input.peerId);
      const id = await roomKey(user.id, peerId);
      if (typeof input.sourceRoom !== 'string' || !/^([a-z0-9-]{1,32}|[0-9a-f]{64})$/.test(input.sourceRoom)) return fail('invalid_room');
      let sourceId: DurableObjectId;
      try { sourceId = input.sourceRoom.length === 64 ? env.ROOMS.idFromString(input.sourceRoom) : env.ROOMS.idFromName(input.sourceRoom); }
      catch { return fail('not_found', 404); }
      const peer = await env.ROOMS.get(sourceId).directPeer(user.id, peerId);
      if (!peer) return fail('peer_unavailable', 404);
      unwrap(await inbox.handle(user, 'reserve', { peerId }));
      const initialized = unwrap(await env.DM_ROOMS.getByName(id).handle(user, 'initialize', {}, { id, peer }));
      return unwrap(await inbox.handle(user, 'get', { id }, initialized.conversation as Snapshot));
    }
    const match = /^\/api\/dm\/conversations\/([a-f0-9]{64})(?:\/(messages|accept|reject|refuse|hide|read|sync))?$/.exec(url.pathname);
    if (!match) return fail('not_found', 404);
    const [, id, action] = match;
    const room = env.DM_ROOMS.getByName(id);
    if (request.method === 'GET') {
      if (action === 'messages') {
        const params: Record<string, unknown> = {};
        for (const key of ['before', 'after']) if (url.searchParams.has(key)) params[key] = Number(url.searchParams.get(key));
        return unwrap(await room.handle(user, 'history', params));
      }
      if (action) return fail('method_not_allowed', 405);
      const checked = unwrap(await room.handle(user, 'checkpoint', { seq: 0 }));
      return unwrap(await inbox.handle(user, 'get', { id }, checked.conversation as Snapshot));
    }
    if (action === 'hide' || action === 'read') {
      const checkpoint = unwrap(await room.handle(user, 'checkpoint', { seq: action === 'read' ? input.seq : 0 }));
      return unwrap(await inbox.handle(user, action, action === 'hide'
        ? { id, hidden: input.hidden } : { id, seq: checkpoint.seq, incoming: checkpoint.incoming }, checkpoint.conversation as Snapshot));
    }
    if (!action || !['messages', 'accept', 'reject', 'refuse', 'sync'].includes(action)) return fail('not_found', 404);
    const value = unwrap(await room.handle(user, action === 'messages' ? 'send' : action, input));
    const own = unwrap(await inbox.handle(user, 'get', { id }, value.conversation as Snapshot));
    return { ...value, conversation: own.conversation, revision: own.revision };
  });
  if (result.status !== 200 || url.pathname !== '/api/dm/events') return Response.json(result.data, { status: result.status, headers });
  try {
    const owner = account(url.searchParams.get('account'));
    const limiter = env.LIMITERS.getByName('dm-ip:' + (request.headers.get('CF-Connecting-IP') || 'local'));
    if (!await limiter.check()) return Response.json({ code: 'rate_limited' }, { status: 429, headers });
    return await env.DM_INBOXES.getByName(owner).fetch(request);
  } catch { return Response.json({ code: 'dm_unavailable' }, { status: 503, headers }); }
}
function unwrap(result: Reply) {
  if (result.status !== 200) return fail(String(result.data.code || 'dm_unavailable'), result.status);
  return result.data;
}
