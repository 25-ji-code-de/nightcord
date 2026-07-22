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
   */
  constructor(opts = {}) {
    // Upload host (legacy + /v2/upload). Resource GET prefers r2 facade when bound.
    this.baseUrl = (opts.baseUrl || 'https://storage.nightcord.de5.net').replace(/\/$/, '');
    this.resourceBaseUrl = (opts.resourceBaseUrl || 'https://r2.nightcord.de5.net').replace(/\/$/, '');
    this.useSekaiV2 = opts.useSekaiV2 !== false;
    this.timeout = opts.timeout || 280000;
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
  upload(file, filename, onProgress, extra = {}) {
    if (!file || !(file instanceof Blob)) {
      return Promise.reject(new Error('Invalid file object'));
    }

    const name = filename || file.name || 'file';

    if (this.useSekaiV2) {
      return this._uploadV2(file, name, onProgress, extra).catch((err) => {
        // Worker 尚未部署 /v2 时回退 legacy，避免整站上传瘫痪
        console.warn('SEKAI v2 upload failed, falling back to legacy:', err && err.message);
        return this._uploadLegacy(file, name, onProgress);
      });
    }
    return this._uploadLegacy(file, name, onProgress);
  }

  /**
   * SEKAI v2 upload → PUT /v2/upload
   * @private
   */
  _uploadV2(file, name, onProgress, extra) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      if (onProgress && typeof onProgress === 'function') {
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            onProgress(Math.round((e.loaded / e.total) * 100));
          }
        });
      }

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const result = JSON.parse(xhr.responseText);
            // Normalize for callers that still expect .key
            if (result.uuid && !result.key) result.key = result.uuid;
            // size in v2 response is kB; keep size_bytes if present
            resolve(result);
          } catch (e) {
            reject(new Error('Invalid server response'));
          }
        } else {
          try {
            const error = JSON.parse(xhr.responseText);
            reject(new Error(error.error || `Upload failed: ${xhr.status}`));
          } catch {
            reject(new Error(`Upload failed: ${xhr.status}`));
          }
        }
      });

      xhr.addEventListener('error', () => reject(new Error('Network error')));
      xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));
      xhr.timeout = this.timeout;
      xhr.addEventListener('timeout', () => reject(new Error('Upload timeout')));

      xhr.open('PUT', `${this.baseUrl}/v2/upload`);
      xhr.setRequestHeader('X-Filename', encodeURIComponent(name));
      if (file.type) xhr.setRequestHeader('Content-Type', file.type);

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
  _uploadLegacy(file, name, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      if (onProgress && typeof onProgress === 'function') {
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            onProgress(Math.round((e.loaded / e.total) * 100));
          }
        });
      }

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (e) {
            reject(new Error('Invalid server response'));
          }
        } else {
          try {
            const error = JSON.parse(xhr.responseText);
            reject(new Error(error.error || `Upload failed: ${xhr.status}`));
          } catch {
            reject(new Error(`Upload failed: ${xhr.status}`));
          }
        }
      });

      xhr.addEventListener('error', () => reject(new Error('Network error')));
      xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));
      xhr.timeout = this.timeout;
      xhr.addEventListener('timeout', () => reject(new Error('Upload timeout')));

      xhr.open('PUT', this.baseUrl);
      xhr.setRequestHeader('X-Filename', encodeURIComponent(name));
      if (file.type) xhr.setRequestHeader('Content-Type', file.type);
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
