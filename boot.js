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
 * 启动。
 *
 * 这几行原本是 index.html 末尾的一个内联 `<script>` 块 —— 全站最后一个。
 * 挪出来是为了让 `script-src` 能去掉 `'unsafe-inline'`：
 *
 *   带 'unsafe-inline' 时，`<img src=x onerror=…>` 这类注入进 innerHTML 的
 *   内联事件处理器**照样会执行**；去掉之后浏览器直接拒绝执行。
 *
 * 也就是说，这一步是针对刚修掉的那个用户名 XSS（见 sekai-escape.js）的
 * 纵深防御 —— 转义是第一道，CSP 是第二道。
 */
let nightcord = new Nightcord();
const params = new URLSearchParams(location.search);
if (params.has('test')) {
  nightcord.init('nightcord-test');
} else {
  nightcord.init();
}
