/**
 * SEKAI Renderer - Structured Extensible Keyword for Advanced Interactions
 *
 * 负责解析和渲染 SEKAI 富文本语法，包括：
 * - 基础富媒体：[img:URL]、[file:ID|Name|Size]、[audio:ID|Duration]、[stamp:ID]
 * - 文本格式化：**粗体**、*斜体*、~~删除线~~、||黑幕||、`代码`、> 引用
 * - 高级交互：[re:timestamp]、[link:URL|Title]、[color:hex|text]
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
    
    // Theme Configuration
    this.theme = {
      imageMaxWidth: 360,
      borderRadius: '6px',
      accentColor: '#7c6fac'
    };
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

    return tokens;
  }

  renderText(content) {
    // Apply basic markdown formatting here
    // We process this line by line to handle block elements if needed, 
    // but for now we focus on inline formatting.
    
    // 1. Escape HTML (safety first)
    let html = this.escapeHtml(content);

    // 2. Apply Markdown Rules (Order matters!)
    
    // Blockquote (> text)
    // Use a function to handle potential multiline or single line quotes more cleanly
    // For now, simple line replacement is robust enough
    html = html.replace(/^&gt;\s+(.*?)(?=\n|$)/gm, '<blockquote>$1</blockquote>');
    
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
        const escapedUrl = url.replace(/"/g, '&quot;');
        return `<a href="${escapedUrl}" target="_blank" rel="noopener" class="sekai-link-inline">${url}</a>`;
    });

    // Newlines to <br>
    html = html.replace(/\n/g, '<br>');

    // Create wrapper
    const span = document.createElement('span');
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
      case 'color': return this.renderColor(data, metadata[0]);
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
        replacement.className = 'sekai-sticker-broken';
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
    
    img.onload = () => container.classList.remove('loading');
    img.onerror = () => {
        container.innerHTML = `<div class="sekai-error-placeholder">
            <span class="sekai-error-icon">⚠️</span>
            <span class="sekai-error-text">Failed to load image</span>
        </div>`;
        container.classList.remove('loading');
    };

    // Lightbox / Zoom support (Placeholder for future interaction)
    img.onclick = () => window.open(url, '_blank');

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
    const escapedUrl = this.escapeHtml(url);
    const escapedName = this.escapeHtml(name);
    const escapedSize = this.escapeHtml(size || '');

    card.onclick = (e) => {
        if (!e.target.closest('.sekai-file-action')) {
            window.open(url, '_blank');
        }
    };

    const ext = name.split('.').pop().toLowerCase();
    const icon = this.getFileIcon(ext);

    card.innerHTML = `
      <div class="sekai-file-icon">${icon}</div>
      <div class="sekai-file-details">
        <div class="sekai-file-name" title="${escapedName}">${escapedName}</div>
        <div class="sekai-file-meta">${escapedSize || ext.toUpperCase()}</div>
      </div>
      <a href="${escapedUrl}" download="${escapedName}" class="sekai-file-action" title="Download">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
      </a>
    `;

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

    const playBtn = document.createElement('button');
    playBtn.className = 'sekai-audio-control';
    playBtn.innerHTML = '<div class="play-icon">▶</div>';
    
    const wave = document.createElement('div');
    wave.className = 'sekai-audio-wave';
    let barsHtml = '';
    for(let i=0; i<20; i++) {
        const h = 20 + Math.random() * 60;
        barsHtml += `<div class="bar" style="height:${h}%; animation-delay:${i*0.05}s"></div>`;
    }
    wave.innerHTML = barsHtml;

    const timeDisplay = document.createElement('div');
    timeDisplay.className = 'sekai-audio-time';
    timeDisplay.textContent = duration || '0:00';

    playBtn.onclick = () => {
        if (audio.paused) {
            audio.play();
            playBtn.innerHTML = '<div class="pause-icon">II</div>';
            container.classList.add('playing');
        } else {
            audio.pause();
            playBtn.innerHTML = '<div class="play-icon">▶</div>';
            container.classList.remove('playing');
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
        playBtn.innerHTML = '<div class="play-icon">▶</div>';
        container.classList.remove('playing');
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
    const escapedDomain = this.escapeHtml(domain);
    const escapedTitle = this.escapeHtml(title || url);
    const escapedUrl = this.escapeHtml(url);
    const escapedDesc = this.escapeHtml(desc || '');

    card.innerHTML = `
      <div class="sekai-link-accent"></div>
      <div class="sekai-link-content">
        <div class="sekai-link-site">${escapedDomain}</div>
        <div class="sekai-link-title">${escapedTitle}</div>
        <div class="sekai-link-url">${escapedUrl}</div>
        ${desc ? `<div class="sekai-link-desc">${escapedDesc}</div>` : ''}
      </div>
      <div class="sekai-link-arrow">↗</div>
    `;

    return card;
  }

  renderReply(timestamp, preview) {
    const chip = document.createElement('div');
    chip.className = 'sekai-reply-chip';

    // Escape user content
    const escapedPreview = this.escapeHtml(preview || 'Reply');
    const escapedTimestamp = this.escapeHtml(timestamp);

    chip.innerHTML = `
      <span class="sekai-reply-icon">↪</span>
      <span class="sekai-reply-text">${escapedPreview} #${escapedTimestamp}</span>
    `;

    chip.onclick = () => {
        const event = new CustomEvent('reply-jump', { detail: { timestamp } });
        document.dispatchEvent(event);
    };

    return chip;
  }

  renderColor(hex, text) {
      const span = document.createElement('span');
      // Fix: Normalize hex by adding # if missing
      const normalizedHex = hex.startsWith('#') ? hex : '#' + hex;
      const validHex = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(normalizedHex) ? normalizedHex : '#fff';
      
      span.style.color = validHex;
      span.textContent = text || hex;
      span.style.textShadow = `0 0 2px ${validHex}40`;
      
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
    const icons = {
        image: '🖼️',
        audio: '🎵',
        video: '🎬',
        pdf: '📄',
        archive: '📦',
        code: '💻',
        default: '📎'
    };
    
    if (['jpg','jpeg','png','gif','webp'].includes(ext)) return icons.image;
    if (['mp3','wav','ogg','flac'].includes(ext)) return icons.audio;
    if (['mp4','webm','mov'].includes(ext)) return icons.video;
    if (['pdf'].includes(ext)) return icons.pdf;
    if (['zip','rar','7z','tar'].includes(ext)) return icons.archive;
    if (['js','html','css','py','json'].includes(ext)) return icons.code;
    return icons.default;
  }
}

window.SekaiRenderer = SekaiRenderer;
