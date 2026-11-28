/*
 * Nightcord - A modern, modular real-time chat application
 * Copyright (C) 2025 The 25-ji-code-de Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/*
 * Nightcord Service Worker
 *
 * 缓存契约（改动前请先读 test/pwa.test.mjs）：
 *   1. 只接管同源 GET 的导航 / 脚本 / 样式 / manifest / 图标。
 *   2. /version.json、/api/*、Range、音频、跨域、no-store 一律放手给网络。
 *   3. 在线时代码只信网络（network-first），缓存只作离线兜底 —— 绝不 cache-first。
 *   4. 预缓存键是 "/"，因为站点的 /index.html 会 308 到 "/"。
 *   5. 站点对未知路径返回 200 + index.html，所以写入缓存前必须校验 Content-Type，
 *      否则一个拼错的 URL 会把 HTML 当成 JS 缓存。
 *   6. 新 SW 默认 waiting；只有页面在用户点 Update 后发 SKIP_WAITING 才接管。
 */

'use strict';

const CACHE_NAME = 'nightcord-v1';
const DEVICE_CACHE = 'nightcord-device';
const DEVICE_STATE = '/__nightcord_push_state__';

const PRECACHE = [
  '/css/direct-messages.css',
  '/js/services/direct-messages.js',
  '/js/app/room-destination.js',
  '/js/network/managed-room-session.js',
  '/js/services/rooms.js',
  '/js/ui/room-admin.js',
  '/js/ui/room-settings.js',
  '/js/ui/managed-chat.js',
  '/js/ui/rooms.js',
  '/js/services/roleplay.js',
  '/js/ui/roleplay.js',
  '/css/roleplay.css',
  '/icons/roleplay/k.png',
  '/icons/roleplay/yuki.png',
  '/icons/roleplay/enanan.png',
  '/icons/roleplay/amia.png',
  '/css/rooms.css',
  '/js/ui/direct-messages.js',
  '/',
  '/manifest.json',
  // index.html 中的样式表
  '/vendor/sekai-design/primitives.css',
  '/vendor/sekai-design/contract.css',
  '/vendor/sekai-design/world-system.css',
  '/vendor/sekai-design/world-night.css',
  '/vendor/sekai-design/chat.css',
  '/vendor/sekai-design/modal.css',
  '/css/palettes.css',
  '/css/app-shell.css',
  '/css/app-shell/profile.css',
  '/css/app-shell/layout.css',
  '/css/app-shell/messages.css',
  '/css/app-shell/autocomplete.css',
  '/css/app-shell/dialogs.css',
  '/css/app-shell/responsive.css',
  '/css/navigation.css',
  '/css/renderer.css',
  '/css/renderer/text.css',
  '/css/renderer/music.css',
  '/css/renderer/audio.css',
  '/css/renderer/cards.css',
  '/css/renderer/responsive.css',
  '/css/notifications.css',
  '/css/image-viewer.css',
  '/css/attachments.css',
  '/css/composer-format.css',
  '/css/voice.css',
  '/css/appearance.css',
  '/css/settings.css',
  '/css/sidebar-tools.css',
  '/css/task-station.css',
  '/css/ios-layout.css',
  '/icons/task-tools.svg',
  '/icons/task-printer.svg',
  '/icons/task-recorder.svg',
  '/icons/sekai-pass.svg',
  // index.html 中的脚本
  '/appearance.js',
  '/purify.js',
  '/sekai-escape.js',
  '/performance-optimizer.js',
  '/vendor/sekai-auth.global.js',
  '/sekai-pass-auth.js',
  '/auth-errors.js',
  '/sekai-analytics.js',
  '/event-bus.js',
  '/ai-config.js',
  '/websocket-mgr.js',
  '/js/network/chat-session.js',
  '/nightcord-mgr.js',
  '/storage-manager.js',
  '/file-upload-service.js',
  '/nako-ai-service.js',
  '/ui-sticker-service.js',
  '/emoji-data.js',
  '/emoji-unicode-data.js',
  '/emoji-service.js',
  '/js/renderer/parser.js',
  '/js/renderer/resources.js',
  '/js/renderer/text.js',
  '/js/renderer/images.js',
  '/js/renderer/cards.js',
  '/js/renderer/audio-controls.js',
  '/js/renderer/music.js',
  '/js/renderer/audio.js',
  '/sekai-renderer.js',
  '/mention-service.js',
  '/sekai-image-viewer.js',
  '/js/ui/autocomplete-mentions.js',
  '/js/ui/autocomplete-picker.js',
  '/ui-autocomplete.js',
  '/composer-format.js',
  '/user-profile.js',
  '/js/services/message-alerts.js',
  '/js/ui/alert-preferences.js',
  '/js/ui/alert-delivery.js',
  '/js/ui/alert-sounds.js',
  '/js/ui/alert-banner.js',
  '/js/ui/alert-settings.js',
  '/js/ui/chat-alerts.js',
  '/js/ui/reading-position.js',
  '/js/ui/events.js',
  '/js/ui/name-chooser.js',
  '/js/ui/room-view.js',
  '/js/ui/roster.js',
  '/js/ui/message-list.js',
  '/js/ui/streaming.js',
  '/js/ui/composer.js',
  '/js/ui/uploads.js',
  '/js/services/attachment-message.js',
  '/js/ui/message-view.js',
  '/js/ui/replies.js',
  '/js/ui/notifications.js',
  '/js/ui/mentions.js',
  '/js/ui/navigation.js',
  '/ui-manager.js',
  '/voice-manager.js',
  '/voice-ui.js',
  '/js/sidebar/helpers.js',
  '/js/sidebar/storage.js',
  '/js/sidebar/messages.js',
  '/js/sidebar/task-form.js',
  '/js/sidebar/task-tickets.js',
  '/js/sidebar/task-slips.js',
  '/js/sidebar/help.js',
  '/sidebar-features.js',
  '/js/services/message-commands.js',
  '/js/app/identity.js',
  '/js/services/ai-conversation.js',
  '/js/ui/voice-sounds.js',
  '/nightcord.js',
  '/boot.js',
  '/pangu.js',
  '/pwa.js',
  '/js/services/push-notifications.js',
  '/css/pwa.css',
  '/version-checker.js',
  // 图标与 favicon
  '/icons/nightcord-logotype.svg',
  '/icons/composer-tools.svg',
  '/icons/favicon.svg',
  '/icons/favicon-32.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

const STATIC_DESTINATIONS = new Set(['script', 'style', 'manifest', 'image', 'font']);

/** 根据扩展名给出期望的 Content-Type 片段；返回空串表示不校验。 */
function expectedType(pathname) {
  if (pathname === '/' || pathname.endsWith('.html')) return 'text/html';
  if (pathname.endsWith('.css')) return 'text/css';
  if (pathname.endsWith('.js') || pathname.endsWith('.mjs')) return 'javascript';
  if (pathname.endsWith('.json')) return 'json';
  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.svg')) return 'image/svg+xml';
  return '';
}

/** 只接受完整、同源、类型匹配的 200 响应。 */
function isCacheable(pathname, res) {
  if (!res || res.status !== 200 || res.type !== 'basic') return false;
  const expected = expectedType(pathname);
  if (!expected) return true;
  const contentType = res.headers.get('content-type') || '';
  return contentType.includes(expected);
}

async function putInCache(cacheKey, res) {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(cacheKey, res);
  } catch (e) {
    // 配额、Vary: * 等异常都不应影响页面
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const results = await Promise.allSettled(
        PRECACHE.map(async (path) => {
          const res = await fetch(new Request(path, { cache: 'reload' }));
          if (!isCacheable(new URL(path, self.location.origin).pathname, res)) return false;
          await cache.put(path, res.clone());
          return true;
        }),
      );

      // 清掉已经从 PRECACHE 移除的旧条目
      const keep = new Set(PRECACHE.map((path) => new URL(path, self.location.origin).href));
      const stale = (await cache.keys()).filter((request) => !keep.has(request.url));
      await Promise.all(stale.map((request) => cache.delete(request).catch(() => false)));

      // 没有应用外壳的 SW 一律不激活：让浏览器下次导航重新安装
      const shellIndex = PRECACHE.indexOf('/');
      const shell = results[shellIndex];
      if (!shell || shell.status !== 'fulfilled' || shell.value !== true) {
        throw new Error('Nightcord SW: failed to precache the app shell');
      }
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('nightcord-') && name !== CACHE_NAME && name !== DEVICE_CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
  if (data?.type === 'PUSH_STATE' && event.source?.url && new URL(event.source.url).origin === self.location.origin) {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(DEVICE_CACHE);
        const state = data.state;
        if (state && typeof state.ownerId === 'string' && state.ownerId.startsWith('sekai:')) {
          await cache.put(DEVICE_STATE, new Response(JSON.stringify({ ownerId: state.ownerId, rooms: state.rooms || {}, pausedUntil: state.pausedUntil || 0, expiresAt: Date.now() + 90 * 86400000 }), { headers: { 'Content-Type': 'application/json' } }));
        } else {
          await cache.delete(DEVICE_STATE);
          for (const notification of await self.registration.getNotifications()) notification.close();
          await self.navigator?.clearAppBadge?.();
        }
        event.ports?.[0]?.postMessage({ ok: true });
      } catch { event.ports?.[0]?.postMessage({ ok: false }); }
    })());
  }
});

function isPushRoom(room) { return typeof room === 'string' && /^(?:[a-z0-9-]{1,32}|[a-f0-9]{64}|r_[a-f0-9]{32})$/.test(room); }
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let payload;
    try { payload = event.data?.json(); } catch { return; }
    const room = payload?.type === 'room' && isPushRoom(payload.room);
    if (!room && (payload?.type !== 'dm' || !/^[a-f0-9]{64}$/.test(payload.conversation))) return;
    const state = await (await (await caches.open(DEVICE_CACHE)).match(DEVICE_STATE))?.json();
    if (!state || state.ownerId !== payload.ownerId || state.pausedUntil > Date.now() || state.expiresAt <= Date.now()) return;
    if (room) {
      const prefs = state.rooms?.[payload.room];
      if (!prefs || prefs.pausedUntil > Date.now() || !['message', 'reply', 'mention', 'everyone'].some(key => prefs[key] === true)) return;
    }
    // userVisibleOnly requires a notification even when a window is focused;
    // silently consuming pushes can revoke the subscription on Safari.
    await self.registration.showNotification('Nightcord', {
      body: room ? '聊天室有新消息，请打开 Nightcord 查看。' : '您有新的私信，请打开 Nightcord 查看。', icon: '/icons/icon-192.png',
      tag: room ? 'room:' + payload.room : 'dm:' + payload.conversation, renotify: false,
      data: room ? { type: 'room', ownerId: payload.ownerId, room: payload.room } : { ownerId: payload.ownerId, conversation: payload.conversation },
    });
    try { await self.navigator?.setAppBadge?.(); } catch { /* Optional API. */ }
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const data = event.notification.data;
    const room = data?.type === 'room' && isPushRoom(data.room);
    if (!data || !room && !/^[a-f0-9]{64}$/.test(data.conversation)) return;
    const state = await (await (await caches.open(DEVICE_CACHE)).match(DEVICE_STATE))?.json();
    if (state?.ownerId !== data.ownerId || state.expiresAt <= Date.now()) return;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find(window => {
      const url = new URL(window.url);
      return url.origin === self.location.origin && ['/', '/index.html'].includes(url.pathname);
    });
    if (client) {
      await client.focus();
      const received = await new Promise(resolve => {
        const channel = new MessageChannel();
        const finish = ok => { clearTimeout(timer); channel.port1.close(); resolve(ok); };
        const timer = setTimeout(() => finish(false), 1500);
        channel.port1.onmessage = event => finish(event.data?.ok === true);
        try { client.postMessage({ ...data, type: room ? 'OPEN_ROOM' : 'OPEN_DM' }, [channel.port2]); }
        catch { finish(false); }
      });
      if (received) return;
    }
    // An older or still-loading tab may not understand notification navigation.
    // Open another window rather than navigating away from its unsent draft.
    await self.clients.openWindow(room ? '/?' + (data.room.startsWith('r_') ? 'room=' : 'chat=') + encodeURIComponent(data.room) : '/?dm=' + data.conversation);
  })());
});

/** 导航：network-first，失败时回退到预缓存的应用外壳。 */
async function handleNavigation(event) {
  try {
    const res = await fetch(event.request);
    if (res.status >= 500) throw new Error('Nightcord SW: navigation responded 5xx');
    if (isCacheable('/', res)) {
      event.waitUntil(putInCache('/', res.clone()));
    }
    return res;
  } catch (e) {
    const cached = await caches.match('/');
    return cached || Response.error();
  }
}

/** 静态资源：network-first，失败时回退缓存。 */
async function handleStatic(event, request, url) {
  const cacheKey = url.origin + url.pathname;
  try {
    const res = await fetch(request);
    if (res.status >= 500) {
      const cached = await caches.match(cacheKey);
      return cached || res;
    }
    if (isCacheable(url.pathname, res)) {
      event.waitUntil(putInCache(cacheKey, res.clone()));
    }
    return res;
  } catch (e) {
    const cached = await caches.match(cacheKey);
    return cached || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 版本检查必须永远打到网络，绝不进缓存
  if (url.pathname === '/version.json') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/cdn-cgi/')) return;

  if (
    request.cache === 'no-store' ||
    request.cache === 'reload' ||
    request.cache === 'only-if-cached'
  ) {
    return;
  }
  if (request.headers.has('range') || request.headers.has('authorization')) return;
  if (request.destination === 'audio' || request.destination === 'video') return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  const isStatic =
    STATIC_DESTINATIONS.has(request.destination) ||
    /\.(js|mjs|css)$/.test(url.pathname) ||
    url.pathname === '/manifest.json';
  if (!isStatic) return;

  event.respondWith(handleStatic(event, request, url));
});
