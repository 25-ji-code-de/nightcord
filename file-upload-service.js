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
 * 默认走 SEKAI v2 门面：PUT {baseUrl}/v2/upload → { uuid, type, size(kB), name, kind, w?, h? }
 * 资源解析：{resourceBaseUrl}/images|files|stickers/{uuid}
 *
 * 仍兼容 legacy：PUT {baseUrl}/ → { key, url, size(bytes) }
 */
class FileUploadService {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.baseUrl] 存储网关（上传）
   * @param {string} [opts.resourceBaseUrl] 资源解析基址（默认同 baseUrl；可绑 r2. 域名）
   * @param {boolean} [opts.useSekaiV2] 是否使用 /v2/upload（默认 true）
   * @param {number} [opts.timeout] 上传超时（毫秒）
   * @param {() => Promise<string|null>} [opts.getAccessToken] 取 SEKAI Pass token（可选；> 512 MiB 时用）
   */
  constructor(opts = {}) {
    // Upload host (legacy + /v2/upload). Resource GET prefers r2 facade when bound.
    this.baseUrl = (opts.baseUrl || 'https://storage.nightcord.de5.net').replace(/\/$/, '');
    this.resourceBaseUrl = (opts.resourceBaseUrl || 'https://r2.nightcord.de5.net').replace(/\/$/, '');
    this.useSekaiV2 = opts.useSekaiV2 !== false;
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
    //   匿名 ≤ 512 MiB（ANON_MAX，对齐 Cloudflare 缓存对象上限）
    //   持 SEKAI Pass token 可到绝对硬顶 ~1GB（ABS_MAX）
    const ANON_MAX = 536870912;   // 512 MiB
    const ABS_MAX = 1048576000;   // ~1GB
    const size = typeof file.size === 'number' ? file.size : 0;
    if (size > ABS_MAX) {
      throw new Error('File too large (max ~1GB)');
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

    if (this.useSekaiV2) {
      return this._uploadV2(file, name, onProgress, extra, token).catch((err) => {
        // Worker 尚未部署 /v2 时回退 legacy，避免整站上传瘫痪
        console.warn('SEKAI v2 upload failed, falling back to legacy:', err && err.message);
        return this._uploadLegacy(file, name, onProgress, token);
      });
    }
    return this._uploadLegacy(file, name, onProgress, token);
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
   * SEKAI v2 upload → PUT /v2/upload
   * @private
   */
  _uploadV2(file, name, onProgress, extra, token) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this._attachProgress(xhr, onProgress);

      const fail = (err) => {
        if (xhr._sekaiProgress) xhr._sekaiProgress.dispose();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const result = JSON.parse(xhr.responseText);
            // Normalize for callers that still expect .key
            if (result.uuid && !result.key) result.key = result.uuid;
            // size in v2 response is kB; keep size_bytes if present
            if (xhr._sekaiProgress) xhr._sekaiProgress.complete();
            resolve(result);
          } catch (e) {
            fail(new Error('Invalid server response'));
          }
        } else {
          try {
            const error = JSON.parse(xhr.responseText);
            fail(new Error(error.error || `Upload failed: ${xhr.status}`));
          } catch {
            fail(new Error(`Upload failed: ${xhr.status}`));
          }
        }
      });

      xhr.addEventListener('error', () => fail(new Error('Network error')));
      xhr.addEventListener('abort', () => fail(new Error('Upload aborted')));
      xhr.timeout = this.timeout;
      xhr.addEventListener('timeout', () => fail(new Error('Upload timeout')));

      xhr.open('PUT', `${this.baseUrl}/v2/upload`);
      xhr.setRequestHeader('X-Filename', encodeURIComponent(name));
      if (file.type) xhr.setRequestHeader('Content-Type', file.type);
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

      const kind = extra.kind || this._inferKind(file);
      if (kind) xhr.setRequestHeader('X-Sekai-Kind', kind);
      if (extra.w > 0) xhr.setRequestHeader('X-Image-Width', String(extra.w));
      if (extra.h > 0) xhr.setRequestHeader('X-Image-Height', String(extra.h));

      xhr.send(file);
    });
  }

  /**
   * Legacy PUT /
   * @private
   */
  _uploadLegacy(file, name, onProgress, token) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this._attachProgress(xhr, onProgress);

      const fail = (err) => {
        if (xhr._sekaiProgress) xhr._sekaiProgress.dispose();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const result = JSON.parse(xhr.responseText);
            if (xhr._sekaiProgress) xhr._sekaiProgress.complete();
            resolve(result);
          } catch (e) {
            fail(new Error('Invalid server response'));
          }
        } else {
          try {
            const error = JSON.parse(xhr.responseText);
            fail(new Error(error.error || `Upload failed: ${xhr.status}`));
          } catch {
            fail(new Error(`Upload failed: ${xhr.status}`));
          }
        }
      });

      xhr.addEventListener('error', () => fail(new Error('Network error')));
      xhr.addEventListener('abort', () => fail(new Error('Upload aborted')));
      xhr.timeout = this.timeout;
      xhr.addEventListener('timeout', () => fail(new Error('Upload timeout')));

      xhr.open('PUT', this.baseUrl);
      xhr.setRequestHeader('X-Filename', encodeURIComponent(name));
      if (file.type) xhr.setRequestHeader('Content-Type', file.type);
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.send(file);
    });
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

    // Legacy key: uid/file.ext
    return `${this.baseUrl}/${raw}`;
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
