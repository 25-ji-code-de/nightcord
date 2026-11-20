/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
// SEKAI v2 §3.3: ALPHA *(ALPHA / DIGIT / "-"). Shared by all syntax consumers.
const V2_TYPE_SOURCE = '[A-Za-z][A-Za-z0-9-]*';
const V2_TYPE_ANCHORED = new RegExp(`^(${V2_TYPE_SOURCE})`);

/** Parses SEKAI syntax without DOM, UI, or network dependencies. */
class SekaiParser {
  constructor({ maxTokensPerMessage = 50, maxPayloadBytes = 64 * 1024 } = {}) {
    this.maxTokensPerMessage = maxTokensPerMessage;
    this.maxPayloadBytes = maxPayloadBytes;
    this.tokenCache = new Map();
    this.tokenCacheMaxSize = 100;
    this.codec = new SekaiResources();
  }

  normalizeSyntax(text) {
    // [stamp0000] / [stamp_0000] -> [stamp:0000] (v1 sugar only)
    return text.replace(/\[stamp(\d+)\]/gi, '[stamp:$1]')
               .replace(/\[stamp_(\d+)\]/gi, '[stamp:$1]');
  }

  /**
   * Dual-parser entry (cached).
   * Pass A: SEKAI v2 (<$SEKAI:…>)
   * Pass B: SEKAI v1 ([type:data]) on residual text segments
   */
  tokenize(text) {
    if (this.tokenCache.has(text)) {
      return this.tokenCache.get(text);
    }

    const tokens = this.tokenizeDual(text);

    if (this.tokenCache.size >= this.tokenCacheMaxSize) {
      const firstKey = this.tokenCache.keys().next().value;
      this.tokenCache.delete(firstKey);
    }
    this.tokenCache.set(text, tokens);
    return tokens;
  }

  /**
   * @private
   */
  tokenizeDual(text) {
    const v2Tokens = this.tokenizeV2(text);
    const result = [];
    let tokenCount = 0;

    for (const part of v2Tokens) {
      if (part.type === 'sekai') {
        if (tokenCount >= this.maxTokensPerMessage) {
          // Cap exceeded — keep remaining as text
          result.push({ type: 'text', content: part.raw || '' });
          continue;
        }
        result.push(part);
        tokenCount++;
      } else {
        const v1Parts = this.tokenizeV1(part.content);
        for (const v1 of v1Parts) {
          if (v1.type === 'sekai') {
            if (tokenCount >= this.maxTokensPerMessage) {
              result.push({ type: 'text', content: v1.raw || '' });
              continue;
            }
            result.push(v1);
            tokenCount++;
          } else if (v1.content) {
            result.push(v1);
          }
        }
      }
    }

    return result;
  }

  /**
   * SEKAI v2 tokenizer (spec §3).
   * Malformed sequences fall back to plain text (spec §10.1).
   * @private
   */
  tokenizeV2(text) {
    const tokens = [];
    const OPEN = '<$SEKAI:';
    const CLOSE_MULTI = '<&SEKAI>';
    let i = 0;

    while (i < text.length) {
      const start = text.indexOf(OPEN, i);
      if (start === -1) {
        if (i < text.length) {
          tokens.push({ type: 'text', content: text.slice(i) });
        }
        break;
      }

      // Preceding text
      if (start > i) {
        tokens.push({ type: 'text', content: text.slice(i, start) });
      }

      // Parse header after OPEN: Type:descriptions[:payload]>  OR  Type:descriptions>\n...
      const headerStart = start + OPEN.length;
      const parsed = this._parseV2TokenAt(text, headerStart, start, CLOSE_MULTI);
      if (!parsed) {
        // Malformed — emit the opening sentinel as text and continue one char past it
        tokens.push({ type: 'text', content: OPEN });
        i = headerStart;
        continue;
      }

      tokens.push(parsed.token);
      i = parsed.endIndex;
    }

    return tokens;
  }

  /**
   * Parse a single v2 token starting at `headerStart` (immediately after `<$SEKAI:`).
   * @returns {{ token: object, endIndex: number } | null}
   * @private
   */
  _parseV2TokenAt(text, headerStart, absoluteStart, closeMulti) {
    // Type: ALPHA *(ALPHA / DIGIT / "-")  — also allow "X-" vendor prefix
    const typeMatch = text.slice(headerStart).match(V2_TYPE_ANCHORED);
    if (!typeMatch) return null;
    const rawType = typeMatch[1];
    let cursor = headerStart + rawType.length;

    if (text[cursor] !== ':') return null;
    cursor++; // skip ':' after Type

    // Descriptions run until next unencoded ':' (payload sep) or '>' (multi-line open)
    // Values may contain percent-encoded chars; raw ':' is forbidden in values (must be %3A)
    // We scan for the next ':' or '>' that ends the descriptions section.
    let descEnd = cursor;
    let foundPayloadSep = false;
    let foundMultiOpen = false;

    while (descEnd < text.length) {
      const ch = text[descEnd];
      if (ch === '>') {
        foundMultiOpen = true;
        break;
      }
      if (ch === ':') {
        foundPayloadSep = true;
        break;
      }
      if (ch === '\n' || ch === '\r') {
        // Bare newline inside header — malformed
        return null;
      }
      descEnd++;
    }

    if (!foundPayloadSep && !foundMultiOpen) return null;

    const descRaw = text.slice(cursor, descEnd);
    const desc = this.parseDescriptions(descRaw);

    let payload = '';
    let endIndex;
    let raw;

    if (foundMultiOpen) {
      // Multi-line: opening tag ends at '>'; payload until a line that is only <&SEKAI>
      const openTagEnd = descEnd + 1; // past '>'
      // Skip the rest of the opening line (should be empty / whitespace only after '>')
      let lineEnd = text.indexOf('\n', openTagEnd);
      if (lineEnd === -1) {
        // No body — treat as empty multi-line without close → malformed
        return null;
      }
      // Content after '>' on same line must be whitespace only
      if (text.slice(openTagEnd, lineEnd).trim() !== '') {
        return null;
      }

      // Find closing tag line
      let bodyStart = lineEnd + 1;
      let searchFrom = bodyStart;
      let closePos = -1;
      while (searchFrom <= text.length) {
        const nextNl = text.indexOf('\n', searchFrom);
        const line = nextNl === -1
          ? text.slice(searchFrom)
          : text.slice(searchFrom, nextNl);
        // Closing tag MUST be sole non-whitespace content of its line
        if (line.trim() === closeMulti) {
          closePos = searchFrom;
          // endIndex after this line (and its trailing newline if any)
          endIndex = nextNl === -1 ? text.length : nextNl + 1;
          // payload is everything before the closing line (preserve leading/trailing blanks)
          payload = text.slice(bodyStart, closePos);
          // Drop the final newline that precedes the closing tag line (standard: payload between lines)
          if (payload.endsWith('\n')) payload = payload.slice(0, -1);
          if (payload.endsWith('\r')) payload = payload.slice(0, -1);
          break;
        }
        if (nextNl === -1) break;
        searchFrom = nextNl + 1;
      }
      if (closePos === -1) return null; // unclosed multi-line
      raw = text.slice(absoluteStart, endIndex);
    } else {
      // Single-line: payload until unescaped '>'
      const payloadStart = descEnd + 1; // past ':'
      let payloadEnd = payloadStart;
      while (payloadEnd < text.length) {
        if (text[payloadEnd] === '>') break;
        if (text[payloadEnd] === '\n' || text[payloadEnd] === '\r') {
          // Newline inside single-line payload — malformed
          return null;
        }
        payloadEnd++;
      }
      if (payloadEnd >= text.length || text[payloadEnd] !== '>') return null;
      payload = text.slice(payloadStart, payloadEnd);
      endIndex = payloadEnd + 1;
      raw = text.slice(absoluteStart, endIndex);
    }

    // Payload size cap
    if (payload.length > this.maxPayloadBytes) {
      return null;
    }

    // Decode payload if enc=base64
    const decodedPayload = this.codec.decodePayload(payload, desc.enc);

    return {
      token: {
        type: 'sekai',
        version: 2,
        sekaiType: rawType.toLowerCase(),
        rawType,
        data: decodedPayload,
        payload: decodedPayload,
        metadata: [],
        desc,
        raw
      },
      endIndex
    };
  }

  /**
   * Parse description string "k=v;k2=v2" with percent-decoding of values.
   * @private
   */
  parseDescriptions(raw) {
    const out = {};
    if (!raw) return out;
    const pairs = raw.split(';');
    for (const pair of pairs) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const key = pair.slice(0, eq).trim();
      if (!key) continue;
      const valueRaw = pair.slice(eq + 1);
      out[key] = this.codec.percentDecode(valueRaw);
    }
    return out;
  }

  /**
   * SEKAI v1 tokenizer (legacy).
   * @private
   */
  tokenizeV1(text) {
    if (!text) return [];
    const tokens = [];
    const sekaiRegex = /\[(\w+):([^\]]+)\]/g;
    let lastIndex = 0;
    let match;

    while ((match = sekaiRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        tokens.push({
          type: 'text',
          content: text.slice(lastIndex, match.index)
        });
      }

      const [mainData, ...metadata] = match[2].split('|');

      tokens.push({
        type: 'sekai',
        version: 1,
        sekaiType: match[1].toLowerCase(),
        rawType: match[1],
        data: mainData,
        payload: mainData,
        metadata,
        desc: {},
        raw: match[0]
      });

      lastIndex = sekaiRegex.lastIndex;
    }

    if (lastIndex < text.length) {
      tokens.push({
        type: 'text',
        content: text.slice(lastIndex)
      });
    }

    return tokens;
  }
}
