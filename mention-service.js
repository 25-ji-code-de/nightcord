/* SPDX-License-Identifier: AGPL-3.0-only */
(function (global) {
  'use strict';

  class NightcordMentions {
    constructor(renderer) {
      this.renderer = renderer;
    }

    parts(text) {
      if (typeof text !== 'string' || !text) return [];
      return this.renderer ? this.renderer.tokenize(text) : [{ type: 'text', content: text }];
    }

    isMention(part) {
      return part.type === 'sekai' && part.version === 2 && part.sekaiType === 'mention';
    }

    display(part) {
      return part.desc.type?.toLowerCase() === 'all' ? 'everyone' : part.desc.display || part.payload;
    }

    // Preserve full IDs and names. Only description delimiters need escaping.
    format({ type = 'user', id = '', name = '' }) {
      if (!['user', 'ai', 'all'].includes(type) || /[<>\r\n]/.test(id)) return null;
      if (type !== 'all' && !id) return `@${name}`; // Legacy messages without identity.
      const display = String(name).replace(/[%:;=<>+\s]/gu, ch => encodeURIComponent(ch));
      return `<$SEKAI:Mention:type=${type}${display && type !== 'all' ? `;display=${display}` : ''}:${id}>`;
    }

    replaceText(text, name, replacement) {
      if (!name) return text;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(^|[\\s\\p{P}\\p{S}])@${escaped}(?![\\p{L}\\p{N}_-])`, 'giu');
      // Code examples and URLs are not calls or notifications.
      return text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`|https?:\/\/[^\s<>]+)/g)
        .map((part, index) => index % 2 ? part : part.replace(pattern, (_, prefix) => prefix + replacement))
        .join('');
    }

    containsText(text, name) {
      return !!name && this.replaceText(text, name, '') !== text;
    }

    isMentioned(text, user) {
      return this.parts(text).some(part => {
        if (this.isMention(part)) {
          const type = (part.desc.type || 'user').toLowerCase();
          return type === 'all' || (type === 'user' && !!user?.id && part.payload === user.id);
        }
        return part.type === 'text' && (this.containsText(part.content, 'everyone')
          || this.containsText(part.content, user?.displayName));
      });
    }

    // Use readable names in AI prompts; never interpret labels as AI identities.
    prompt(text, aiName) {
      return this.parts(text).map(part => {
        if (this.isMention(part)) {
          return part.desc.type?.toLowerCase() === 'ai' ? '' : `@${this.display(part)}`;
        }
        if (part.type === 'text') return aiName ? this.replaceText(part.content, aiName, '') : part.content;
        if (part.sekaiType === 'reply' || part.sekaiType === 're') return '';
        return part.raw;
      }).join('').trim();
    }
  }

  global.NightcordMentions = NightcordMentions;
})(window);
