// 演示用的离线后端：静态文件服务 + 路由拦截 + WebSocket 模拟。
// 只服务仓库里的真实前端，不改动任何前端源码。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.mp3': 'audio/mpeg', '.opus': 'audio/ogg',
};

export function startServer(port = 0) {
  const server = http.createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path === '/') path = '/index.html';
      const file = normalize(join(ROOT, path));
      if (!file.startsWith(ROOT) || file.includes('/demo-video/') || file.includes('/.git')) throw new Error('forbidden');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// 固定的“25 时”场景：2026-11-27 00:52 (UTC+8) 起。
export const T0 = Date.UTC(2026, 10, 26, 16, 52, 0);
const min = n => T0 + n * 60000;

const avatarSvg = (a, b, glyph) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><text x="32" y="43" text-anchor="middle" font-family="Noto Sans CJK SC, sans-serif" font-weight="700" font-size="30" fill="#fff" fill-opacity=".92">${glyph}</text></svg>`;
const AVATARS = {
  yue: ['#8b7bd8', '#4b3f8f', '月'], rin: ['#e48ab4', '#8e3f7a', '凛'], mio: ['#5fc8c1', '#2d6f93', '澪'], ya: ['#f0b36a', '#c0507a', '夜'],
};
const avatar = key => `https://avatars.nightcord.invalid/${key}.svg`;
const user = (key, displayName, extra = {}) => ({ id: `sekai:${key}`, displayName, authenticated: true, avatarUrl: avatar(key), ...extra });

export const USERS = {
  yue: user('yue', '月见'),
  rin: user('rin', '凛'),
  mio: user('mio', '澪'),
  ya: user('ya', '夜航'),
};
export const ME = { id: 'guest:7c2f9b1e-2d44-4f3a-9a6e-0b5d1c8a77e1', displayName: '小满', authenticated: false };
export const ME_PASS = { id: 'sekai:xiaoman', displayName: '小满', authenticated: true, avatarUrl: avatar('ya') };

const mention = (u) => `<$SEKAI:Mention:type=user;display=${encodeURIComponent(u.displayName)}:${u.id}>`;
const reply = ts => `<$SEKAI:Reply::${ts}>`;

// 历史消息（顺序即时间顺序）。
export function history(me, { withMine = false } = {}) {
  const m = (n, who, message) => ({ timestamp: min(n), name: who.displayName, message, user: who });
  const nako = (n, message) => ({ timestamp: min(n), name: '月见', message: `[Nako]${message}`, user: USERS.yue });
  const mine = withMine ? [{ timestamp: min(2.5), name: ME.displayName, message: '我也来！先把提纲发出来', user: ME }] : [];
  return [
    m(0, USERS.yue, '凌晨的作业，终于动笔了 🌙'),
    m(1, USERS.rin, '我这边刚把 **第三章** 的草稿整理完'),
    m(2, USERS.mio, '要不要开个语音一起赶？'),
    ...mine,
    m(3, USERS.ya, `${mention(USERS.mio)} 好，我现在就进去`),
    m(4, USERS.yue, '顺便把参考资料贴一下：\n> 夜里写出来的东西，白天读总会有点不好意思'),
    m(5, USERS.rin, `${reply(min(2))}可以呀，我也加入。麦克风先关着，在听`),
    nako(6, '需要我帮你们把提纲按段落整理一下吗？我可以先出一版。'),
    m(7, USERS.mio, `${mention(USERS.rin)} 草稿发我看看，我来帮你过一遍`),
    m(8, USERS.ya, '倒计时：距离 25:00 还有 8 分钟 ⏳'),
  ];
}

const json = (route, data, status = 200, origin = '*') => route.fulfill({
  status, contentType: 'application/json',
  headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': '*' },
  body: JSON.stringify(data),
});

/**
 * 给一个 Playwright page 装上全部网络模拟。
 * options.authenticated: 以 SEKAI Pass 身份进入（语音可用）。
 * options.voice: 模拟语音成员快照。
 */
export async function installMock(page, { port, authenticated = false, room = 'nightcord-default', voiceMembers = [], extraLive = [], withMine = false } = {}) {
  const me = authenticated ? ME_PASS : ME;
  const origin = `http://127.0.0.1:${port}`;
  const state = { ts: min(9), sockets: [] };

  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname === 'avatars.nightcord.invalid') {
      const key = url.pathname.replace(/^\/|\.svg$/g, '');
      const [a, b, g] = AVATARS[key] || AVATARS.ya;
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' }, body: avatarSvg(a, b, g) });
    }
    if (url.hostname === 'chat.nightcord.de5.net') {
      const p = url.pathname;
      if (route.request().method() === 'OPTIONS') return json(route, {}, 204, origin);
      if (p === '/api/guest/session') return json(route, { id: me.id, expiresAt: Date.now() + 90 * 864e5 }, 200, origin);
      if (p.endsWith('/voice/config')) return json(route, { enabled: true, loginRequired: true }, 200, origin);
      if (p === '/api/rooms/config') return json(route, { mode: 'off' }, 200, origin);
      if (p.startsWith('/api/dm')) return json(route, { enabled: false }, 200, origin);
      return json(route, {}, 200, origin);
    }
    return route.abort();
  });

  await page.routeWebSocket(/chat\.nightcord\.de5\.net\/api\/room\/.*\/websocket/, ws => {
    state.sockets.push(ws);
    ws.onMessage(raw => {
      let data; try { data = JSON.parse(raw); } catch { return; }
      if (data.type) return;
      if (data.name || data.accessToken) {
        const send = obj => ws.send(JSON.stringify(obj));
        send({ type: 'session', user: me, visibility: 'online', authExpiresAt: authenticated ? Date.now() + 36e5 : 0, guestExpiresAt: authenticated ? 0 : Date.now() + 90 * 864e5 });
        for (const u of Object.values(USERS)) send({ joined: u.displayName, user: u, silent: true });
        if (authenticated) send({ type: 'room:members', users: [...Object.values(USERS), me] });
        for (const entry of history(me, { withMine })) send(entry);
        send({ ready: true });
        for (const entry of extraLive) setTimeout(() => { try { send(entry.build ? entry.build(me) : entry); } catch {} }, entry.delay || 0);
        if (voiceMembers.length) {
          send({ type: 'voice:state', snapshot: { revision: 1, members: voiceMembers } });
        }
        return;
      }
      if (typeof data.message === 'string') {
        ws.send(JSON.stringify({ timestamp: ++state.ts + 1e3, name: me.displayName, message: data.message, user: me }));
      }
    });
  });
  return { state, me };
}
