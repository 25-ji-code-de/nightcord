/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** Pure encoding and resource URL helpers shared by parsing and rendering. */
class SekaiResources {
  constructor({ resourceBaseUrl = 'https://r2.nightcord.de5.net', storageBaseUrl = resourceBaseUrl } = {}) {
    this.resourceBaseUrl = resourceBaseUrl;
    this.storageBaseUrl = storageBaseUrl;
  }

  /**
   * Percent-decode (RFC 3986); also accept '+' as space.
   * @private
   */
  percentDecode(str) {
    if (!str) return '';
    try {
      return decodeURIComponent(String(str).replace(/\+/g, '%20'));
    } catch {
      // Malformed percent sequence — return as-is
      return String(str).replace(/\+/g, ' ');
    }
  }

  /**
   * Percent-encode description values (spec §3.4).
   * Encodes only characters that break the description grammar.
   */
  percentEncode(str) {
    if (str == null) return '';
    // Must encode: ; = : < > % and whitespace; leave other unreserved/safe chars
    return String(str).replace(/[^A-Za-z0-9\-._~/@!$&'()*+,]/gu, (ch) => {
      if (ch === ' ') return '%20';
      const hex = ch.charCodeAt(0).toString(16).toUpperCase();
      if (ch.charCodeAt(0) < 0x80) {
        return '%' + hex.padStart(2, '0');
      }
      // Multi-byte UTF-8
      return Array.from(new TextEncoder().encode(ch))
        .map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0'))
        .join('');
    });
  }

  /**
   * Decode payload according to `enc` description.
   * @private
   */
  decodePayload(payload, enc) {
    if (!enc) return payload;
    if (String(enc).toLowerCase() === 'base64') {
      return this.base64DecodeUtf8(payload);
    }
    return payload;
  }

  /**
   * UTF-8-safe Base64 decode.
   * @private
   */
  base64DecodeUtf8(b64) {
    try {
      const bin = atob(b64.replace(/\s+/g, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch (e) {
      console.warn('SEKAI base64 decode failed:', e);
      return b64;
    }
  }

  /**
   * UTF-8-safe Base64 encode (construction helper).
   */
  base64EncodeUtf8(str) {
    const bytes = new TextEncoder().encode(String(str));
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  /**
   * Resolve a Tier-1 resource payload to a fetchable URL.
   * @param {string} payload uuid | legacy key | absolute URL
   * @param {'image'|'file'|'sticker'} [kind]
   */
  resolveResource(payload, kind) {
    if (!payload) return '';
    const p = String(payload).trim();
    if (/^https?:\/\//i.test(p) || p.startsWith('//') || p.startsWith('data:')) {
      return p;
    }
    const clean = p.replace(/^\//, '');

    // SEKAI v2 pure UUID
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean)) {
      const k = (kind || 'file').toLowerCase();
      const folder = k === 'image' || k === 'images' ? 'images'
        : k === 'sticker' || k === 'stickers' || k === 'stamp' ? 'stickers'
        : 'files';
      return `${this.resourceBaseUrl}/${folder}/${clean}`;
    }

    // Legacy storage key: prefer storageBaseUrl (may equal resourceBaseUrl)
    return `${this.storageBaseUrl}/${clean}`;
  }

  /**
   * Parse boolean description values (true/false, case-insensitive).
   * @private
   */
  _descBool(desc, key, defaultValue = false) {
    if (!desc || desc[key] == null || desc[key] === '') return defaultValue;
    const v = String(desc[key]).toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'no') return false;
    return defaultValue;
  }
}
