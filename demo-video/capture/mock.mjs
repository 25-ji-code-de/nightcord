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

// 对话不编：人物与台词取自 demo-video/reference-chat.jpg（与 index.html 注释里保留的示例对话一致）。
// 时间也同参考图：2026-11-26（UTC+8）15:51 起，截图时刻是 23:46 之后。
const at = (h, m, s = 0) => Date.UTC(2026, 10, 26, h - 8, m, s);
export const NOW = at(23, 46, 30);
export const T_ASK = at(23, 45);       // Amia：有人在吗——？
export const T_REPLY = at(23, 46);     // K：我在

// 图片从 origin/main 的 icons/roleplay/ 同步；保留 HTTPS 地址以通过前端头像校验，实际由本地文件响应。
const AVATARS = {
  k: 'k.png', yuki: 'yuki.png', ena: 'enanan.png', amia: 'amia.png',
};
const avatar = key => `https://avatars.nightcord.invalid/${AVATARS[key]}`;
const user = (key, displayName, extra = {}) => ({ id: `sekai:${key}`, displayName, authenticated: true, avatarUrl: avatar(key), ...extra });

export const USERS = {
  k: user('k', 'K'),
  yuki: user('yuki', '雪'),
  ena: user('ena', 'えななん'),
};
// 视角是 Amia：游客身份进入；语音需要 SEKAI Pass，那一场用 ME_PASS。
export const ME = { id: 'guest:7c2f9b1e-2d44-4f3a-9a6e-0b5d1c8a77e1', displayName: 'Amia', authenticated: false, avatarUrl: avatar('amia') };
export const ME_PASS = { id: 'sekai:amia', displayName: 'Amia', authenticated: true, avatarUrl: avatar('amia') };
export const ASK = '有人在吗——？';

const reply = ts => `<$SEKAI:Reply::${ts}>`;
// K 发的文件，与参考图一致：MIXrough02.mp3，6.9MB。
const FILE = '[file:https://files.nightcord.invalid/MIXrough02.mp3|MIXrough02.mp3|6.9MB MP3]';

// 历史消息（顺序即时间顺序）。withMine：Amia 的“有人在吗——？”已经发出。
export function history(me, { withMine = false } = {}) {
  const m = (ts, who, message) => ({ timestamp: ts, name: who.displayName, message, user: who });
  return [
    m(at(15, 51), USERS.k, '快要可以上传了'),
    m(at(15, 54), me, '哇，好期待♪'),
    m(at(16, 12), USERS.k, FILE),
    m(at(16, 13), me, '谢谢！'),
    m(at(16, 15), USERS.yuki, '我会听的哦'),
    m(at(20, 36), USERS.ena, '那我先下线啦'),
    m(at(20, 38), USERS.k, '嗯。25点再见'),
    m(at(20, 39), USERS.ena, '好～'),
    ...(withMine ? [m(T_ASK, me, ASK)] : []),
  ];
}

// K 的回复（实时推送，回复 Amia 那条）：触发站内回复提醒、收件箱与搜索结果。
export const K_REPLY = { timestamp: T_REPLY, name: 'K', user: USERS.k, message: `${reply(T_ASK)}我在` };

const json = (route, data, status = 200, origin = '*') => route.fulfill({
  status, contentType: 'application/json',
  headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': '*' },
  body: JSON.stringify(data),
});

/**
 * 给一个 Playwright page 装上全部网络模拟。
 * options.authenticated: 以 SEKAI Pass 身份进入（语音可用）。
 * options.voiceMembers: 模拟语音成员快照。
 * options.extraLive: 进入后按 delay 推送的实时消息。
 */
export async function installMock(page, { port, authenticated = false, voiceMembers = [], extraLive = [], withMine = false } = {}) {
  const me = authenticated ? ME_PASS : ME;
  const origin = `http://127.0.0.1:${port}`;
  const state = { ts: T_ASK - 1000, sockets: [] };

  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname === 'avatars.nightcord.invalid') {
      const filename = url.pathname.slice(1);
      if (!Object.values(AVATARS).includes(filename)) return route.abort();
      return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, path: join(ROOT, 'icons/roleplay', filename) });
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
        if (voiceMembers.length) send({ type: 'voice:state', snapshot: { revision: 1, members: voiceMembers } });
        return;
      }
      // 自己发出的消息：用参考图里的时间 23:45 回显
      if (typeof data.message === 'string') {
        ws.send(JSON.stringify({ timestamp: T_ASK, name: me.displayName, message: data.message, user: me }));
      }
    });
  });
  return { state, me };
}
