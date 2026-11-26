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
    get mentionView() { return this._mentionView ||= new AutocompleteMentions(this); }
    get pickerView() { return this._pickerView ||= new AutocompletePicker(this); }

    constructor({ allowAI = () => true, input, list, atButton, stickerButton, pickerButtons = {}, getAllUsers, getStickers, getEmojis, formatMention, renderAvatar, onError } = {}) {
      this.input = input; this.allowAI = allowAI;
      this.list = list;
      this.atButton = atButton;
      this.stickerButton = stickerButton;
      this.pickerButtons = pickerButtons;
      this.getAllUsers = getAllUsers || (() => []);
      this.getStickers = getStickers || (() => []);
      this.getEmojis = getEmojis || (() => []);
      this.formatMention = formatMention || (mention => `@${mention.name}`);
      this.renderAvatar = renderAvatar;
      this.onError = onError || (() => {});

      this.autocompleteIndex = 0;
      this.autocompleteType = null; // 'mention' | 'sticker' | 'emoji'
      this.autocompleteStart = 0;
      this.pendingStickerPair = null;

      this.init();
    }

    init() {
      if (!this.input || !this.list) return;

      this.listeners = new AbortController();
      const options = { signal: this.listeners.signal };
      this.input.addEventListener('input', (e) => this.handleInput(e), options);
      this.input.addEventListener('keydown', (e) => this.handleNav(e), options);

      document.addEventListener('click', (e) => {
        if (!this.list.contains(e.target) && e.target !== this.input && !this.stickerButton?.contains(e.target)
            && !Object.values(this.pickerButtons).some(button => button.contains(e.target))) {
          this.hideList();
        }
      }, { ...options, capture: true });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !e.isComposing && this.isOpen() &&
            (this.list.contains(e.target) || this.stickerButton?.contains(e.target)
              || Object.values(this.pickerButtons).some(button => button.contains(e.target)))) {
          e.preventDefault();
          this.hideList();
          (this.pickerButtons[this.autocompleteType] || (this.autocompleteType === 'sticker' ? this.stickerButton : this.input))?.focus();
        }
      }, options);

      for (const [type, button] of Object.entries(this.pickerButtons)) {
        button.setAttribute('aria-controls', this.list.id);
        button.setAttribute('aria-expanded', 'false');
        button.addEventListener('click', () => {
          if (this.isOpen(type)) { this.hideList(); this.input.focus(); }
          else this.openPicker(type);
        }, options);
      }

      if (this.atButton) {
        this.atButton.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.insertAtSymbol();
        }, options);
      }
    }

    isOpen(type = this.autocompleteType) {
      return !!(this.list && type === this.autocompleteType && !this.list.classList.contains('hidden'));
    }

    syncExpanded() {
      this.atButton?.setAttribute('aria-expanded', String(this.isOpen('mention')));
      this.stickerButton?.setAttribute('aria-expanded', String(this.isOpen('sticker') || this.isOpen('emoji')));
      for (const [type, button] of Object.entries(this.pickerButtons)) button.setAttribute('aria-expanded', String(this.isOpen(type)));
    }

    /** Open the existing picker without changing the draft until an item is chosen. */
    openPicker(type) {
      this.hideList();
      this.autocompleteType = type;
      this.pickerSelection = { start: this.input.selectionStart, end: this.input.selectionEnd };
      this.showList('');
      if (this.isOpen()) this.list.querySelector('.picker-category.active')?.focus({ preventScroll: true });
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
      this.pickerSelection = null;
      if (this.pendingStickerPair && text !== this.pendingStickerPair.value) {
        this.pendingStickerPair = null;
      }

      // Emoji (:shortcode:). Require a boundary before the opening colon so
      // URL schemes and times do not open the picker.
      const beforeCursor = text.substring(0, cursor);
      const emojiMatch = beforeCursor.match(/(^|[\s([{"':])(:([\p{L}\p{N}_+-]*))$/u);
      if (beforeCursor.endsWith('::')) {
        this.autocompleteType = 'emoji';
        this.autocompleteStart = cursor - 2;
        this.showList('');
        return;
      } else if (emojiMatch) {
        this.autocompleteType = 'emoji';
        this.autocompleteStart = cursor - emojiMatch[2].length;
        this.showList(emojiMatch[3]);
        return;
      }

      // Mentions (@)
      const lastAt = text.lastIndexOf('@', cursor - 1);
      if (lastAt !== -1) {
        const query = text.substring(lastAt + 1, cursor);
        if (!/[\s<>:]/.test(query) && (lastAt === 0 || /[\s([{，。！？、]/.test(text[lastAt - 1]))) {
          this.autocompleteType = 'mention';
          this.autocompleteStart = lastAt;
          this.showList(query);
          return;
        }
      }

      // Stickers ([)
      const lastBracket = text.lastIndexOf('[', cursor - 1);
      if (beforeCursor.endsWith('[]')) {
        this.autocompleteType = 'sticker';
        this.autocompleteStart = cursor - 2;
        this.showList('');
        return;
      }
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
      if (e.isComposing || e.keyCode === 229) return;
      if (!this.isOpen()) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        this.hideList();
        return;
      }

      const items = this.list.querySelectorAll('.mention-item, .picker-grid-item');
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
            this.completeMention(selected.dataset.name, selected.dataset.type, selected.dataset.id);
          } else if (this.autocompleteType === 'sticker') {
            this.completeSticker(selected.dataset.code);
          } else if (this.autocompleteType === 'emoji') {
            this.completeEmoji(selected.dataset.shortcode);
          }
        }
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
      } else if (this.autocompleteType === 'emoji') {
        this.showEmojiList(query);
      }
    }

    mentionCandidates(...args) { return this.mentionView.mentionCandidates(...args); }

    mentionGroups(...args) { return this.mentionView.mentionGroups(...args); }

    showMentionList(...args) { return this.mentionView.showMentionList(...args); }

    renderMentionAvatar(...args) { return this.mentionView.renderMentionAvatar(...args); }

    createMentionIcon(...args) { return this.mentionView.createMentionIcon(...args); }

    showStickerList(...args) { return this.pickerView.showStickerList(...args); }

    showEmojiList(...args) { return this.pickerView.showEmojiList(...args); }

    getCategoryLabel(...args) { return this.pickerView.getCategoryLabel(...args); }

    showPicker(...args) { return this.pickerView.showPicker(...args); }

    renderPickerGrid(...args) { return this.pickerView.renderPickerGrid(...args); }

    renderItems(...args) { return this.pickerView.renderItems(...args); }

    hideList() {
      if (!this.list) return;
      this.pickerSelection = null;
      const pair = this.pendingStickerPair;
      this.pendingStickerPair = null;
      if (pair && this.input.value === pair.value) {
        this.input.setRangeText('', pair.start, pair.start + 2, 'preserve');
        this.input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      this.list.classList.add('hidden');
      this.syncExpanded();
      this.list.classList.remove('picker-mode');
      this.autocompleteIndex = 0;
    }

    completeMention(name, type = 'user', id = '') {
      const input = this.input;
      if (!input) return;
      const cursor = input.selectionStart;
      const lastAt = input.value.lastIndexOf('@', cursor - 1);
      if (lastAt < 0) return;
      this.insertMention({ name, type, id }, lastAt, cursor);
    }

    insertMention(mention, start = this.input?.selectionStart, end = this.input?.selectionEnd) {
      const input = this.input;
      if (!input) return;
      const token = this.formatMention(mention);
      const value = input.value.slice(0, start) + token + ' ' + input.value.slice(end);
      const limit = input.maxLength > 0 ? input.maxLength : 256;
      if (!token || value.length > limit) {
        this.onError('消息剩余空间不足，请缩短内容后再添加提及。');
        return;
      }
      input.value = value;
      this.hideList();
      input.focus();
      const newCursorPos = start + token.length + 1;
      input.setSelectionRange(newCursorPos, newCursorPos);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    completeSticker(code) {
      const input = this.input;
      if (!input) return;
      if (this.pickerSelection) {
        this.insertPickerToken(`[${code}]`, this.pickerSelection.start, this.pickerSelection.end);
        return;
      }

      const text = input.value;
      const cursor = input.selectionStart;
      const lastBracket = text.lastIndexOf('[', cursor - 1);
      if (lastBracket < 0) return;

      let afterCursor = text.substring(cursor);
      if (afterCursor.startsWith(']')) {
        afterCursor = afterCursor.substring(1);
      }

      this.insertPickerToken(`[${code}]`, lastBracket, text.length - afterCursor.length);
    }

    completeEmoji(shortcode) {
      const input = this.input;
      if (!input) return;
      if (this.pickerSelection) {
        this.insertPickerToken(`:${shortcode}:`, this.pickerSelection.start, this.pickerSelection.end);
        return;
      }

      const text = input.value;
      const cursor = input.selectionStart;
      let afterCursor = text.substring(cursor);
      if (afterCursor.startsWith(':')) afterCursor = afterCursor.substring(1);

      this.insertPickerToken(`:${shortcode}:`, this.autocompleteStart, text.length - afterCursor.length);
    }

    insertPickerToken(token, start, end) {
      const input = this.input;
      const value = input.value.slice(0, start) + token + input.value.slice(end);
      if (input.maxLength > 0 && value.length > input.maxLength) {
        this.onError('消息剩余空间不足，请缩短内容后再添加表情或贴纸。');
        return;
      }
      input.value = value;
      this.hideList();
      input.focus();
      const newPos = start + token.length;
      input.setSelectionRange(newPos, newPos);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    destroy() {
      this.listeners?.abort();
      this.hideList();
    }
  }

  global.AutocompleteManager = AutocompleteManager;
})(window);
