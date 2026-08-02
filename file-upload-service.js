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
 * FileUploadService - 文件上传服务客户端
 *
 * 默认走 SEKAI v2 三步直传：
 *   POST {baseUrl}/v2/upload/init → POST upload.url → POST {baseUrl}/v2/upload/complete
 * 资源解析：{resourceBaseUrl}/images|files|stickers/{uuid}
 *
 * 大文件走 multipart：/v2/upload/multipart/*
 */
class FileUploadService {
  static get ANON_MAX_UPLOAD_BYTES() { return 536870912; }         // 512 MiB
  static get DIRECT_UPLOAD_MAX_BYTES() { return 838860800; }       // 800 MiB, single gateway request
  static get MULTIPART_MAX_UPLOAD_BYTES() { return 8388608000000; } // 800 MiB * 10,000 parts

  /**
   * @param {Object} [opts]
   * @param {string} [opts.baseUrl] 存储网关（上传）
   * @param {string} [opts.resourceBaseUrl] 资源解析基址（默认同 baseUrl；可绑 r2. 域名）
   * @param {boolean} [opts.useMultipartUpload] 是否允许 multipart 大文件直传（默认 true）
   * @param {number} [opts.timeout] 上传超时（毫秒）
   * @param {() => Promise<string|null>} [opts.getAccessToken] 取 SEKAI Pass token（可选；> 512 MiB 时用）
   */
  constructor(opts = {}) {
    // Storage API signs uploads; resource GET always uses the r2 host.
    this.baseUrl = (opts.baseUrl || 'https://storage.nightcord.de5.net').replace(/\/$/, '');
    this.resourceBaseUrl = (opts.resourceBaseUrl || 'https://r2.nightcord.de5.net').replace(/\/$/, '');
    this.useMultipartUpload = opts.useMultipartUpload !== false;
    this.directUploadMaxBytes = opts.directUploadMaxBytes || FileUploadService.DIRECT_UPLOAD_MAX_BYTES;
    this.multipartMaxUploadBytes = opts.multipartMaxUploadBytes || FileUploadService.MULTIPART_MAX_UPLOAD_BYTES;
    // CF edge → OSS can be slow; allow large files (e.g. ~67MB) without false timeouts.
    this.timeout = opts.timeout || 900000;
    // Optional SEKAI Pass token provider — must resolve null (not throw) when unauthenticated,
    // like NakoAIService. Only used when a file exceeds the anonymous cap.
    this.getAccessToken = typeof opts.getAccessToken === 'function' ? opts.getAccessToken : null;
  }

  /**
   * 运行时注入 SEKAI Pass token provider（构造后接线用）。
   * @param {() => Promise<string|null>} fn
   */
  setGetAccessToken(fn) {
    this.getAccessToken = typeof fn === 'function' ? fn : null;
  }

  /**
   * 上传文件
   * @param {File|Blob} file
   * @param {string} [filename]
   * @param {Function} [onProgress]
   * @param {Object} [extra]
   * @param {'image'|'file'|'sticker'} [extra.kind]
   * @param {number} [extra.w]
   * @param {number} [extra.h]
   * @returns {Promise<Object>}
   */
  async upload(file, filename, onProgress, extra = {}) {
    if (!file || !(file instanceof Blob)) {
      throw new Error('Invalid file object');
    }

    // 客户端软上限，与 storage-worker 对齐：
    //   匿名 ≤ 512 MiB；更大文件需要 SEKAI Pass。
    //   单次 direct ≤ 800 MiB；再大走 multipart。
    const ANON_MAX = FileUploadService.ANON_MAX_UPLOAD_BYTES;
    const size = typeof file.size === 'number' ? file.size : 0;
    const maxUploadBytes = this.useMultipartUpload
      ? this.multipartMaxUploadBytes
      : this.directUploadMaxBytes;
    if (size > maxUploadBytes) {
      throw new Error(`File too large (max ${FileUploadService.formatSize(maxUploadBytes)})`);
    }

    // 超过匿名档才需要 token；未登录时明确报错而不是发一个注定 401 的请求
    let token = null;
    if (size > ANON_MAX) {
      if (this.getAccessToken) {
        try {
          token = await this.getAccessToken();
        } catch (_) {
          token = null;
        }
      }
      if (!token) {
        throw new Error('文件超过 512 MiB，需登录 SEKAI Pass 后才能上传');
      }
    }

    const name = filename || file.name || 'file';

    if (size <= this.directUploadMaxBytes) {
      return this._uploadDirectV2(file, name, onProgress, extra, token);
    }
    if (this.useMultipartUpload) {
      return this._uploadMultipartV2(file, name, onProgress, extra, token);
    }
    throw new Error(`File too large (max ${FileUploadService.formatSize(this.directUploadMaxBytes)})`);
  }

  /**
   * Fake progress that never hits 100% until the server responds.
   *
   * xhr.upload only means bytes left the browser; the Worker may still be
   * writing to R2. Showing a true 100% too early makes users send before the
   * object is readable — so we lie a little:
   *   transfer 0–100% → display 0–92%
   *   bytes sent, waiting for 2xx → crawl 92 → 99%
   *   successful response → snap to 100%
   *
   * UI always shows "N%" (no phase labels).
   *
   * @private
   */
  _attachProgress(xhr, onProgress) {
    if (!onProgress || typeof onProgress !== 'function') {
      return;
    }

    const TRANSFER_CAP = 92; // reserve headroom for server-side finalize
    let progress = 0; // fractional 0–100 internal
    let lastEmitted = -1; // last integer shown to UI
    let finalizeTimer = null;
    let finished = false;

    const emit = (pct) => {
      if (finished) return;
      progress = Math.max(progress, Math.min(100, pct));
      const shown = Math.min(100, Math.floor(progress));
      if (shown === lastEmitted && shown < 100) return;
      lastEmitted = shown;
      try {
        onProgress(shown);
      } catch (_) { /* UI callback must not break upload */ }
    };

    const startFinalizeCrawl = () => {
      if (finalizeTimer || finished) return;
      if (progress < TRANSFER_CAP) emit(TRANSFER_CAP);
      // Slow asymptotic crawl 92 → 99 while the server finalizes
      finalizeTimer = setInterval(() => {
        if (finished || progress >= 99) return;
        const step = Math.max(0.25, (99 - progress) * 0.07);
        emit(Math.min(99, progress + step));
      }, 300);
    };

    const dispose = () => {
      if (finalizeTimer) {
        clearInterval(finalizeTimer);
        finalizeTimer = null;
      }
    };

    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable || e.total <= 0) return;
      const ratio = e.loaded / e.total;
      emit(Math.min(TRANSFER_CAP, ratio * TRANSFER_CAP));
      if (e.loaded >= e.total) startFinalizeCrawl();
    });

    // Some browsers fire upload 'load' without a final progress at 100%
    xhr.upload.addEventListener('load', () => startFinalizeCrawl());

    xhr._sekaiProgress = {
      complete: () => {
        finished = true;
        dispose();
        lastEmitted = -1;
        progress = 100;
        try {
          onProgress(100);
        } catch (_) { /* ignore */ }
      },
      dispose: () => {
        finished = true;
        dispose();
      }
    };
  }

  /**
   * SEKAI v2 preferred upload → init, direct POST to OSS gateway, complete.
   * @private
   */
  async _uploadDirectV2(file, name, onProgress, extra, token) {
    const init = await this._jsonPost('/v2/upload/init', this._uploadInitBody(file, name, extra), token);

    const form = new FormData();
    const fields = (init.upload && init.upload.fields) || {};
    for (const [fieldName, value] of Object.entries(fields)) {
      form.append(fieldName, value);
    }
    form.append('file', file, name);

    const uploaded = await this._xhrRequest({
      method: (init.upload && init.upload.method) || 'POST',
      url: init.upload && init.upload.url,
      body: form,
      onProgress,
      completeProgressOnLoad: false
    });

    const result = await this._jsonPost('/v2/upload/complete', { token: init.complete_token });
    if (uploaded.xhr._sekaiProgress) uploaded.xhr._sekaiProgress.complete();
    return this._normalizeV2Result(result);
  }

  /**
   * SEKAI v2 multipart upload through signed part URLs.
   * @private
   */
  async _uploadMultipartV2(file, name, onProgress, extra, token) {
    if (!token) {
      throw new Error('大文件 multipart 上传需要先登录 SEKAI Pass');
    }

    let multipartToken = null;
    try {
      const init = await this._jsonPost(
        '/v2/upload/multipart/init',
        this._uploadInitBody(file, name, extra),
        token
      );
      multipartToken = init.multipart_token;

      const partSize = Number(init.part_size);
      const partCount = Number(init.part_count);
      const concurrency = Math.max(1, Math.min(4, Number(init.recommended_concurrency) || 2));
      if (!multipartToken || !Number.isSafeInteger(partSize) || partSize <= 0 ||
          !Number.isSafeInteger(partCount) || partCount <= 0) {
        throw new Error('Invalid multipart init response');
      }

      const loadedByPart = new Map();
      let lastPercent = -1;
      const emitProgress = () => {
        if (!onProgress || typeof onProgress !== 'function') return;
        let loaded = 0;
        for (const value of loadedByPart.values()) loaded += value;
        const percent = Math.min(99, Math.floor((loaded / file.size) * 99));
        if (percent === lastPercent) return;
        lastPercent = percent;
        try {
          onProgress(percent);
        } catch (_) { /* UI callback must not break upload */ }
      };

      const completedParts = [];
      const signBatchMax = 20;
      for (let start = 1; start <= partCount; start += signBatchMax) {
        const partNumbers = [];
        for (let n = start; n <= Math.min(partCount, start + signBatchMax - 1); n += 1) {
          partNumbers.push(n);
        }
        const signed = await this._jsonPost('/v2/upload/multipart/parts', {
          token: multipartToken,
          part_numbers: partNumbers
        });
        const batchParts = signed.parts || [];
        const uploadedParts = await this._runLimited(batchParts, concurrency, async (part) => {
          const partNumber = Number(part.part_number);
          const begin = (partNumber - 1) * partSize;
          const end = Math.min(file.size, begin + partSize);
          const body = file.slice(begin, end);
          return this._uploadMultipartPart(part, body, (loaded) => {
            loadedByPart.set(partNumber, Math.min(loaded, end - begin));
            emitProgress();
          });
        });
        completedParts.push(...uploadedParts);
      }

      const result = await this._jsonPost('/v2/upload/multipart/complete', {
        token: multipartToken,
        parts: completedParts
      });
      if (onProgress && typeof onProgress === 'function') {
        try {
          onProgress(100);
        } catch (_) { /* ignore */ }
      }
      return this._normalizeV2Result(result);
    } catch (err) {
      if (multipartToken) {
        this._jsonPost('/v2/upload/multipart/abort', { token: multipartToken }).catch(() => {});
      }
      throw err;
    }
  }

  _uploadInitBody(file, name, extra = {}) {
    const body = {
      name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      kind: extra.kind || this._inferKind(file)
    };
    if (extra.w > 0) body.w = extra.w;
    if (extra.h > 0) body.h = extra.h;
    return body;
  }

  async _jsonPost(path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await this._errorFromResponse(res);
      throw err;
    }
    return res.json();
  }

  async _errorFromResponse(res) {
    let message = `Upload failed: ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch (_) {
      try {
        const text = await res.text();
        if (text) message = text;
      } catch (_) { /* ignore */ }
    }
    const err = new Error(message);
    err.status = res.status;
    return err;
  }

  _errorFromXhr(xhr) {
    let message = `Upload failed: ${xhr.status}`;
    try {
      const body = JSON.parse(xhr.responseText || '{}');
      if (body && body.error) message = body.error;
    } catch (_) { /* ignore */ }
    const err = new Error(message);
    err.status = xhr.status;
    return err;
  }

  _xhrRequest({ method, url, headers = {}, body, onProgress, completeProgressOnLoad = true }) {
    return new Promise((resolve, reject) => {
      if (!url) {
        reject(new Error('Upload URL missing'));
        return;
      }
      const xhr = new XMLHttpRequest();
      this._attachProgress(xhr, onProgress);

      const fail = (err) => {
        if (xhr._sekaiProgress) xhr._sekaiProgress.dispose();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          if (completeProgressOnLoad && xhr._sekaiProgress) xhr._sekaiProgress.complete();
          resolve({
            xhr,
            responseText: xhr.responseText || '',
            getResponseHeader: (name) => xhr.getResponseHeader(name)
          });
        } else {
          fail(this._errorFromXhr(xhr));
        }
      });
      xhr.addEventListener('error', () => fail(new Error('Network error')));
      xhr.addEventListener('abort', () => fail(new Error('Upload aborted')));
      xhr.timeout = this.timeout;
      xhr.addEventListener('timeout', () => fail(new Error('Upload timeout')));

      xhr.open(method, url);
      for (const [name, value] of Object.entries(headers)) {
        xhr.setRequestHeader(name, value);
      }
      xhr.send(body);
    });
  }

  _uploadMultipartPart(part, body, onPartProgress) {
    return new Promise((resolve, reject) => {
      const upload = part && part.upload;
      const xhr = new XMLHttpRequest();
      const fail = (err) => reject(err instanceof Error ? err : new Error(String(err)));

      xhr.upload.addEventListener('progress', (e) => {
        if (!e.lengthComputable || e.total <= 0) return;
        onPartProgress(Math.min(e.loaded, e.total));
      });
      xhr.upload.addEventListener('load', () => onPartProgress(body.size));
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const etag = xhr.getResponseHeader('ETag');
          if (!etag) {
            fail(new Error('Multipart upload did not expose ETag'));
            return;
          }
          resolve({ part_number: Number(part.part_number), etag });
        } else {
          fail(this._errorFromXhr(xhr));
        }
      });
      xhr.addEventListener('error', () => fail(new Error('Network error')));
      xhr.addEventListener('abort', () => fail(new Error('Upload aborted')));
      xhr.timeout = this.timeout;
      xhr.addEventListener('timeout', () => fail(new Error('Upload timeout')));

      xhr.open((upload && upload.method) || 'PUT', upload && upload.url);
      xhr.send(body);
    });
  }

  async _runLimited(items, limit, iteratee) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await iteratee(items[index]);
      }
    });
    await Promise.all(workers);
    return results;
  }

  _normalizeV2Result(result) {
    if (result && result.uuid && !result.key) result.key = result.uuid;
    return result;
  }

  /**
   * @private
   */
  _inferKind(file) {
    const t = (file && file.type) || '';
    if (t.startsWith('image/')) return 'image';
    return 'file';
  }

  /**
   * Resolve a storage key / SEKAI uuid to a fetchable URL.
   * @param {string} keyOrUuid
   * @param {'image'|'file'|'sticker'} [kind]
   * @returns {string}
   */
  getFileUrl(keyOrUuid, kind) {
    if (!keyOrUuid) return '';
    const raw = String(keyOrUuid).replace(/^\//, '');
    if (/^https?:\/\//i.test(raw) || raw.startsWith('//') || raw.startsWith('data:')) {
      return raw;
    }

    // Pure UUID → typed SEKAI path
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
      const k = (kind || 'files').toLowerCase();
      const folder = k === 'image' || k === 'images' ? 'images'
        : k === 'sticker' || k === 'stickers' ? 'stickers'
        : 'files';
      return `${this.resourceBaseUrl}/${folder}/${raw}`;
    }

    // Legacy key: uid/file.ext. Public downloads go through r2, not storage.
    return `${this.resourceBaseUrl}/${raw}`;
  }

  /**
   * @param {string} key
   * @param {'image'|'file'|'sticker'} [kind]
   */
  exists(key, kind) {
    const url = this.getFileUrl(key, kind);
    return fetch(url, { method: 'HEAD' })
      .then((res) => res.ok)
      .catch(() => false);
  }

  delete(key) {
    const cleanKey = String(key).replace(/^\//, '');
    // v2 objects are not exposed via legacy DELETE path by uuid alone;
    // prefer full legacy key when known. Best-effort against typed path is not supported.
    const url = `${this.baseUrl}/${cleanKey}`;

    return fetch(url, { method: 'DELETE' }).then((res) => {
      if (!res.ok) {
        return res
          .json()
          .catch(() => ({}))
          .then((error) => {
            throw new Error(error.error || `Delete failed: ${res.status}`);
          });
      }
      return res.json();
    });
  }

  download(key, saveAs, kind) {
    const url = this.getFileUrl(key, kind);
    const a = document.createElement('a');
    a.href = url;
    if (saveAs) a.download = saveAs;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  getBlob(key, kind) {
    const url = this.getFileUrl(key, kind);
    return fetch(url).then((res) => {
      if (!res.ok) throw new Error(`Failed to fetch file: ${res.status}`);
      return res.blob();
    });
  }

  static validateSize(file, maxSize) {
    return file.size <= maxSize;
  }

  static validateType(file, allowedTypes) {
    if (!file.type) return false;
    return allowedTypes.some((type) => {
      if (type.endsWith('/*')) {
        const prefix = type.slice(0, -2);
        return file.type.startsWith(prefix);
      }
      return file.type === type;
    });
  }

  static formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  }
}

window.FileUploadService = FileUploadService;
