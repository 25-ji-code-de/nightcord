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
 * SEKAI Renderer - Structured Extensible Keyword for Advanced Interactions
 *
 * 负责解析和渲染 SEKAI 富文本语法，包括：
 * - 基础富媒体：[img:URL]、[file:ID|Name|Size]、[audio:ID|Duration]、[stamp:ID]
 * - 文本格式化：**粗体**、*斜体*、~~删除线~~、||黑幕||、`代码`、> 引用
 * - 高级交互：[re:timestamp]、[link:URL|Title]、[color:hex|text]
 *
 * 性能优化：
 * - 使用 DocumentFragment 批量渲染减少重排
 * - DOMPurify XSS 过滤保护
 * - 对象池复用减少 GC 压力
 * - 懒加载图片和音频
 *
 * @example
 * const renderer = new SekaiRenderer({
 *   stickerService: stickerService,
 *   aiPersonas: ['Nako', 'Asagi', 'Miku']
 * });
 *
 * const fragment = renderer.render('这是**粗体**和[img:https://example.com/photo.jpg]');
 */
class SekaiRenderer {
  constructor(options = {}) {
    this.stickerService = options.stickerService;
    this.stickerDir = options.stickerDir || 'https://sticker.nightcord.de5.net/stickers';
    this.aiPersonas = options.aiPersonas || [];
    this.imageWidthThreshold = options.imageWidthThreshold || 400;

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
        ALLOWED_TAGS: ['strong', 'em', 'del', 'code', 'blockquote', 'br', 'a', 'span', 'div', 'svg', 'path', 'polyline', 'line', 'rect', 'circle', 'polygon', 'img', 'audio', 'button'],
        ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'style', 'title', 'onclick', 'src', 'alt', 'loading', 'width', 'height', 'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'd', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'transform', 'id', 'preload', 'download', 'data-local-nako-message'],
        ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
        KEEP_CONTENT: true,
        RETURN_DOM_FRAGMENT: false,
        RETURN_DOM: false,
        SAFE_FOR_TEMPLATES: true
      };
    }

    // Performance: Token cache for repeated content
    this.tokenCache = new Map();
    this.tokenCacheMaxSize = 100;

    // Performance: Object pooling for frequently created elements
    this.elementPool = {
      span: [],
      div: []
    };
    this.poolMaxSize = 20;
  }

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
   * Main render entry point
   * @param {string} text - Raw text input
   * @returns {DocumentFragment} Rendered DOM
   */
  render(text) {
    if (!text) return document.createDocumentFragment();

    // 1. Pre-process: Normalize syntax sugar
    text = this.normalizeSyntax(text);

    // 2. Tokenize: Split into text and SEKAI tokens
    const tokens = this.tokenize(text);

    // 3. Render Loop
    const fragment = document.createDocumentFragment();
    
    // Check if message is ONLY a single sticker (for specialized display)
    const isSingleSticker = tokens.length === 1 && 
                           tokens[0].type === 'sekai' && 
                           tokens[0].sekaiType === 'stamp';

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

  normalizeSyntax(text) {
    // [stamp0000] -> [stamp:0000]
    return text.replace(/\[stamp(\d+)\]/gi, '[stamp:$1]')
               .replace(/\[stamp_(\d+)\]/gi, '[stamp:$1]');
  }

  tokenize(text) {
    // Performance: Check cache first
    if (this.tokenCache.has(text)) {
      return this.tokenCache.get(text);
    }

    const tokens = [];
    const sekaiRegex = /\[(\w+):([^\]]+)\]/g;
    let lastIndex = 0;
    let match;

    while ((match = sekaiRegex.exec(text)) !== null) {
      // Push preceding text
      if (match.index > lastIndex) {
        tokens.push({
          type: 'text',
          content: text.slice(lastIndex, match.index)
        });
      }

      // Parse metadata: [type:data|meta1|meta2]
      const [mainData, ...metadata] = match[2].split('|');

      tokens.push({
        type: 'sekai',
        sekaiType: match[1].toLowerCase(),
        data: mainData,
        metadata,
        raw: match[0]
      });

      lastIndex = sekaiRegex.lastIndex;
    }

    // Push remaining text
    if (lastIndex < text.length) {
      tokens.push({
        type: 'text',
        content: text.slice(lastIndex)
      });
    }

    // Cache result (with size limit)
    if (this.tokenCache.size >= this.tokenCacheMaxSize) {
      // Remove oldest entry (first key)
      const firstKey = this.tokenCache.keys().next().value;
      this.tokenCache.delete(firstKey);
    }
    this.tokenCache.set(text, tokens);

    return tokens;
  }

  renderText(content) {
    // Apply basic markdown formatting here
    // We process this line by line to handle block elements if needed,
    // but for now we focus on inline formatting.

    // 1. Escape HTML (safety first) - Only if DOMPurify not available
    let html = this.useDOMPurify ? content : this.escapeHtml(content);

    // 2. Apply Markdown Rules (Order matters!)

    // Blockquote (> text)
    // Use a function to handle potential multiline or single line quotes more cleanly
    // For now, simple line replacement is robust enough
    const gtSymbol = this.useDOMPurify ? '>' : '&gt;';
    html = html.replace(new RegExp(`^${gtSymbol}\\s+(.*?)(?=\\n|$)`, 'gm'), '<blockquote>$1</blockquote>');

    // Remove newline after blockquote to prevent double spacing with <br>
    html = html.replace(/<\/blockquote>\n/g, '</blockquote>');

    // Code blocks (` code `) - handled first to avoid other parsing inside
    html = html.replace(/`([^`]+)`/g, '<code class="sekai-code-inline">$1</code>');

    // Bold (**text**)
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // Italic (*text*)
    html = html.replace(/\*([^\*]+)\*/g, '<em>$1</em>');

    // Strikethrough (~~text~~)
    html = html.replace(/~~(.*?)~~/g, '<del>$1</del>');

    // Spoiler (||text||)
    html = html.replace(/\|\|(.*?)\|\|/g, '<span class="sekai-spoiler" onclick="this.classList.toggle(\'revealed\')">$1</span>');

    // Links (Simple URL detection) - Before processing inline code to avoid linking inside code blocks
    // Use negative lookbehind/lookahead to avoid matching URLs already in href attributes
    const urlRegex = /(?<!href=["'])(?<!>)(https?:\/\/[^\s<]+)(?![^<]*<\/a>)/g;
    html = html.replace(urlRegex, (url) => {
        // Escape URL for safe insertion
        const escapedUrl = this.useDOMPurify ? url : url.replace(/"/g, '&quot;');
        return `<a href="${escapedUrl}" target="_blank" rel="noopener" class="sekai-link-inline">${url}</a>`;
    });

    // Newlines to <br>
    html = html.replace(/\n/g, '<br>');

    // Sanitize with DOMPurify if available
    if (this.useDOMPurify) {
      html = this._sanitizeHTML(html);
    }

    // Create wrapper (use object pool)
    const span = this._getElement('span');
    span.className = 'sekai-text-node';
    span.innerHTML = html;

    // Process legacy stickers [airi_name] etc.
    if (this.stickerService) {
         this.processStickerInHTML(span);
    }

    return span;
  }

  processStickerInHTML(element) {
    if (!this.stickerService) return;
    
    // Use TreeWalker to find text nodes deeply
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );

    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }

    textNodes.forEach(textNode => {
      const text = textNode.textContent;
      if (/\[[^\]]+\]/.test(text)) {
         // Create a temporary fragment to check render results
         const frag = this.stickerService.renderTextWithStickers(text);
         
         // If modification happened (fragment has elements or different text)
         if (frag.childNodes.length > 0) {
             textNode.replaceWith(frag);
         }
      }
    });
  }

  renderSekaiToken(token, options) {
    const { sekaiType, data, metadata } = token;

    switch (sekaiType) {
      case 'stamp': return this.renderStamp(data, options.isSingleSticker);
      case 'img': return this.renderImage(data, metadata[0]);
      case 'file': return this.renderFile(data, metadata[0], metadata[1]);
      case 'audio': return this.renderAudio(data, metadata[0]);
      case 'link': return this.renderLinkCard(data, metadata[0], metadata[1]);
      case 'color': return this.renderColor(data, metadata[0], false);
      case 'truecolor': return this.renderColor(data, metadata[0], true);
      case 're': return this.renderReply(data, metadata[0]);
      case 'code': return this.renderCodeBlock(data, metadata[0]);
      default: return document.createTextNode(token.raw);
    }
  }

  // --- Renderers ---

  renderStamp(id, isSingle) {
    if (!this.stickerService) return document.createTextNode(`[stamp:${id}]`);
    
    const stampName = `stamp${id}`;
    const cleanName = stampName.toLowerCase();
    const src = `${this.stickerDir}/${encodeURIComponent(cleanName)}.png`;
    
    const img = document.createElement('img');
    img.className = `sekai-sticker ${isSingle ? 'sekai-sticker-single' : 'sekai-sticker-inline'}`;
    img.src = src;
    img.alt = `[${stampName}]`;
    // Add title for hover effect
    img.title = stampName; 
    img.loading = 'lazy';
    
    img.onerror = () => {
        const replacement = document.createElement('span');
        replacement.className = 'sticker-broken';
        replacement.textContent = `[${stampName}]`;
        img.replaceWith(replacement);
    }

    return img;
  }

  renderImage(url, alt) {
    const container = document.createElement('div');
    container.className = 'sekai-image-container';

    // Loading State
    container.classList.add('loading');

    const img = document.createElement('img');
    img.className = 'sekai-image-content';
    img.src = url;
    img.alt = alt || 'Image';
    img.loading = 'lazy';

    img.onload = () => {
      container.classList.remove('loading');

      // 根据图片实际宽度调整容器大小类
      if (img.naturalWidth > this.imageWidthThreshold) {
        container.classList.add('sekai-image-large');
      } else {
        container.classList.add('sekai-image-small');
      }
    };

    img.onerror = () => {
        container.innerHTML = `<div class="sekai-error-placeholder">
            <span class="sekai-error-icon">⚠️</span>
            <span class="sekai-error-text">Failed to load image</span>
        </div>`;
        container.classList.remove('loading');
    };

    // Open in full-screen image viewer
    img.onclick = () => {
      if (window.sekaiImageViewer) {
        window.sekaiImageViewer.open(url, alt || '');
      } else {
        // Fallback if viewer not loaded
        window.open(url, '_blank');
      }
    };

    container.appendChild(img);
    if (alt) {
        const caption = document.createElement('div');
        caption.className = 'sekai-image-caption';
        caption.textContent = alt;
        container.appendChild(caption);
    }

    return container;
  }

  renderFile(url, name = 'File', size) {
    const card = document.createElement('div');
    card.className = 'sekai-file-card';

    // Escape user inputs to prevent XSS
    const escapedUrl = this.useDOMPurify ? url : this.escapeHtml(url);
    const escapedName = this.useDOMPurify ? name : this.escapeHtml(name);
    const escapedSize = this.useDOMPurify ? (size || '') : this.escapeHtml(size || '');

    card.onclick = (e) => {
        if (!e.target.closest('.sekai-file-action')) {
            window.open(url, '_blank');
        }
    };

    const ext = name.split('.').pop().toLowerCase();
    const icon = this.getFileIcon(ext);

    const fileHTML = `
      <div class="sekai-file-icon">${icon}</div>
      <div class="sekai-file-details">
        <div class="sekai-file-name" title="${escapedName}">${escapedName}</div>
        <div class="sekai-file-meta">${escapedSize || ext.toUpperCase()}</div>
      </div>
      <a href="${escapedUrl}" download="${escapedName}" class="sekai-file-action" title="Download">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
      </a>
    `;

    card.innerHTML = this.useDOMPurify ? this._sanitizeHTML(fileHTML) : fileHTML;

    return card;
  }

  renderAudio(url, duration) {
    const container = document.createElement('div');
    const playerId = 'audio_' + Math.random().toString(36).substr(2, 9);
    container.className = 'sekai-audio-player';
    
    const audio = document.createElement('audio');
    audio.src = url;
    audio.preload = 'metadata';
    audio.id = playerId;

    // Define icons constants for reuse and consistency - Redesigned by Top Tier UI/UX
    const ICONS = {
      PLAY: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true">
        <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none"></polygon>
      </svg>`,
      PAUSE: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true">
        <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"></rect>
        <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"></rect>
      </svg>`
    };

    const playBtn = document.createElement('button');
    playBtn.className = 'sekai-audio-control';
    playBtn.innerHTML = ICONS.PLAY;
    playBtn.setAttribute('aria-label', 'Play');
    
    const wave = document.createElement('div');
    wave.className = 'sekai-audio-wave';
    let barsHtml = '';
    for(let i=0; i<30; i++) { // Increased bar count for smoother look
        const h = 20 + Math.random() * 60;
        barsHtml += `<div class="bar" style="height:${h}%; animation-delay:${i*0.05}s"></div>`;
    }
    wave.innerHTML = barsHtml;

    const timeDisplay = document.createElement('div');
    timeDisplay.className = 'sekai-audio-time';
    timeDisplay.textContent = duration || '0:00';

    const updatePlayState = (isPlaying) => {
        if (isPlaying) {
            playBtn.innerHTML = ICONS.PAUSE;
            playBtn.setAttribute('aria-label', 'Pause');
            container.classList.add('playing');
        } else {
            playBtn.innerHTML = ICONS.PLAY;
            playBtn.setAttribute('aria-label', 'Play');
            container.classList.remove('playing');
        }
    };

    playBtn.onclick = () => {
        if (audio.paused) {
            audio.play();
            updatePlayState(true);
        } else {
            audio.pause();
            updatePlayState(false);
        }
    };

    audio.ontimeupdate = () => {
       if (!duration) {
             const mins = Math.floor(audio.currentTime / 60);
             const secs = Math.floor(audio.currentTime % 60).toString().padStart(2, '0');
             timeDisplay.textContent = `${mins}:${secs}`;
       }
    };

    audio.onended = () => {
        updatePlayState(false);
    };

    container.appendChild(audio);
    container.appendChild(playBtn);
    container.appendChild(wave);
    container.appendChild(timeDisplay);

    return container;
  }

  renderLinkCard(url, title, desc) {
    const card = document.createElement('a');
    card.className = 'sekai-link-card';
    card.href = url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';

    let domain = '';
    try { domain = new URL(url).hostname; } catch(e) {}

    // Escape all user-provided content
    const escapedDomain = this.useDOMPurify ? domain : this.escapeHtml(domain);
    const escapedTitle = this.useDOMPurify ? (title || url) : this.escapeHtml(title || url);
    const escapedUrl = this.useDOMPurify ? url : this.escapeHtml(url);
    const escapedDesc = this.useDOMPurify ? (desc || '') : this.escapeHtml(desc || '');

    const linkHTML = `
      <div class="sekai-link-accent"></div>
      <div class="sekai-link-content">
        <div class="sekai-link-site">${escapedDomain}</div>
        <div class="sekai-link-title">${escapedTitle}</div>
        <div class="sekai-link-url">${escapedUrl}</div>
        ${desc ? `<div class="sekai-link-desc">${escapedDesc}</div>` : ''}
      </div>
      <div class="sekai-link-arrow">↗</div>
    `;

    card.innerHTML = this.useDOMPurify ? this._sanitizeHTML(linkHTML) : linkHTML;

    return card;
  }

  renderReply(timestamp, preview) {
    const chip = document.createElement('div');
    chip.className = 'sekai-reply-chip';
    chip.title = `点击跳转到 #${timestamp}`;

    // Escape user content
    const escapedPreview = this.useDOMPurify ? (preview || '回复') : this.escapeHtml(preview || '回复');

    const replyHTML = `
      <div class="sekai-reply-accent">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
              <path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" stroke="none"></path>
          </svg>
      </div>
      <div class="sekai-reply-content">${escapedPreview}</div>
    `;

    chip.innerHTML = this.useDOMPurify ? this._sanitizeHTML(replyHTML) : replyHTML;

    chip.onclick = () => {
        // Convert string timestamp to number for messageIndex lookup
        const event = new CustomEvent('reply-jump', { detail: { timestamp: Number(timestamp) } });
        document.dispatchEvent(event);
    };

    return chip;
  }

  /**
   * Render colored text with optional luminance adjustment
   * @param {string} hex - Hex color code (with or without #)
   * @param {string} text - Text content to display
   * @param {boolean} preserveOriginal - If true, skip luminance adjustment (truecolor mode)
   * @returns {HTMLSpanElement} Styled span element
   */
  renderColor(hex, text, preserveOriginal = false) {
    const span = document.createElement('span');
    span.className = 'sekai-colored-text';

    // Normalize hex format
    let normalizedHex = hex.startsWith('#') ? hex : '#' + hex;

    /**
     * Ensure minimum luminance for readability on dark backgrounds
     * @param {string} h - Hex color (e.g., "#RRGGBB")
     * @returns {string} Adjusted hex color
     */
    const ensureLuminance = (h) => {
      let c = h.substring(1);

      // Expand shorthand hex (#ABC → #AABBCC)
      if (c.length === 3) {
        c = c.split('').map(x => x + x).join('');
      }

      // Validate length
      if (c.length !== 6) return '#fff';

      // Parse RGB components (0-1 range)
      const r = parseInt(c.substr(0, 2), 16) / 255;
      const g = parseInt(c.substr(2, 2), 16) / 255;
      const b = parseInt(c.substr(4, 2), 16) / 255;

      // Calculate relative luminance using WCAG formula
      // https://www.w3.org/WAI/GL/wiki/Relative_luminance
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

      // Threshold: 0.45 ensures good contrast against dark backgrounds
      // (Nightcord background ~0.05, so we need significant difference)
      if (luminance < 0.45) {
        // Lighten by mixing with white (60% white contribution)
        // Formula: new_val = original + (1 - original) * 0.6
        // This preserves hue while increasing lightness
        const lighten = (val) =>
          Math.round((val + (1 - val) * 0.6) * 255)
            .toString(16)
            .padStart(2, '0');

        return '#' + lighten(r) + lighten(g) + lighten(b);
      }

      return h;
    };

    // Validate and optionally adjust color
    const validHex = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(normalizedHex)
      ? (preserveOriginal ? normalizedHex : ensureLuminance(normalizedHex))
      : '#fff';

    span.style.color = validHex;
    
    // Stronger glow for emphasis and better visibility
    span.style.textShadow = `0 0 5px ${validHex}66`;

    if (preserveOriginal) {
      span.classList.add('sekai-truecolor');
      span.style.fontWeight = '600';
      span.title = `TrueColor: ${normalizedHex}`;
    }
    span.textContent = text || hex;

    return span;
  }
  
  renderCodeBlock(lang, content) {
      const code = document.createElement('code');
      code.className = 'sekai-code-block';
      code.textContent = content || lang; // simplified
      return code;
  }

  escapeHtml(str) {
      if(!str) return '';
      return str.replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
  }

  getFileIcon(ext) {
    // Redesigned by Top Tier UI/UX: Custom designed icons for better recognition
    
    // Audio Icon: A music note with sound waves
    const audioIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="24" height="24">
        <path d="M9 18V5l12-2v13"></path>
        <circle cx="6" cy="18" r="3"></circle>
        <circle cx="18" cy="16" r="3"></circle>
    </svg>`;

    // Image Icon: Picture frame with mountain and sun
    const imageIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="24" height="24">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
        <circle cx="8.5" cy="8.5" r="1.5"></circle>
        <polyline points="21 15 16 10 5 21"></polyline>
    </svg>`;
    
    // Generic File Icon: Paper with folded corner
    const defaultIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="24" height="24">
        <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
        <polyline points="13 2 13 9 20 9"></polyline>
    </svg>`;
    
    // Code/Data Icon: Brackets
    const codeIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="24" height="24">
        <polyline points="16 18 22 12 16 6"></polyline>
        <polyline points="8 6 2 12 8 18"></polyline>
    </svg>`;
    
    // Archive Icon: Box/Zip
    const archiveIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="24" height="24">
        <polyline points="21 8 21 21 3 21 3 8"></polyline>
        <rect x="1" y="3" width="22" height="5"></rect>
        <line x1="10" y1="12" x2="14" y2="12"></line>
    </svg>`;

    if (['mp3','wav','ogg','flac','m4a','aac'].includes(ext)) return audioIcon;
    if (['jpg','jpeg','png','gif','webp','bmp','svg'].includes(ext)) return imageIcon;
    if (['json','js','html','css','py','cpp','c','java','ts','txt','md'].includes(ext)) return codeIcon;
    if (['zip','rar','7z','tar','gz'].includes(ext)) return archiveIcon;

    return defaultIcon;
  }

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

window.SekaiRenderer = SekaiRenderer;
