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
 */

// Audio Visualizer Configuration
const AUDIO_VIZ_CONFIG = {
  OSCILLOSCOPE: {
    BG_COLOR_IDLE: '#2f273f',
    BG_COLOR_PLAYING: 'rgba(53, 46, 70, 0.25)',
    LINE_COLOR: 'rgba(167, 139, 250, 1)',
    LINE_WIDTH: 1.5,
    FFT_SIZE: 2048
  },
  INDICATOR: {
    ACCENT_COLOR: '#ff5500',
    RMS_SCALE: 1.5,
    BASE_OPACITY: 0.6,
    GLOW_BASE: 2,
    GLOW_SCALE: 15,
    MAX_SCALE: 1.5
  }
};

/**
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
   * 获取全局共享的 AudioContext
   * @private
   */
  _getAudioContext() {
    if (!this.audioContext) {
      try {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        console.warn('Web Audio API not supported:', e);
        return null;
      }
    }

    // 恢复被暂停的 AudioContext
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    return this.audioContext;
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
   * Common icons used in audio players
   * @private
   */
  _getAudioIcons(size = 16) {
    return {
      PLAY: `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><polygon points="6 4 20 12 6 20 6 4" fill="currentColor"></polygon></svg>`,
      PAUSE: `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"></rect><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"></rect></svg>`,
      STOP: `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor"></rect></svg>`,
      RW: `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><polygon points="11 19 2 12 11 5 11 19" fill="currentColor"></polygon><polygon points="22 19 13 12 22 5 22 19" fill="currentColor"></polygon></svg>`,
      FF: `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><polygon points="13 19 22 12 13 5 13 19" fill="currentColor"></polygon><polygon points="2 19 11 12 2 5 2 19" fill="currentColor"></polygon></svg>`
    };
  }

  /**
   * Create audio element with common configuration
   * @private
   */
  _createAudioElement(url) {
    const audio = document.createElement('audio');
    audio.src = url;
    audio.preload = 'metadata';
    audio.crossOrigin = 'anonymous';
    audio.id = 'audio_' + Math.random().toString(36).substr(2, 9);
    return audio;
  }

  /**
   * Format seconds to MM:SS
   * @private
   */
  _formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
  }

  /**
   * Setup audio analysis for visualization
   * @private
   */
  _setupAudioAnalysis(audio, fftSize = 128) {
    const ctx = this._getAudioContext();
    if (!ctx) return null;

    try {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = fftSize;
      analyser.smoothingTimeConstant = 0.8;

      const source = ctx.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(ctx.destination);

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      return { analyser, source, dataArray };
    } catch (e) {
      console.warn('Failed to setup audio analysis:', e);
      return null;
    }
  }

  /**
   * Create visualizer bars
   * @private
   */
  _createVisualizerBars(count, className = 'sekai-audio-visualizer-bar') {
    const bars = [];
    const container = document.createElement('div');
    container.className = 'sekai-audio-visualizer';

    for (let i = 0; i < count; i++) {
      const bar = document.createElement('div');
      bar.className = className;
      container.appendChild(bar);
      bars.push(bar);
    }

    return { container, bars };
  }

  /**
   * Create oscilloscope canvas
   * @private
   */
  _createOscilloscope(width = 160, height = 28) {
    const canvas = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;

    // Set display size
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    // Set actual canvas size (DPI aware)
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.className = 'sekai-audio-oscilloscope';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Initial State
    ctx.fillStyle = AUDIO_VIZ_CONFIG.OSCILLOSCOPE.BG_COLOR_IDLE;
    ctx.fillRect(0, 0, width, height);

    // Initial gradient line
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, 'rgba(167, 139, 250, 0)');
    gradient.addColorStop(0.1, AUDIO_VIZ_CONFIG.OSCILLOSCOPE.LINE_COLOR);
    gradient.addColorStop(0.9, AUDIO_VIZ_CONFIG.OSCILLOSCOPE.LINE_COLOR);
    gradient.addColorStop(1, 'rgba(167, 139, 250, 0)');

    ctx.strokeStyle = gradient;
    ctx.lineWidth = AUDIO_VIZ_CONFIG.OSCILLOSCOPE.LINE_WIDTH;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    return { canvas, ctx, width, height };
  }

  /**
   * Reset oscilloscope to idle state
   * @private
   */
  _resetOscilloscope(ctx, width, height) {
    const cfg = AUDIO_VIZ_CONFIG.OSCILLOSCOPE;
    ctx.fillStyle = cfg.BG_COLOR_IDLE;
    ctx.fillRect(0, 0, width, height);

    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, 'rgba(167, 139, 250, 0)');
    gradient.addColorStop(0.1, cfg.LINE_COLOR);
    gradient.addColorStop(0.9, cfg.LINE_COLOR);
    gradient.addColorStop(1, 'rgba(167, 139, 250, 0)');

    ctx.lineWidth = cfg.LINE_WIDTH;
    ctx.strokeStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
  }

  /**
   * Update visualizer bars with frequency data
   * @private
   */
  _updateVisualizerBars(analyser, dataArray, bars) {
    if (!analyser || !dataArray) return;

    analyser.getByteFrequencyData(dataArray);

    const step = Math.floor(dataArray.length / bars.length);
    bars.forEach((bar, index) => {
      if (index < dataArray.length) {
        const value = dataArray[index * step] || 0;
        const height = Math.max(2, (value / 255) * 100);
        bar.style.height = `${height}%`;
      }
    });
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
      case 'music': return this.renderMusic(data, metadata[0], metadata[1], metadata[2]);
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

  renderMusic(url, title, artist, duration) {
    const container = document.createElement('div');
    container.className = 'sekai-audio-player';

    const audio = this._createAudioElement(url);
    const ICONS = this._getAudioIcons(14);

    // --- Container Structure (Hybrid: Walkman x DAW x Console) ---
    // [ [Fader (Vol)] ] - Left Module (Console Style)
    // [ [Screen Window (Waveform + Tape + Time)] ] - Center Module (DAW + Reel)
    // [ [Transport Keys (Mechanical)] ] - Right Module (Walkman Style)
    
    // 1. Console Module (Vertical Volume Fader)
    const auxModule = document.createElement('div');
    auxModule.className = 'sekai-console-module';
    
    // Fader Scale
    const faderScale = document.createElement('div');
    faderScale.className = 'sekai-fader-scale';
    for(let i=0; i<5; i++) {
       const tick = document.createElement('div');
       tick.className = 'sekai-fader-tick' + (i%2===0 ? ' major' : '');
       faderScale.appendChild(tick);
    }
    auxModule.appendChild(faderScale);

    const faderTrack = document.createElement('div');
    faderTrack.className = 'sekai-fader-track';
    
    const faderCap = document.createElement('div');
    faderCap.className = 'sekai-fader-cap';
    faderCap.title = 'Volume';
    faderCap.style.top = '20%'; // Default 80% volume

    faderTrack.appendChild(faderCap);
    auxModule.appendChild(faderTrack);

    // 2. Main Screen Module (DAW + Tape Hybrid)
    const content = document.createElement('div');
    content.className = 'sekai-audio-content';

    // Top Row: Meta Info & Track Details
    const metaRow = document.createElement('div');
    metaRow.className = 'sekai-screen-meta';

    // Status Box (LED + STEREO)
    const statusBox = document.createElement('div');
    statusBox.className = 'sekai-status-indicator';
    statusBox.innerHTML = `
        <div class="sekai-led"></div>
        <span class="sekai-status-text">STEREO</span>
    `;

    // Track Info (Title - Artist)
    const trackInfo = document.createElement('div');
    trackInfo.className = 'sekai-track-info';
    trackInfo.innerHTML = `
        <div class="sekai-track-title">${this._escapeHTML(title)}</div>
        <div class="sekai-track-artist">${this._escapeHTML(artist)}</div>
    `;

    const timeDisplay = document.createElement('div');
    timeDisplay.className = 'sekai-audio-time';
    timeDisplay.textContent = '0:00 / ' + (duration || '-:--');

    metaRow.appendChild(statusBox);
    metaRow.appendChild(trackInfo);
    metaRow.appendChild(timeDisplay);

    // Center: Visualizer Area (Reels + Bars)
    const vizArea = document.createElement('div');
    vizArea.className = 'sekai-viz-area';

    // Tape Mechanism (Background)
    const tapeMech = document.createElement('div');
    tapeMech.className = 'sekai-tape-mechanism';
    tapeMech.innerHTML = `<div class="sekai-reel"></div><div class="sekai-reel"></div>`;
    vizArea.appendChild(tapeMech);

    // Waveform Bars (Foreground) - Use helper method
    const { container: visualizer, bars } = this._createVisualizerBars(32, 'sekai-viz-bar');
    visualizer.className = 'sekai-audio-visualizer-bars';
    // Randomize initial height for "static" look
    bars.forEach(bar => {
        bar.style.transform = `scaleY(${0.1 + Math.random() * 0.2})`;
    });
    vizArea.appendChild(visualizer);

    // Bottom: Scrubber
    const scrubber = document.createElement('div');
    scrubber.className = 'sekai-tape-scrubber';

    // Buffered progress (background)
    const bufferedFill = document.createElement('div');
    bufferedFill.className = 'sekai-scrub-buffered';

    const progressFill = document.createElement('div');
    progressFill.className = 'sekai-scrub-progress';

    const scrubTime = document.createElement('div');
    scrubTime.className = 'sekai-scrub-time';
    scrubTime.textContent = ''; // Only show on hover?

    scrubber.appendChild(bufferedFill);
    scrubber.appendChild(progressFill);
    scrubber.appendChild(scrubTime);
    
    content.appendChild(metaRow);
    content.appendChild(vizArea);
    content.appendChild(scrubber);

    // 3. Transport Control Module (Walkman Mechanical Keys)
    const transportModule = document.createElement('div');
    transportModule.className = 'sekai-walkman-transport';

    // Helper for buttons
    const createBtn = (iconSvg, label) => {
        const btn = document.createElement('button');
        btn.className = 'sekai-transport-btn';
        btn.innerHTML = iconSvg;
        btn.setAttribute('aria-label', label);
        return btn;
    };

    const stopBtn = createBtn(ICONS.STOP, 'Stop');
    const playBtn = createBtn(ICONS.PLAY, 'Play');
    // Implement Seek -5s / +10s (Podcast Style)
    const rwBtn = createBtn(ICONS.RW, 'Rewind 5s');
    const ffBtn = createBtn(ICONS.FF, 'Fast Forward 10s');
    
    // Transport Layout: Play (Big), Stop, RW, FF
    transportModule.appendChild(playBtn);
    transportModule.appendChild(stopBtn);
    transportModule.appendChild(rwBtn);
    transportModule.appendChild(ffBtn);

    // Assemble
    container.appendChild(auxModule);
    container.appendChild(content);
    container.appendChild(transportModule);
    container.appendChild(audio);


    // --- Logic ---
    let isDragging = false;
    let isFaderDragging = false;
    let animationId;

    // Audio Analysis Setup - Use helper method
    let analysisContext = null;

    const setupAudioAnalysis = () => {
        if (analysisContext) return;
        analysisContext = this._setupAudioAnalysis(audio, 64);
    };
    
    // Tape/Progress Update
    const updateTape = (progress) => {
        // progress: 0 to 1
        const pct = progress * 100;
        progressFill.style.width = `${pct}%`;

        // Update buffered progress
        if (audio.buffered.length > 0) {
            const bufferedEnd = audio.buffered.end(audio.buffered.length - 1);
            const bufferedPct = (bufferedEnd / audio.duration) * 100;
            bufferedFill.style.width = `${bufferedPct}%`;

            // Hide buffered bar if fully loaded
            if (bufferedEnd >= audio.duration - 0.1) { // Small tolerance for floating point
                bufferedFill.style.opacity = '0';
            } else {
                bufferedFill.style.opacity = '1';
            }
        }

        // Update Time Display with actual duration
        if (audio.duration && isFinite(audio.duration)) {
             timeDisplay.textContent = `${this._formatTime(audio.currentTime)} / ${this._formatTime(audio.duration)}`;
        }
    };

    const togglePlay = () => {
      if (audio.paused) {
        // Setup audio analysis on first play
        if (!analysisContext) {
            setupAudioAnalysis();
        }

        audio.play().then(() => {
            playBtn.innerHTML = ICONS.PAUSE;
            playBtn.classList.add('active'); // Physical latch
            container.classList.add('playing');
            statusBox.querySelector('.sekai-led').classList.add('active'); // LED On

            // Start Viz Animation
            animationId = requestAnimationFrame(animateViz);
        }).catch(err => {
            console.error("Audio playback failed:", err);
            playBtn.classList.remove('active');
        });
      } else {
        audio.pause();
        playBtn.innerHTML = ICONS.PLAY;
        playBtn.classList.remove('active');
        container.classList.remove('playing');
        statusBox.querySelector('.sekai-led').classList.remove('active'); // LED Off
        cancelAnimationFrame(animationId);
      }
    };

    const animateViz = () => {
        if (audio.paused) return;

        // Real audio visualization using Web Audio API
        if (analysisContext) {
            this._updateVisualizerBars(analysisContext.analyser, analysisContext.dataArray, bars);
        } else {
            // Fallback: Fake visualization if analysis failed
            bars.forEach(bar => {
                const h = 0.1 + Math.random() * 0.8;
                bar.style.transform = `scaleY(${h})`;
            });
        }

        animationId = requestAnimationFrame(animateViz);
    }

    playBtn.onclick = (e) => {
        e.stopPropagation();
        togglePlay();
    };
    
    stopBtn.onclick = (e) => {
        e.stopPropagation();
        audio.pause();
        audio.currentTime = 0;
        playBtn.innerHTML = ICONS.PLAY;
        playBtn.classList.remove('active');
        container.classList.remove('playing');
        statusBox.querySelector('.sekai-led').classList.remove('active');
        updateTape(0);
        // Reset Viz
        bars.forEach(b => b.style.transform = `scaleY(0.1)`);
    };

    // Seek Logic
    const seekRelative = (seconds) => {
        if (!audio.duration) return;
        const newTime = Math.max(0, Math.min(audio.duration, audio.currentTime + seconds));
        audio.currentTime = newTime;
        updateTape(newTime / audio.duration);
    };

    rwBtn.onclick = (e) => {
        e.stopPropagation();
        seekRelative(-5);
        // Visual feedback
        rwBtn.classList.add('active');
        setTimeout(() => rwBtn.classList.remove('active'), 150);
    };

    ffBtn.onclick = (e) => {
        e.stopPropagation();
        seekRelative(10);
        // Visual feedback
        ffBtn.classList.add('active');
        setTimeout(() => ffBtn.classList.remove('active'), 150);
    };

    // Scrubber Seeking (Click and Drag with Preview)
    let previewPosition = 0;

    const handleScrubPreview = (e) => {
        e.stopPropagation();
        if (!audio.duration) return;
        const rect = scrubber.getBoundingClientRect();
        const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

        // Store preview position
        previewPosition = pos;

        // Only update visual progress, not actual audio time
        const pct = pos * 100;
        progressFill.style.width = `${pct}%`;

        // Update time display to show preview time
        const previewTime = pos * audio.duration;
        const currentM = Math.floor(previewTime / 60);
        const currentS = Math.floor(previewTime % 60);
        const totalM = Math.floor(audio.duration / 60);
        const totalS = Math.floor(audio.duration % 60);
        timeDisplay.textContent = `${currentM}:${currentS.toString().padStart(2,'0')} / ${totalM}:${totalS.toString().padStart(2,'0')}`;
    };

    scrubber.onmousedown = (e) => {
        isDragging = true;
        handleScrubPreview(e);

        const onMouseMove = (moveEvent) => {
            if (!isDragging) return;
            handleScrubPreview(moveEvent);
        };

        const onMouseUp = () => {
            isDragging = false;

            // On mouse up, actually seek to the position
            if (audio.duration) {
                audio.currentTime = previewPosition * audio.duration;
            }

            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    };

    // Fader Interaction
    // Allow clicking on track to jump
    faderTrack.onmousedown = (e) => {
        if(e.target === faderCap || faderCap.contains(e.target)) return;
        const rect = faderTrack.getBoundingClientRect();
        let y = (e.clientY - rect.top) / rect.height;
        y = Math.max(0, Math.min(1, y));
        faderCap.style.top = `${y * 100}%`;
        audio.volume = 1 - y;
    };

    faderCap.onmousedown = (e) => {
        isFaderDragging = true;
        e.preventDefault(); 
        e.stopPropagation(); 
        
        const startY = e.clientY;
        const rect = faderTrack.getBoundingClientRect(); // Track dimensions
        
        // Calculate initial ratio based on current visual position
        // Top style is percentage string like "20%"
        let currentTopPct = parseFloat(faderCap.style.top);
        if (isNaN(currentTopPct)) currentTopPct = 0;
        const currentYRatio = currentTopPct / 100;
        
        const onMove = (moveEvent) => {
            const dy = moveEvent.clientY - startY; 
            const dRatio = dy / rect.height; 
            
            let newRatio = currentYRatio + dRatio;
            newRatio = Math.max(0, Math.min(1, newRatio));
            
            faderCap.style.top = `${newRatio * 100}%`;
            audio.volume = 1 - newRatio;
        };
        
        const onUp = () => {
             isFaderDragging = false;
             document.removeEventListener('mousemove', onMove);
             document.removeEventListener('mouseup', onUp);
        };
        
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    };

    audio.ontimeupdate = () => {
       if (isDragging) return;
       if (audio.duration) {
           updateTape(audio.currentTime / audio.duration);
       }
    };
    
    audio.onended = () => {
        playBtn.innerHTML = ICONS.PLAY; 
        playBtn.classList.remove('active');
        container.classList.remove('playing');
        statusBox.querySelector('.sekai-led').classList.remove('active');
        updateTape(1);
        cancelAnimationFrame(animationId);
    };

    return container;
  }

  renderAudio(url, duration) {
    const container = document.createElement('div');
    container.className = 'sekai-audio-player-simple';

    const audio = this._createAudioElement(url);
    const ICONS = this._getAudioIcons(16);

    const playBtn = document.createElement('button');
    playBtn.className = 'sekai-audio-control';
    playBtn.setAttribute('aria-label', 'Play');

    const iconSpan = document.createElement('span');
    iconSpan.className = 'sekai-audio-icon-span';
    iconSpan.innerHTML = ICONS.PLAY;

    const indicator = document.createElement('div');
    indicator.className = 'sekai-audio-indicator';

    playBtn.appendChild(iconSpan);
    playBtn.appendChild(indicator);

    const contentArea = document.createElement('div');
    contentArea.className = 'sekai-audio-content-simple';

    const infoRow = document.createElement('div');
    infoRow.className = 'sekai-audio-info-row';

    const { canvas: visualizerCanvas, ctx, width, height } = this._createOscilloscope(200, 20);
    // Add margin to prevent visual clutter
    visualizerCanvas.style.marginRight = '8px';

    const timeDisplay = document.createElement('div');
    timeDisplay.className = 'sekai-audio-time';
    timeDisplay.textContent = '0:00 / ' + (duration || '0:00');

    infoRow.appendChild(visualizerCanvas);
    infoRow.appendChild(timeDisplay);

    contentArea.appendChild(infoRow);

    const progressContainer = document.createElement('div');
    progressContainer.className = 'sekai-audio-progress-container';

    const progressBar = document.createElement('div');
    progressBar.className = 'sekai-audio-progress-bar';

    const progressFill = document.createElement('div');
    progressFill.className = 'sekai-audio-progress-fill';
    progressBar.appendChild(progressFill);

    progressContainer.appendChild(progressBar);

    contentArea.appendChild(infoRow);
    contentArea.appendChild(progressContainer);

    let analysisContext = null;
    let animationId = null;

    const setupAudioContext = () => {
      if (analysisContext) return;
      analysisContext = this._setupAudioAnalysis(audio, AUDIO_VIZ_CONFIG.OSCILLOSCOPE.FFT_SIZE);
    };

    const updateVisualizer = () => {
      if (!analysisContext) return;
      
      const { analyser, dataArray } = analysisContext;
      
      // Get Time Domain Data (Waveform) - 128 is center
      analyser.getByteTimeDomainData(dataArray);

      // Clear with transparency for "Afterglow" effect
      ctx.fillStyle = AUDIO_VIZ_CONFIG.OSCILLOSCOPE.BG_COLOR_PLAYING;
      ctx.fillRect(0, 0, width, height);

      // Create gradient mask
      const cfg = AUDIO_VIZ_CONFIG.OSCILLOSCOPE;
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, 'rgba(167, 139, 250, 0)');
      gradient.addColorStop(0.1, cfg.LINE_COLOR);
      gradient.addColorStop(0.9, cfg.LINE_COLOR);
      gradient.addColorStop(1, 'rgba(167, 139, 250, 0)');

      ctx.lineWidth = cfg.LINE_WIDTH;
      ctx.strokeStyle = gradient;
      ctx.beginPath();

      const sliceWidth = width / dataArray.length;
      let x = 0;
      
      // For RMS calculation
      let sumSquares = 0;

      for(let i = 0; i < dataArray.length; i++) {
        const v = dataArray[i] / 128.0;
        const y = v * height / 2;

        if(i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }

        x += sliceWidth;

        // Calculate RMS
        const amplitude = (dataArray[i] - 128) / 128;
        sumSquares += amplitude * amplitude;
      }

      ctx.lineTo(width, height / 2);
      ctx.stroke();

      // RMS-based indicator pulsing
      const rms = Math.sqrt(sumSquares / dataArray.length);
      const indicatorCfg = AUDIO_VIZ_CONFIG.INDICATOR;

      // Scale for visibility
      const pulseScale = 1 + (rms * indicatorCfg.RMS_SCALE);
      const pulseOpacity = indicatorCfg.BASE_OPACITY + (rms * 2);
      const glowSpread = indicatorCfg.GLOW_BASE + (rms * indicatorCfg.GLOW_SCALE);

      // Apply to indicator
      indicator.style.transform = `scale(${Math.min(indicatorCfg.MAX_SCALE, pulseScale)})`;
      indicator.style.opacity = Math.min(1, pulseOpacity);
      indicator.style.boxShadow = `0 0 ${glowSpread}px ${indicatorCfg.ACCENT_COLOR}`;

      if (!audio.paused) {
        animationId = requestAnimationFrame(updateVisualizer);
      }
    };

    const updatePlayState = (isPlaying) => {
        if (isPlaying) {
            iconSpan.innerHTML = ICONS.PAUSE;
            playBtn.setAttribute('aria-label', 'Pause');
            container.classList.add('playing');
            indicator.classList.add('active');

            if (!analysisContext) {
              setupAudioContext();
            }
            updateVisualizer();
        } else {
            iconSpan.innerHTML = ICONS.PLAY;
            playBtn.setAttribute('aria-label', 'Play');
            container.classList.remove('playing');
            indicator.classList.remove('active');

            // Reset indicator and canvas
            indicator.style.transform = '';
            indicator.style.opacity = '';
            indicator.style.boxShadow = '';

            this._resetOscilloscope(ctx, width, height);

            if (animationId) {
              cancelAnimationFrame(animationId);
              animationId = null;
            }
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
      const current = audio.currentTime;
      const total = audio.duration || 0;

      if (total > 0) {
        progressFill.style.width = `${(current / total) * 100}%`;
        timeDisplay.textContent = `${this._formatTime(current)} / ${this._formatTime(total)}`;
      }
    };

    let isDragging = false;

    const seek = (e) => {
      const rect = progressBar.getBoundingClientRect();
      const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      if (audio.duration) {
        audio.currentTime = percent * audio.duration;
      }
    };

    progressBar.addEventListener('mousedown', (e) => {
      isDragging = true;
      seek(e);
    });

    document.addEventListener('mousemove', (e) => {
      if (isDragging) {
        seek(e);
      }
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });

    progressBar.addEventListener('click', seek);

    progressBar.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      const rect = progressBar.getBoundingClientRect();
      const percent = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
      if (audio.duration) {
        audio.currentTime = percent * audio.duration;
      }
    });

    audio.onended = () => {
        updatePlayState(false);
        progressFill.style.width = '0%';
        audio.currentTime = 0;

        bars.forEach(bar => {
          bar.style.height = '2px';
        });
    };

    audio.onpause = () => {
      if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
      }
    };

    container.appendChild(audio);
    container.appendChild(playBtn);
    container.appendChild(contentArea);

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
