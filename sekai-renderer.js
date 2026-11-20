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
 * SEKAI Renderer - Structured Extensible Keywords for Advanced Interactions
 *
 * 负责解析和渲染 SEKAI 富文本语法：
 * - v2: <$SEKAI:Type:Key=Value:Payload> / multi-line with <&SEKAI>
 * - v1 (legacy): [img:URL]、[file:URL|Name|Size]、[audio:]、[music:]、[stamp:]、[sticker:]、
 *                [re:]、[link:]、[color:]、[truecolor:]、[code:]
 * - Markdown on residual text segments only (after SEKAI tokenization)
 *
 * 性能优化：
 * - DocumentFragment 批量渲染
 * - DOMPurify XSS 过滤
 * - 对象池复用 / token 缓存
 * - 懒加载图片和音频
 */

/**
 * @example
 * const renderer = new SekaiRenderer({
 *   stickerService: stickerService,
 *   aiPersonas: ['Nako', 'Asagi', 'Miku'],
 *   resourceBaseUrl: 'https://r2.nightcord.de5.net',
 *   lookupReply: (ts) => ({ name, preview })
 * });
 *
 * const fragment = renderer.render('这是**粗体**和<$SEKAI:Stamp::stamp0001>');
 */

/**
 * SEKAI v2 的 Type 形状，规范 §3.3：`ALPHA *(ALPHA / DIGIT / "-")`。
 *
 * **这是唯一来源。** ui-manager 的 markdown 保护与 getPlainText
 * 也从这里取（`SekaiRenderer.V2_TYPE_SOURCE`）。
 *
 * 此前那两处各写各的正则 `<\$SEKAI:[^>\n]*>` —— 不校验 Type，
 * 于是同一段文本在两条路径上被判成不同的东西：
 *
 *   <$SEKAI:123:x>    渲染器：Type 不以字母开头 → 畸形 → 按 §10.1 当纯文本显示
 *                     ui-manager：形状对上了 → 当作 token → 复制/引用时整段删掉
 *
 * 结果就是**屏幕上看得见，复制不出来**。见 issue #2。
 */
class SekaiRenderer {
  get parser() { return this._parser ||= new SekaiParser(this); }
  get resources() { return this._resources ||= new SekaiResources(this); }
  get textRenderer() { return this._textRenderer ||= new SekaiTextRenderer(this); }
  get imageRenderer() { return this._imageRenderer ||= new SekaiImageRenderer(this); }
  get cardRenderer() { return this._cardRenderer ||= new SekaiCardRenderer(this); }
  get audioControls() { return this._audioControls ||= new SekaiAudioControls(this); }
  get musicRenderer() { return this._musicRenderer ||= new SekaiMusicRenderer(this); }
  get audioRenderer() { return this._audioRenderer ||= new SekaiAudioRenderer(this); }

  constructor(options = {}) {
    this.stickerService = options.stickerService;
    this.emojiService = options.emojiService;
    this.stickerDir = options.stickerDir || 'https://sticker.nightcord.de5.net/stickers';
    this.aiPersonas = options.aiPersonas || [];
    this.imageWidthThreshold = options.imageWidthThreshold || 400;

    // Tier-1 resource resolution
    // - Full URL → as-is
    // - Pure UUID → {resourceBaseUrl}/{images|files|stickers}/{uuid}
    // - Legacy key (uid/file.ext) → {storageBaseUrl}/{key}; default host is r2, not storage
    this.resourceBaseUrl = (options.resourceBaseUrl || options.storageBaseUrl || 'https://r2.nightcord.de5.net').replace(/\/$/, '');
    this.storageBaseUrl = (options.storageBaseUrl || this.resourceBaseUrl).replace(/\/$/, '');
    // Optional: (timestamp) => { name?: string, preview?: string } | null
    this.lookupReply = typeof options.lookupReply === 'function' ? options.lookupReply : null;
    this.bindMention = typeof options.bindMention === 'function' ? options.bindMention : null;

    // Spec §8.4 caps
    this.maxTokensPerMessage = options.maxTokensPerMessage || 50;
    this.maxPayloadBytes = options.maxPayloadBytes || 64 * 1024;

    // 全局共享的 AudioContext（避免资源泄漏）
    this.audioContext = null;

    // Theme Configuration
    this.theme = {
      imageMaxWidth: 360,
      borderRadius: '6px',
      accentColor: '#7c6fac'
    };

    // DOMPurify Configuration
    this.useDOMPurify = typeof DOMPurify !== 'undefined';
    if (this.useDOMPurify) {
      this.purifyConfig = {
        ALLOWED_TAGS: ['strong', 'em', 'del', 'code', 'blockquote', 'br', 'a', 'span', 'div', 'svg', 'path', 'polyline', 'line', 'rect', 'circle', 'polygon', 'img', 'audio', 'button', 'pre'],
        ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'style', 'title', 'src', 'alt', 'loading', 'width', 'height', 'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'd', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'transform', 'id', 'preload', 'download', 'data-local-nako-message', 'tabindex', 'role', 'aria-label', 'aria-hidden', 'focusable'],
        ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
        KEEP_CONTENT: true,
        RETURN_DOM_FRAGMENT: false,
        RETURN_DOM: false,
        SAFE_FOR_TEMPLATES: true
      };
    }

    // Performance: Token cache for repeated content
    this.tokenCache = this.parser.tokenCache;
    this.tokenCacheMaxSize = 100;

    // Performance: Object pooling for frequently created elements
    this.elementPool = {
      span: [],
      div: []
    };
    this.poolMaxSize = 20;
  }

  _getAudioContext(...args) { return this.audioControls._getAudioContext(...args); }

  /**
   * Get element from pool or create new one
   * @private
   */
  _getElement(tagName) {
    const pool = this.elementPool[tagName];
    if (pool && pool.length > 0) {
      const elem = pool.pop();
      // Clear previous attributes and content
      elem.className = '';
      elem.innerHTML = '';
      elem.removeAttribute('style');
      elem.removeAttribute('title');
      elem.removeAttribute('onclick');
      return elem;
    }
    return document.createElement(tagName);
  }

  /**
   * Return element to pool
   * @private
   */
  _returnElement(elem) {
    const tagName = elem.tagName.toLowerCase();
    const pool = this.elementPool[tagName];
    if (pool && pool.length < this.poolMaxSize) {
      pool.push(elem);
    }
  }

  _getAudioIcons(...args) { return this.audioControls._getAudioIcons(...args); }

  _createAudioElement(...args) { return this.audioControls._createAudioElement(...args); }

  _formatTime(...args) { return this.audioControls._formatTime(...args); }

  _bindAudioSlider(...args) { return this.audioControls._bindAudioSlider(...args); }

  _setupAudioAnalysis(...args) { return this.audioControls._setupAudioAnalysis(...args); }

  _createVisualizerBars(...args) { return this.audioControls._createVisualizerBars(...args); }

  _createOscilloscope(...args) { return this.audioControls._createOscilloscope(...args); }

  _resetOscilloscope(...args) { return this.audioControls._resetOscilloscope(...args); }

  _updateVisualizerBars(...args) { return this.audioControls._updateVisualizerBars(...args); }

  /**
   * Sanitize HTML using DOMPurify
   * @private
   */
  _sanitizeHTML(html) {
    if (!this.useDOMPurify) {
      return html; // Fallback to existing escapeHtml in renderText
    }
    return DOMPurify.sanitize(html, this.purifyConfig);
  }

  /**
   * Escape HTML special characters
   * @private
   */
  _escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Main render entry point
   * @param {string} text - Raw text input
   * @returns {DocumentFragment} Rendered DOM
   */
  render(text) {
    if (!text) return document.createDocumentFragment();

    // 1. Pre-process: Normalize v1 stamp syntax sugar
    text = this.normalizeSyntax(text);

    // 2. Dual tokenize: v2 first, then v1 on residual text (spec §6.1 / §7.2)
    const tokens = this.tokenize(text);

    // 3. Render Loop
    const fragment = document.createDocumentFragment();

    // Single-sticker large display mode (Stamp / custom sticker only)
    const isSingleSticker = tokens.length === 1 &&
                           tokens[0].type === 'sekai' &&
                           (tokens[0].sekaiType === 'stamp' || tokens[0].sekaiType === 'sticker');

    tokens.forEach(token => {
      let node;
      if (token.type === 'text') {
        node = this.renderText(token.content);
      } else if (token.type === 'sekai') {
        node = this.renderSekaiToken(token, { isSingleSticker });
      }

      if (node) fragment.appendChild(node);
    });

    return fragment;
  }

  normalizeSyntax(...args) { return this.parser.normalizeSyntax(...args); }

  tokenize(...args) { return this.parser.tokenize(...args); }

  tokenizeDual(...args) { return this.parser.tokenizeDual(...args); }

  tokenizeV2(...args) { return this.parser.tokenizeV2(...args); }

  _parseV2TokenAt(...args) { return this.parser._parseV2TokenAt(...args); }

  parseDescriptions(...args) { return this.parser.parseDescriptions(...args); }

  percentDecode(...args) { return this.resources.percentDecode(...args); }

  percentEncode(...args) { return this.resources.percentEncode(...args); }

  decodePayload(...args) { return this.resources.decodePayload(...args); }

  base64DecodeUtf8(...args) { return this.resources.base64DecodeUtf8(...args); }

  base64EncodeUtf8(...args) { return this.resources.base64EncodeUtf8(...args); }

  resolveResource(...args) { return this.resources.resolveResource(...args); }

  _descBool(...args) { return this.resources._descBool(...args); }

  tokenizeV1(...args) { return this.parser.tokenizeV1(...args); }

  renderText(...args) { return this.textRenderer.renderText(...args); }

  _bindSpoilers(...args) { return this.textRenderer._bindSpoilers(...args); }

  processStickerInHTML(...args) { return this.textRenderer.processStickerInHTML(...args); }

  renderSekaiToken(token, options) {
    if (token.version === 2) {
      return this.renderSekaiTokenV2(token, options);
    }
    return this.renderSekaiTokenV1(token, options);
  }

  /**
   * v1 type dispatch (legacy wire format).
   * @private
   */
  renderSekaiTokenV1(token, options) {
    const { sekaiType, data, metadata } = token;

    switch (sekaiType) {
      case 'stamp': return this.renderStamp(data, options.isSingleSticker);
      case 'sticker': return this.renderSticker(this.resolveResource(data, 'sticker'), options.isSingleSticker);
      case 'img': return this.renderImage(this.resolveResource(data, 'image'), metadata[0]);
      case 'file': return this.renderFile(this.resolveResource(data, 'file'), metadata[0], metadata[1]);
      case 'audio': return this.renderAudio(this.resolveResource(data, 'file'), metadata[0]);
      case 'music': return this.renderMusic(this.resolveResource(data, 'file'), metadata[0], metadata[1], metadata[2]);
      case 'link': return this.renderLinkCard(data, metadata[0], metadata[1]);
      case 'color': return this.renderColor(data, metadata[0], false);
      case 'truecolor': return this.renderColor(data, metadata[0], true);
      case 're': return this.renderReply(data, metadata[0]);
      case 'code': return this.renderCodeBlock(data, metadata[0]);
      default: return document.createTextNode(token.raw);
    }
  }

  /**
   * v2 type dispatch (spec §4).
   * @private
   */
  renderSekaiTokenV2(token, options) {
    const type = token.sekaiType;
    const desc = token.desc || {};
    const payload = token.payload != null ? token.payload : token.data;

    switch (type) {
      case 'format':
        return this.renderFormat(desc, payload);
      case 'image':
        return this.renderImageV2(desc, payload);
      case 'stamp':
        return this.renderStampV2(desc, payload, options.isSingleSticker);
      case 'files':
        return this.renderFilesV2(desc, payload);
      case 'reply':
        return this.renderReplyV2(payload);
      case 'embed':
        return this.renderEmbedV2(desc, payload);
      case 'mention':
        return this.renderMention(desc, payload);
      case 'code':
        return this.renderCodeV2(desc, payload);
      case 'signal':
        // Reserved — do not implement; show raw for forward-compat
        return document.createTextNode(token.raw);
      default:
        // Unknown / X-* vendor: render raw (spec §10.2)
        return document.createTextNode(token.raw);
    }
  }

  // --- v2 adapters ---

  renderFormat(...args) { return this.textRenderer.renderFormat(...args); }

  renderImageV2(...args) { return this.imageRenderer.renderImageV2(...args); }

  _applyImageBox(...args) { return this.imageRenderer._applyImageBox(...args); }

  renderStampV2(...args) { return this.imageRenderer.renderStampV2(...args); }

  renderFilesV2(...args) { return this.cardRenderer.renderFilesV2(...args); }

  renderReplyV2(...args) { return this.cardRenderer.renderReplyV2(...args); }

  renderEmbedV2(...args) { return this.cardRenderer.renderEmbedV2(...args); }

  renderMention(...args) { return this.textRenderer.renderMention(...args); }

  renderCodeV2(...args) { return this.textRenderer.renderCodeV2(...args); }

  // --- Renderers ---

  renderStamp(...args) { return this.imageRenderer.renderStamp(...args); }

  renderSticker(...args) { return this.imageRenderer.renderSticker(...args); }

  renderImage(...args) { return this.imageRenderer.renderImage(...args); }

  renderFile(...args) { return this.cardRenderer.renderFile(...args); }

  renderMusic(...args) { return this.musicRenderer.renderMusic(...args); }

  renderAudio(...args) { return this.audioRenderer.renderAudio(...args); }

  renderLinkCard(...args) { return this.cardRenderer.renderLinkCard(...args); }

  renderReply(...args) { return this.cardRenderer.renderReply(...args); }

  renderColor(...args) { return this.textRenderer.renderColor(...args); }
  
  renderCodeBlock(...args) { return this.textRenderer.renderCodeBlock(...args); }

  escapeHtml(str) {
      if(!str) return '';
      return str.replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
  }

  getFileIcon(...args) { return this.cardRenderer.getFileIcon(...args); }

  /**
   * Batch render multiple messages for improved performance
   * @param {Array<string>} texts - Array of text content to render
   * @returns {DocumentFragment} Fragment containing all rendered messages
   */
  renderBatch(texts) {
    const fragment = document.createDocumentFragment();

    // Use requestIdleCallback if available for non-blocking rendering
    if (typeof requestIdleCallback !== 'undefined' && texts.length > 50) {
      return this._renderBatchIdle(texts);
    }

    // Standard batch rendering for smaller sets
    texts.forEach(text => {
      const rendered = this.render(text);
      fragment.appendChild(rendered);
    });

    return fragment;
  }

  /**
   * Render batch using idle callbacks for large datasets
   * @private
   */
  _renderBatchIdle(texts) {
    return new Promise((resolve) => {
      const fragment = document.createDocumentFragment();
      let index = 0;
      const batchSize = 10;

      const processBatch = (deadline) => {
        while (index < texts.length && deadline.timeRemaining() > 0) {
          const rendered = this.render(texts[index]);
          fragment.appendChild(rendered);
          index++;
        }

        if (index < texts.length) {
          requestIdleCallback(processBatch);
        } else {
          resolve(fragment);
        }
      };

      requestIdleCallback(processBatch);
    });
  }

  /**
   * Clear all caches (useful for memory management)
   */
  clearCaches() {
    this.tokenCache.clear();
    // Clear object pools
    this.elementPool.span = [];
    this.elementPool.div = [];
  }

  /**
   * Get cache statistics for debugging
   */
  getCacheStats() {
    return {
      tokenCacheSize: this.tokenCache.size,
      tokenCacheMaxSize: this.tokenCacheMaxSize,
      spanPoolSize: this.elementPool.span.length,
      divPoolSize: this.elementPool.div.length,
      useDOMPurify: this.useDOMPurify
    };
  }
}

/**
 * 对外暴露 Type 的形状，供 ui-manager 构造它自己的正则。
 *
 * 只暴露**源字符串**而不是编好的正则：调用方需要的 flag 各不相同
 * （`g` / `gm` / `gi`），共用一个带 `g` 的正则对象会因为 lastIndex
 * 互相干扰。
 */
SekaiRenderer.V2_TYPE_SOURCE = V2_TYPE_SOURCE;

window.SekaiRenderer = SekaiRenderer;
