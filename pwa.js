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

/**
 * PWA 引导：注册 Service Worker，并给 version-checker 提供「刷新前先激活新 SW」的入口。
 *
 * 更新提示仍然只来自 version-checker 的 /version.json 轮询。这里刻意不监听
 * updatefound、不自动 skipWaiting、不自动刷新页面：在线内容永远走 network-first，
 * 新 SW 只在用户点 Update 时接管，避免聊天输入被意外清空。
 */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (location.protocol !== 'https:' && !isLocalhost) return;

  let activating = false;

  window.NightcordPWA = {
    /**
     * version-checker 的 Update 按钮入口。
     * 有等待中的新 SW 时先让它激活，再在 controllerchange 时刷新；否则直接刷新。
     */
    async activatePendingUpdate() {
      if (activating) return;

      try {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration && registration.waiting) {
          activating = true;
          let reloaded = false;
          const reload = () => {
            if (reloaded) return;
            reloaded = true;
            location.reload();
          };

          navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
          // 激活迟迟不完成时兜底刷新；network-first 保证刷新拿到的仍是新内容
          setTimeout(reload, 1500);

          try {
            registration.waiting.postMessage({ type: 'SKIP_WAITING' });
          } catch (e) {
            reload();
          }
          return;
        }
      } catch (e) {
        // getRegistration 失败时退回普通刷新
      }

      location.reload();
    },
  };

  navigator.serviceWorker
    .register('/sw.js', { scope: '/', updateViaCache: 'none' })
    .catch((error) => {
      // 注册失败不应影响聊天主流程
      console.warn('[PWA] service worker registration failed', error);
    });
})();
