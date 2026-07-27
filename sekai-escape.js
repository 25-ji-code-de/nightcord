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
 * HTML 转义 —— 拼 innerHTML 时用。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 *
 * 消息正文有两道防线：渲染前过 `DOMPurify.sanitize`，作者名用
 * `textContent` 写（`ui-manager.js` 的 `renderMessage`）。
 *
 * 但**用户名**在另外两个地方是拼进 `innerHTML` 的 —— 语音成员列表与
 * `@` 补全列表。名字来自 SEKAI Pass 的 `name` / `preferred_username`
 * claim，而 Pass 那边只校验长度（≤ 50 字符）：
 *
 *     "><img src=x onerror=alert(1)>        ← 29 个字符
 *
 * 于是任何人改个昵称进来，脚本就在**每个看到这个列表的人**的浏览器里执行。
 * `@` 补全那处还会闭合 `data-name="`，直接逃出属性上下文。
 *
 * DOMPurify 在这里不合适：它是**净化 HTML**，而这些位置要的是
 * 「把文本当文本」。用 sanitize 会默默吃掉名字里合法的尖括号。
 */
(function (global) {
  /**
   * @param {unknown} value
   * @returns {string} 可安全拼进 HTML（元素与带引号属性两种上下文）的文本
   */
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      // `&` 必须最先，否则会把后面生成的实体再转义一次
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  global.escapeHtml = escapeHtml;
})(window);
