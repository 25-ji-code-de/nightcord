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
 * AutocompleteManager - 自动补全模块
 * 负责：
 * 1) @ 提及补全
 * 2) 贴纸补全
 */
(function (global) {
  class AutocompleteManager {
    constructor({ input, list, atButton, getAllUsers, getStickers } = {}) {
      this.input = input;
      this.list = list;
      this.atButton = atButton;
      this.getAllUsers = getAllUsers || (() => []);
      this.getStickers = getStickers || (() => []);

      this.autocompleteIndex = 0;
      this.autocompleteType = null; // 'mention' | 'sticker'
      this.autocompleteStart = 0;

      this.init();
    }

    init() {
      if (!this.input || !this.list) return;

      this.input.addEventListener('keyup', (e) => this.handleInput(e));
      this.input.addEventListener('keydown', (e) => this.handleNav(e));

      document.addEventListener('click', (e) => {
        if (!this.list.contains(e.target) && e.target !== this.input && (!this.atButton || e.target !== this.atButton)) {
          this.hideList();
        }
      });

      if (this.atButton) {
        this.atButton.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.insertAtSymbol();
        });
      }
    }

    isOpen() {
      return !!(this.list && !this.list.classList.contains('hidden'));
    }

    insertAtSymbol() {
      const input = this.input;
      if (!input) return;

      const val = input.value || '';
      const start = input.selectionStart ?? val.length;
      const end = input.selectionEnd ?? start;

      const before = val.slice(0, start);
      const after = val.slice(end);
      input.value = before + '@' + after;

      const newCursorPos = start + 1;
      input.setSelectionRange(newCursorPos, newCursorPos);
      input.focus();

      this.handleInput({ target: input, key: null });
    }

    handleInput(e) {
      if (!this.input || !this.list) return;
      if (e.key && ['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(e.key)) return;

      const targetInput = e.target || this.input;
      const text = targetInput.value;
      const cursor = targetInput.selectionStart;

      // Mentions (@)
      const lastAt = text.lastIndexOf('@', cursor - 1);
      if (lastAt !== -1) {
        const query = text.substring(lastAt + 1, cursor);
        if (!query.includes(' ')) {
          this.autocompleteType = 'mention';
          this.autocompleteStart = lastAt;
          this.showList(query);
          return;
        }
      }

      // Stickers ([)
      const lastBracket = text.lastIndexOf('[', cursor - 1);
      if (lastBracket !== -1) {
        const query = text.substring(lastBracket + 1, cursor);
        if (!query.includes(']') && !query.includes('\n')) {
          this.autocompleteType = 'sticker';
          this.autocompleteStart = lastBracket;
          this.showList(query);
          return;
        }
      }

      this.hideList();
    }

    handleNav(e) {
      if (!this.isOpen()) return;

      const items = this.list.querySelectorAll('.mention-item');
      if (items.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.autocompleteIndex = (this.autocompleteIndex + 1) % items.length;
        this.updateHighlight(items);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.autocompleteIndex = (this.autocompleteIndex - 1 + items.length) % items.length;
        this.updateHighlight(items);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const selected = items[this.autocompleteIndex];
        if (selected) {
          if (this.autocompleteType === 'mention') {
            this.completeMention(selected.dataset.name);
          } else if (this.autocompleteType === 'sticker') {
            this.completeSticker(selected.dataset.code);
          }
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.hideList();
      }
    }

    updateHighlight(items) {
      items.forEach((item, idx) => {
        if (idx === this.autocompleteIndex) {
          item.classList.add('active');
          item.scrollIntoView({ block: 'nearest' });
        } else {
          item.classList.remove('active');
        }
      });
    }

    showList(query) {
      if (this.autocompleteType === 'mention') {
        this.showMentionList(query);
      } else if (this.autocompleteType === 'sticker') {
        this.showStickerList(query);
      }
    }

    showMentionList(query) {
      const allUsers = this.getAllUsers();
      const lowerQuery = query.toLowerCase();

      const matches = allUsers
        .filter(u => u.name.toLowerCase().startsWith(lowerQuery))
        .sort((a, b) => {
          if (a.status !== b.status) return a.status === 'online' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      /*
       * u.name 是别人起的名字（roster 与历史消息的发送者）。
       * 不转义时 `"><img src=x onerror=alert(1)>` 会闭合 data-name="，
       * 直接逃出属性上下文 —— 这一处比成员列表那处还危险。
       */
      this.renderItems(matches, (u) => `
        <div class="mention-item" data-name="${escapeHtml(u.name)}">
          <span class="avatar ${escapeHtml(u.color)}" style="width:24px;height:24px;font-size:12px;line-height:24px;">${escapeHtml(u.avatar)}</span>
          <span>${escapeHtml(u.name)}</span>
          <div class="status-indicator" title="${u.status === 'online' ? '在线' : '离线'}"></div>
        </div>
      `, (item) => this.completeMention(item.dataset.name));
    }

    showStickerList(query) {
      const stickers = this.getStickers();
      if (!stickers || stickers.length === 0) return;

      const lowerQuery = query.toLowerCase();
      let matches = [];
      const underscoreIndex = lowerQuery.indexOf('_');

      if (underscoreIndex !== -1) {
        const categoryQuery = lowerQuery.substring(0, underscoreIndex);
        const termQuery = lowerQuery.substring(underscoreIndex + 1);

        matches = stickers.filter(s => {
          if (s.category.toLowerCase() !== categoryQuery) return false;
          if (!termQuery) return true;
          return s.searchKey.includes(termQuery) || s.label.includes(termQuery);
        });
      } else {
        matches = stickers.filter(s => {
          if (!lowerQuery) return true;
          return s.searchKey.includes(lowerQuery) || s.label.includes(lowerQuery);
        });
      }

      const maxResults = underscoreIndex !== -1 ? 500 : 100;
      matches = matches.slice(0, maxResults);

      /*
       * 贴纸数据来自远端 JSON（sticker.nightcord.de5.net/autocomplete.json）。
       * 是我们自己的基础设施，但仍然是**跨网络来的数据** —— 它不该有能力
       * 决定这一页的标记。
       */
      this.renderItems(matches, (s) => `
        <div class="mention-item sticker-autocomplete-item" data-code="${escapeHtml(s.code)}">
          <img src="${escapeHtml(s.url)}" class="sticker-preview" loading="lazy" />
          <div class="sticker-info">
             <div class="sticker-label">${escapeHtml(s.label)}</div>
             <div class="sticker-desc">${escapeHtml(s.category)}</div>
          </div>
        </div>
      `, (item) => this.completeSticker(item.dataset.code));
    }

    renderItems(items, templateFn, clickHandler) {
      if (!this.list) return;
      if (items.length === 0) {
        this.hideList();
        return;
      }

      this.list.innerHTML = items.map((item, index) => {
        let html = templateFn(item);
        if (index === 0) html = html.replace('class="', 'class="active ');
        return html;
      }).join('');

      this.list.querySelectorAll('.mention-item').forEach(item => {
        item.addEventListener('click', () => clickHandler(item));
      });

      this.list.classList.remove('hidden');
      this.autocompleteIndex = 0;
    }

    hideList() {
      if (!this.list) return;
      this.list.classList.add('hidden');
      this.autocompleteIndex = 0;
    }

    completeMention(username) {
      const input = this.input;
      if (!input) return;

      const cursor = input.selectionStart;
      const text = input.value;
      const lastAt = text.lastIndexOf('@', cursor - 1);

      const before = text.substring(0, lastAt);
      const after = text.substring(cursor);

      input.value = `${before}@${username} ${after}`;
      this.hideList();
      input.focus();

      const newCursorPos = lastAt + username.length + 2;
      input.setSelectionRange(newCursorPos, newCursorPos);
    }

    completeSticker(code) {
      const input = this.input;
      if (!input) return;

      const text = input.value;
      const cursor = input.selectionStart;
      const lastBracket = text.lastIndexOf('[', cursor - 1);

      let afterCursor = text.substring(cursor);
      if (afterCursor.startsWith(']')) {
        afterCursor = afterCursor.substring(1);
      }

      const before = text.substring(0, lastBracket);
      input.value = `${before}[${code}]${afterCursor}`;
      this.hideList();
      input.focus();

      const newPos = lastBracket + code.length + 2;
      input.setSelectionRange(newPos, newPos);
    }
  }

  global.AutocompleteManager = AutocompleteManager;
})(window);
