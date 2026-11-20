/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** Builds bounded SEKAI attachment messages from upload results and browser media metadata. */
class AttachmentMessageBuilder {
  constructor({ percentEncode } = {}) { this.percentEncode = percentEncode; }

  /**
   * 构造上传完成后插入输入框的 SEKAI token。
   *
   * 发送策略（服务端 256 字硬顶；渲染侧 v1+v2 全量支持）：
   * - Image / File / Music → v2（payload = uuid 或 legacy key）
   * - descriptions 按优先级塞入，保证整 token ≤ 256（编码后长度）
   * - Music：只发 title（不与 name 双写）；Unknown artist 省略
   * - Stamp 保持 v1 短语法
   *
   * @private
   */
  async _generateFileMessage(uploadType, fileUrl, file, result) {
    // Prefer SEKAI v2 uuid; fall back to legacy key; then full URL
    const id = (result && (result.uuid || result.key) != null)
      ? String(result.uuid || result.key).replace(/^\//, '')
      : (fileUrl || '');

    // v2 upload returns size already in kB; legacy returns bytes
    let sizeKb = '';
    if (result) {
      if (result.uuid != null && result.size != null) {
        sizeKb = +Number(result.size).toFixed(1);
      } else if (result.size_bytes != null) {
        sizeKb = +(Number(result.size_bytes) / 1024).toFixed(1);
      } else if (result.size != null) {
        // Heuristic: values > 100000 are almost certainly bytes
        const n = Number(result.size);
        sizeKb = n > 100000 ? +(n / 1024).toFixed(1) : +n.toFixed(1);
      }
    } else if (file && file.size != null) {
      sizeKb = +(file.size / 1024).toFixed(1);
    }

    const mime = (result && result.type) || (file && file.type) || 'application/octet-stream';
    const name = (result && result.name) || (file && file.name) || 'file';
    const baseName = name.replace(/\.[^/.]+$/, '');

    if (uploadType === 'image') {
      let w = result && result.w;
      let h = result && result.h;
      if (!(w > 0 && h > 0)) {
        try {
          const wh = await this._readImageDimensions(file);
          if (wh) {
            w = wh.w;
            h = wh.h;
          }
        } catch (_) { /* ignore */ }
      }
      // Priority: w/h (layout) > name (optional label)
      const fields = [];
      if (w > 0 && h > 0) {
        fields.push({ key: 'w', value: String(w), encode: false });
        fields.push({ key: 'h', value: String(h), encode: false });
      }
      fields.push({ key: 'name', value: name, encode: true });
      return this._buildSekaiV2Token('Image', fields, id);
    }

    if (uploadType === 'music') {
      const metadata = await this.extractAudioMetadata(file);
      const title = (metadata.title || baseName || 'track').trim();
      const artist = (metadata.artist || '').trim();
      // Priority: type (audio→music routing) → duration (compact) → title → artist.
      // Do NOT emit name alongside title — they were the same filename and
      // percent-encoding CJK twice blew past the 256-char hard cap.
      const fields = [
        { key: 'type', value: mime || 'audio/mpeg', encode: true }
      ];
      if (metadata.durationSec != null && !Number.isNaN(metadata.durationSec) && metadata.durationSec > 0) {
        fields.push({ key: 'duration', value: String(metadata.durationSec), encode: false });
      }
      fields.push({ key: 'title', value: title, encode: true });
      // Skip placeholder artists; only keep a real one when budget allows
      const artistPlaceholder = /^(unknown(\s+artist)?|未知|未知艺术家)$/i;
      if (artist && !artistPlaceholder.test(artist)) {
        fields.push({ key: 'artist', value: artist, encode: true });
      }
      return this._buildSekaiV2Token('Files', fields, id);
    }

    // Generic file card
    const fields = [
      { key: 'type', value: mime, encode: true },
      { key: 'name', value: name, encode: true }
    ];
    if (sizeKb !== '') {
      fields.push({ key: 'size', value: String(sizeKb), encode: false });
    }
    return this._buildSekaiV2Token('Files', fields, id);
  }

  /**
   * Percent-encode a description value (SEKAI §3.4), matching the renderer.
   * @private
   */
  _sekaiEncode(str) {
    if (typeof this.percentEncode === 'function') {
      return this.percentEncode(str);
    }
    return encodeURIComponent(String(str == null ? '' : str));
  }

  /**
   * Clip a string so its percent-encoded form fits in `maxEncoded` chars.
   * @private
   * @returns {string}
   */
  _clipToEncodedBudget(str, maxEncoded) {
    const s = String(str == null ? '' : str);
    if (maxEncoded <= 0) return '';
    if (this._sekaiEncode(s).length <= maxEncoded) return s;

    const characters = Array.from(s);
    let lo = 0;
    let hi = characters.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this._sekaiEncode(characters.slice(0, mid).join('')).length <= maxEncoded) lo = mid;
      else hi = mid - 1;
    }
    return characters.slice(0, lo).join('');
  }

  /**
   * Build a single-line SEKAI v2 token that never exceeds maxLen.
   * Fields are packed in priority order; oversize encoded values are clipped;
   * remaining fields that still don't fit are dropped.
   *
   * Wire form: <$SEKAI:Type:k=v;k2=v2:payload>
   *
   * @private
   * @param {string} type
   * @param {Array<{key:string,value:string,encode?:boolean}>} fields
   * @param {string} payload
   * @param {number} [maxLen=256]
   * @returns {string}
   */
  _buildSekaiV2Token(type, fields, payload, maxLen = 256) {
    const payloadStr = String(payload || '');
    const prefix = `<$SEKAI:${type}:`;
    const suffix = `:${payloadStr}>`;
    let budget = maxLen - prefix.length - suffix.length;

    // Payload alone already over budget (legacy full URL etc.) — strip descs
    if (budget < 0) {
      // Last resort: keep a valid-looking shell truncated by the input cap
      return (prefix + suffix).slice(0, maxLen);
    }

    const included = [];
    for (const f of fields) {
      if (f == null || f.value == null || f.value === '') continue;

      const sep = included.length ? 1 : 0; // ';'
      const keyPart = `${f.key}=`;
      const overhead = sep + keyPart.length;
      if (overhead >= budget) continue;

      let raw = String(f.value);
      let encoded = f.encode === false ? raw : this._sekaiEncode(raw);

      if (encoded.length + overhead > budget) {
        if (f.encode === false) {
          // Numeric / fixed fields can't be partially useful — skip
          continue;
        }
        const avail = budget - overhead;
        if (avail < 1) continue;
        raw = this._clipToEncodedBudget(raw, avail);
        if (!raw) continue;
        encoded = this._sekaiEncode(raw);
        // Defensive: binary-search should fit, but re-check
        if (encoded.length + overhead > budget) continue;
      }

      included.push(keyPart + encoded);
      budget -= overhead + encoded.length;
    }

    return prefix + included.join(';') + suffix;
  }

  /**
   * 读取图片宽高（用于 SEKAI v2 Image w/h 描述）
   * @private
   * @returns {Promise<{w:number,h:number}|null>}
   */
  _readImageDimensions(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      const done = (val) => {
        URL.revokeObjectURL(url);
        resolve(val);
      };
      img.onload = () => done({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => done(null);
      // 超时保护
      setTimeout(() => done(null), 2000);
      img.src = url;
    });
  }

  /**
   * 提取音频文件元数据
   * @param {File} file 音频文件
   * @returns {Promise<{title: string, artist: string, duration: string}>}
   */
  async extractAudioMetadata(file) {
    return new Promise((resolve) => {
      const audio = new Audio();
      const objectUrl = URL.createObjectURL(file);
      const title = (file.name || 'track').replace(/\.[^/.]+$/, '');

      audio.addEventListener('loadedmetadata', () => {
        // v2: duration as seconds (float); keep formatted for any legacy consumers
        const durationSec = Number.isFinite(audio.duration)
          ? Math.round(audio.duration * 10) / 10
          : 0;
        const minutes = Math.floor(durationSec / 60);
        const seconds = Math.floor(durationSec % 60).toString().padStart(2, '0');

        URL.revokeObjectURL(objectUrl);

        resolve({
          title,
          artist: 'Unknown Artist',
          duration: `${minutes}:${seconds}`,
          durationSec
        });
      });

      audio.addEventListener('error', () => {
        URL.revokeObjectURL(objectUrl);
        resolve({
          title,
          artist: 'Unknown Artist',
          duration: '0:00',
          durationSec: 0
        });
      });

      audio.src = objectUrl;
    });
  }
}
