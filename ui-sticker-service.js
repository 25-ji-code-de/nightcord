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
 * StickerService - 贴纸数据与渲染模块
 * 负责：
 * 1) 拉取贴纸自动补全数据
 * 2) 将文本渲染为包含贴纸的 DOM 片段
 */
(function (global) {
  class StickerService {
    constructor({ stickerDir, widthThreshold, fetcher } = {}) {
      this.stickerDir = stickerDir || 'https://sticker.nightcord.de5.net/stickers';
      this.widthThreshold = Number.isFinite(widthThreshold) ? widthThreshold : 180;
      this.fetcher = fetcher || fetch.bind(window);
      this.stickers = [];
    }

    loadAutocompleteData(url) {
      const targetUrl = url || 'https://sticker.nightcord.de5.net/autocomplete.json';
      return this.fetcher(targetUrl)
        .then(res => res.json())
        .then(data => {
          const stickers = [];
          for (const [category, items] of Object.entries(data)) {
            for (const [label, pinyin] of Object.entries(items)) {
              stickers.push({
                label,
                pinyin,
                category,
                // Search in both label and filename (pinyin)
                searchKey: (label + pinyin).toLowerCase(),
                code: `${category}_${String(label)}`,
                url: `${this.stickerDir}/${category}/${encodeURIComponent(String(label))}.png`
              });
            }
          }
          this.stickers = stickers;
          return stickers;
        })
        .catch(e => {
          console.error('Failed to load sticker autocomplete data', e);
          this.stickers = [];
          return [];
        });
    }

    getStickers() {
      return this.stickers || [];
    }

    /**
     * 将消息文本中的 [name] 替换为 sticker 图片（如果存在）。
     * 保持其余文本做 HTML 转义并保留换行。
     * @param {string} text
     * @returns {DocumentFragment} 安全的 DOM 片段
     */
    renderTextWithStickers(text) {
      const frag = document.createDocumentFragment();
      if (!text) return frag;

      // 只有消息完全等于一个 sticker（前后可有空白）时才视为 fixed
      const isSingleSticker = /^\s*\[[^\]]+\]\s*$/.test(text);
      const re = /\[([^\]]+)\]/g; // 匹配 [内容]
      let lastIndex = 0;

      const appendTextWithLineBreaks = (str) => {
        if (!str) return;
        const parts = str.split('\n');
        parts.forEach((p, i) => {
          if (p.length > 0) frag.appendChild(document.createTextNode(p));
          if (i < parts.length - 1) frag.appendChild(document.createElement('br'));
        });
      };

      let m;
      while ((m = re.exec(text)) !== null) {
        const idx = m.index;
        const matched = m[0];
        const name = m[1];

        if (idx > lastIndex) {
          appendTextWithLineBreaks(text.slice(lastIndex, idx));
        }

        // 解析Sticker路径：兼容 [category_filename] 格式
        const key = String(name);
        let src;

        const underscoreIndex = name.indexOf('_');
        if (underscoreIndex !== -1) {
          const category = name.substring(0, underscoreIndex).toLowerCase();
          const filenameFragment = name.substring(underscoreIndex + 1);
          src = `${this.stickerDir}/${category}/${encodeURIComponent(filenameFragment)}.png`;
        } else {
          src = `${this.stickerDir}/${encodeURIComponent(name.toLowerCase())}.png`;
        }

        const img = document.createElement('img');
        img.classList.add('sticker', 'sticker-loading');
        if (isSingleSticker) img.classList.add('sticker-fixed'); else img.classList.add('sticker-inline');
        img.src = src;
        img.alt = `[${name}]`;
        img.title = name;
        img.loading = 'lazy';

        const onLoad = () => {
          img.classList.remove('sticker-loading');
          try {
            if (img.width > this.widthThreshold) {
              img.classList.remove('sticker-fixed');
              img.classList.add('sticker-narrow');
            }
          } catch (e) {
            console.warn('StickerService: failed to adjust sticker width', e);
          }
          img.removeEventListener('load', onLoad);
        };
        img.addEventListener('load', onLoad, { once: true });

        const onError = () => {
          const replacement = document.createElement('span');
          replacement.className = 'sticker-broken';
          replacement.textContent = img.alt || '';
          try { img.replaceWith(replacement); } catch (e) {
            console.warn('StickerService: failed to replace broken sticker image', e);
            img.style.display = 'none';
          }
          try { img.src = ''; } catch (e) {}
          img.removeEventListener('error', onError);
        };
        img.addEventListener('error', onError, { once: true });

        frag.appendChild(img);
        lastIndex = idx + matched.length;
      }

      if (lastIndex < text.length) {
        appendTextWithLineBreaks(text.slice(lastIndex));
      }

      return frag;
    }
  }

  global.StickerService = StickerService;
})(window);
