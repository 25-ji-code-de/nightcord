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

(function () {
  let currentVersion = null;
  let updateBar = null;
  let checking = false;

  async function check() {
    if (checking || document.hidden) return;
    checking = true;
    try {
      const res = await fetch('/version.json?_=' + Date.now(), {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!res.ok) return;
      const data = await res.json();
      const v = data && data.v;
      if (v == null) return;

      if (!currentVersion) {
        currentVersion = v;
        return;
      }

      if (v !== currentVersion) {
        showUpdateBar();
      }
    } catch (e) {
      // Network blips are expected; stay silent
    } finally {
      checking = false;
    }
  }

  function showUpdateBar() {
    if (updateBar) return; // 已经在显示了

    updateBar = document.createElement('div');
    updateBar.className = 'sekai-update-toast';

    // Accessibility attributes
    updateBar.setAttribute('role', 'alert');
    updateBar.setAttribute('aria-live', 'polite');
    updateBar.setAttribute('aria-label', 'Update notification');

    updateBar.innerHTML = `
      <div class="sekai-update-content">
        <svg class="sekai-update-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <polyline points="23 4 23 10 17 10"></polyline>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
        </svg>
        <span>新版本可用 / Update Available</span>
      </div>
      <div class="sekai-update-actions">
        <button type="button" class="sekai-update-btn" data-action="reload" aria-label="Update now">
          Update
        </button>
        <button type="button" class="sekai-update-btn-dismiss" data-action="dismiss" aria-label="Dismiss">
          <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
    `;

    updateBar.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-action]');
      if (!btn) return;
      if (btn.getAttribute('data-action') === 'reload') {
        location.reload();
      } else if (btn.getAttribute('data-action') === 'dismiss') {
        updateBar.remove();
        updateBar = null;
      }
    });

    document.body.appendChild(updateBar);
  }

  // 每 30 秒检查（原 15s 偏密，省一点请求）
  setInterval(check, 30000);

  // 用户切回页面时立即检查
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check();
  });

  check();
})();
