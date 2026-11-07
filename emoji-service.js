/*
 * Copyright (C) 2025-2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: AGPL-3.0-only
 */

(function (global) {
  const SHORTCODE_RE = /:([\p{L}\p{N}_+-]+):/gu;
  const UNICODE_EMOJI_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;
  const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const SKIP_SELECTOR = 'code, pre, a, .sekai-spoiler, .nightcord-emoji';
  const normalizeUnicode = text => text.replace(/\ufe0f/g, '');

  class EmojiService {
    constructor({ data = global.NightcordEmojiData, unicode = global.NightcordEmojiUnicode, baseUrl } = {}) {
      this.data = data || { categories: {} };
      this.baseUrl = (baseUrl || this.data.baseUrl || 'https://emojis.nightcord.de5.net').replace(/\/$/, '');
      this.emojiByShortcode = new Map();
      this.emojiByUnicode = new Map();
      this.emojis = [];

      for (const [category, shortcodes] of Object.entries(this.data.categories || {})) {
        if (!Array.isArray(shortcodes)) continue;
        for (const shortcode of shortcodes) {
          const emoji = this._createEntry(shortcode, category, shortcode, unicode?.[shortcode]);
          this.emojiByShortcode.set(shortcode.toLowerCase(), emoji);
          if (emoji.unicode) this.emojiByUnicode.set(normalizeUnicode(emoji.unicode), emoji);
          this.emojis.push(emoji);
        }
      }

    }

    _createEntry(shortcode, category, filename, unicode) {
      const path = `${encodeURIComponent(category)}/${encodeURIComponent(filename)}.png`;
      return Object.freeze({
        shortcode,
        category,
        unicode,
        path,
        url: `${this.baseUrl}/${path}`
      });
    }

    resolve(shortcode) {
      if (typeof shortcode !== 'string') return null;
      return this.emojiByShortcode.get(shortcode.toLowerCase()) || null;
    }

    getEmojis() {
      return this.emojis;
    }

    tokenize(text) {
      if (typeof text !== 'string') {
        return [{ type: 'text', content: text || '' }];
      }
      if (!text.includes(':')) return this._tokenizeUnicode(text);

      const tokens = [];
      let lastIndex = 0;
      SHORTCODE_RE.lastIndex = 0;
      let match;

      while ((match = SHORTCODE_RE.exec(text))) {
        const emoji = this.resolve(match[1]);
        if (!emoji) continue;
        if (match.index > lastIndex) {
          tokens.push({ type: 'text', content: text.slice(lastIndex, match.index) });
        }
        tokens.push({ type: 'emoji', emoji, raw: match[0] });
        lastIndex = SHORTCODE_RE.lastIndex;
      }

      if (lastIndex === 0) return this._tokenizeUnicode(text);
      if (lastIndex < text.length) tokens.push({ type: 'text', content: text.slice(lastIndex) });
      return tokens.flatMap(token => token.type === 'text' ? this._tokenizeUnicode(token.content) : token);
    }

    _tokenizeUnicode(text) {
      if (!UNICODE_EMOJI_RE.test(text)) return [{ type: 'text', content: text }];

      const tokens = [];
      let lastIndex = 0;
      // Resolve whole graphemes so unsupported skin tones and ZWJ sequences
      // remain intact instead of rendering only part of an emoji.
      for (const { segment, index } of GRAPHEMES.segment(text)) {
        const emoji = this.emojiByUnicode.get(normalizeUnicode(segment));
        if (!emoji) continue;
        if (index > lastIndex) tokens.push({ type: 'text', content: text.slice(lastIndex, index) });
        tokens.push({ type: 'emoji', emoji, raw: segment });
        lastIndex = index + segment.length;
      }
      if (lastIndex === 0) return [{ type: 'text', content: text }];
      if (lastIndex < text.length) tokens.push({ type: 'text', content: text.slice(lastIndex) });
      return tokens;
    }

    createEmojiNode(emoji, rawText) {
      const wrapper = document.createElement('span');
      wrapper.className = 'nightcord-emoji';
      wrapper.title = `:${emoji.shortcode}:`;
      wrapper.setAttribute('role', 'img');
      wrapper.setAttribute('aria-label', rawText);

      const image = document.createElement('img');
      image.className = 'nightcord-emoji__image';
      image.src = emoji.url;
      image.alt = '';
      image.width = 22;
      image.height = 22;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.draggable = false;
      image.setAttribute('aria-hidden', 'true');

      const accessibleText = document.createElement('span');
      accessibleText.className = 'nightcord-emoji__shortcode';
      // Keep the source text in the DOM for native text selection and copying.
      accessibleText.textContent = rawText;

      image.addEventListener('error', () => {
        wrapper.replaceWith(document.createTextNode(rawText));
      }, { once: true });

      wrapper.appendChild(image);
      wrapper.appendChild(accessibleText);
      return wrapper;
    }

    replaceTextNode(textNode) {
      const tokens = this.tokenize(textNode.textContent || '');
      if (!tokens.some((token) => token.type === 'emoji')) return false;

      const fragment = document.createDocumentFragment();
      for (const token of tokens) {
        fragment.appendChild(token.type === 'emoji'
          ? this.createEmojiNode(token.emoji, token.raw)
          : document.createTextNode(token.content));
      }
      textNode.replaceWith(fragment);
      return true;
    }

    processElement(element) {
      if (!element || typeof document.createTreeWalker !== 'function') return;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || !parent.closest(SKIP_SELECTOR)) textNodes.push(node);
      }
      textNodes.forEach((textNode) => this.replaceTextNode(textNode));
    }
  }

  global.EmojiService = EmojiService;
})(window);
