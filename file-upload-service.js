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
 * 与部署在 storage.nightcord.de5.net 的 OSS 代理交互
 * 支持文件上传、下载和删除
 */
class FileUploadService {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.baseUrl] OSS 代理服务地址
   * @param {number} [opts.timeout] 上传超时时间（毫秒）
   */
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl || 'https://storage.nightcord.de5.net';
    this.timeout = opts.timeout || 280000;
  }

  /**
   * 上传文件
   * @param {File|Blob} file 要上传的文件对象
   * @param {string} [filename] 自定义文件名（可选，默认使用 file.name）
   * @param {Function} [onProgress] 上传进度回调 (percent) => void
   * @returns {Promise<{key: string, url: string, size: number}>} 上传结果
   */
  upload(file, filename, onProgress) {
    if (!file || !(file instanceof Blob)) {
      return Promise.reject(new Error('Invalid file object'));
    }

    const name = filename || file.name || 'file';

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      if (onProgress && typeof onProgress === 'function') {
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            onProgress(percent);
          }
        });
      }

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const result = JSON.parse(xhr.responseText);
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

      xhr.open('PUT', this.baseUrl);
      // 编码文件名以支持 Unicode 字符（中文等）
      xhr.setRequestHeader('X-Filename', encodeURIComponent(name));
      if (file.type) xhr.setRequestHeader('Content-Type', file.type);

      xhr.send(file);
    });
  }

  /**
   * 获取文件的完整 URL
   * @param {string} key 文件的 key（从上传结果中获取）
   * @returns {string} 文件的完整 URL
   */
  getFileUrl(key) {
    const cleanKey = key.startsWith('/') ? key.slice(1) : key;
    return `${this.baseUrl}/${cleanKey}`;
  }

  /**
   * 检查文件是否存在
   * @param {string} key 文件的 key
   * @returns {Promise<boolean>} 文件是否存在
   */
  exists(key) {
    const url = this.getFileUrl(key);
    return fetch(url, { method: 'HEAD' })
      .then(res => res.ok)
      .catch(() => false);
  }

  /**
   * 删除文件
   * @param {string} key 文件的 key
   * @returns {Promise<{ok: boolean}>} 删除结果
   */
  delete(key) {
    const cleanKey = key.startsWith('/') ? key.slice(1) : key;
    const url = `${this.baseUrl}/${cleanKey}`;

    return fetch(url, { method: 'DELETE' })
      .then(res => {
        if (!res.ok) {
          return res.json()
            .catch(() => ({}))
            .then(error => {
              throw new Error(error.error || `Delete failed: ${res.status}`);
            });
        }
        return res.json();
      });
  }

  /**
   * 下载文件（触发浏览器下载）
   * @param {string} key 文件的 key
   * @param {string} [saveAs] 保存的文件名（可选）
   */
  download(key, saveAs) {
    const url = this.getFileUrl(key);
    const a = document.createElement('a');
    a.href = url;
    if (saveAs) a.download = saveAs;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /**
   * 获取文件的 Blob 对象
   * @param {string} key 文件的 key
   * @returns {Promise<Blob>} 文件的 Blob 对象
   */
  getBlob(key) {
    const url = this.getFileUrl(key);
    return fetch(url)
      .then(res => {
        if (!res.ok) throw new Error(`Failed to fetch file: ${res.status}`);
        return res.blob();
      });
  }

  /**
   * 验证文件大小
   * @param {File|Blob} file 文件对象
   * @param {number} maxSize 最大大小（字节）
   * @returns {boolean} 是否在限制内
   */
  static validateSize(file, maxSize) {
    return file.size <= maxSize;
  }

  /**
   * 验证文件类型
   * @param {File|Blob} file 文件对象
   * @param {string[]} allowedTypes 允许的 MIME 类型列表
   * @returns {boolean} 是否允许
   */
  static validateType(file, allowedTypes) {
    if (!file.type) return false;
    return allowedTypes.some(type => {
      if (type.endsWith('/*')) {
        const prefix = type.slice(0, -2);
        return file.type.startsWith(prefix);
      }
      return file.type === type;
    });
  }

  /**
   * 格式化文件大小
   * @param {number} bytes 字节数
   * @returns {string} 格式化后的大小字符串
   */
  static formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  }
}

window.FileUploadService = FileUploadService;
