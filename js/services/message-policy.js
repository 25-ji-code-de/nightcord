/* SPDX-License-Identifier: AGPL-3.0-only */
/** Shared, deterministic content rules for the browser and chat backend. */
class MessagePolicy {
  static WINDOW_MS = 60000;
  static PERSONAL_LIMIT = 2;
  static GROUP_MESSAGES = 8;
  static GROUP_SENDERS = 4;
  static segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
  static emoji = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u;

  static tokens(text) {
    const Parser = typeof module !== 'undefined' && module.exports ? require('../renderer/parser.js').SekaiParser
      : typeof SekaiParser !== 'undefined' ? SekaiParser : null;
    // The parser caches text: keep that cache local to this operation on Workers.
    return Parser ? new Parser().tokenize(String(text || '')) : [{ type: 'text', content: String(text || '') }];
  }

  static body(text) {
    // Protocol descriptors (file names, dimensions, reply IDs) are not prose.
    // Keep actual formatted/code payloads so formatting cannot bypass the rules.
    return this.tokens(text).map(token => {
      if (token.type === 'text') return token.content;
      if (/^(?:format|code|color|truecolor)$/.test(token.sekaiType)) return token.payload ?? token.data;
      if (/^(?:reply|re|mention|stamp|sticker|img|image|file|files|audio|music|embed|link)$/.test(token.sekaiType)) return '';
      return token.raw || '';
    }).join('').replace(/\[[a-z0-9]+_[^\]\n]*\]/gi, '').replace(/\\n/g, '\n').replace(/\\[rt]/g, ' ').trim();
  }

  static analyze(text) {
    const body = this.body(text);
    const visible = [...this.segmenter.segment(body)].map(part => part.segment).filter(char => !/^\s+$/u.test(char));
    const length = visible.length;
    const emojis = visible.filter(char => this.emoji.test(char)).length;
    const lines = body.split(/\r?\n/).length;
    const braille = visible.filter(char => /^[\u2800-\u28ff]+$/u.test(char)).length;
    const emojiDense = length >= 80 && (emojis / length >= 0.1 || emojis >= 15);
    const reason = emojiDense ? '表情较多的长消息' : braille >= 20 && braille / length >= 0.4
      ? '字符画' : lines > 6 || length >= 180 ? '较长的消息' : null;
    return { length, emojis, lines, reason };
  }

  static fingerprint(text) {
    let value = this.tokens(text).map(token => {
      if (token.type === 'text') return token.content;
      if (/^(?:reply|re|mention)$/.test(token.sekaiType)) return '';
      if (/^(?:format|code|color|truecolor)$/.test(token.sekaiType)) return token.payload ?? token.data;
      // Media/stickers compare their resource identity, never a user-controlled filename.
      return `${token.sekaiType}:${token.payload ?? token.data}`;
    }).join('').normalize('NFKC').toLowerCase().replace(/\\[nrt]/g, ' ');
    // Ignore decorations around prose, but distinguish emoji-only messages.
    const prose = value.replace(/[^\p{L}\p{N}]/gu, '');
    value = prose || [...this.segmenter.segment(value)].map(part => part.segment)
      .filter(char => this.emoji.test(char)).join('');
    if (!value) return '';
    // Fold repeated units such as 67 / 6767, without a keyword blacklist.
    for (let size = 1; size <= Math.min(16, Math.floor(value.length / 2)); size++) {
      if (value.length % size === 0 && value.slice(0, size).repeat(value.length / size) === value) return value.slice(0, size);
    }
    return value;
  }

  static similar(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    // Short replies must match exactly; approximate matching is for copypasta.
    if (Math.min(a.length, b.length) < 40 || Math.min(a.length, b.length) / Math.max(a.length, b.length) < 0.9) return false;
    const grams = value => new Set(Array.from({ length: value.length - 2 }, (_, i) => value.slice(i, i + 3)));
    const left = grams(a), right = grams(b);
    let overlap = 0;
    for (const gram of left) if (right.has(gram)) overlap++;
    return 2 * overlap / (left.size + right.size) >= 0.92;
  }

  static decide(recent, actor, content, now) {
    const matches = recent.filter(entry => entry.timestamp > now - this.WINDOW_MS && entry.timestamp <= now && this.similar(content, entry.content));
    const own = matches.filter(entry => entry.actor === actor).sort((a, b) => b.timestamp - a.timestamp);
    const retryAfter = own.length >= this.PERSONAL_LIMIT
      ? Math.max(1, Math.ceil((own[this.PERSONAL_LIMIT - 1].timestamp + this.WINDOW_MS - now) / 1000)) : 0;
    return { allowed: retryAfter === 0, retryAfter,
      repeated: matches.length + 1 >= this.GROUP_MESSAGES && new Set([...matches.map(entry => entry.actor), actor]).size >= this.GROUP_SENDERS };
  }
}
if (typeof module !== 'undefined' && module.exports) module.exports = { MessagePolicy };
