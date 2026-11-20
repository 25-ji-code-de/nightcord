/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** SekaiCardRenderer: cardRenderer component; renderer supplies shared presentation context. */
class SekaiCardRenderer {
  constructor(renderer) { this.renderer = renderer; }

  /**
   * Files: MIME-driven renderer (audio+title → music, audio → simple, else file card).
   */
  renderFilesV2(desc, payload) {
    const url = this.renderer.resolveResource(payload, 'file');
    const mime = (desc.type || 'application/octet-stream').toLowerCase();
    const name = desc.name || 'file';
    const sizeKb = desc.size != null && desc.size !== '' ? Number(desc.size) : null;
    const sizeLabel = sizeKb != null && !Number.isNaN(sizeKb)
      ? (sizeKb >= 1024 ? `${(sizeKb / 1024).toFixed(1)} MB` : `${sizeKb} kB`)
      : '';

    if (mime.startsWith('audio/')) {
      const durationSec = desc.duration != null && desc.duration !== '' ? Number(desc.duration) : null;
      const durationLabel = durationSec != null && !Number.isNaN(durationSec)
        ? this.renderer._formatTime(durationSec)
        : '';

      if (desc.title) {
        return this.renderer.renderMusic(
          url,
          desc.title,
          desc.artist || '',
          durationLabel
        );
      }
      return this.renderer.renderAudio(url, durationLabel);
    }

    return this.renderFile(url, name, sizeLabel);
  }

  /**
   * Reply: payload is timestamp; preview derived client-side.
   */
  renderReplyV2(payload) {
    const ts = String(payload || '').trim();
    let preview = '回复消息';
    if (this.renderer.lookupReply) {
      try {
        const info = this.renderer.lookupReply(Number(ts) || ts);
        if (info) {
          const name = info.name || info.user || '';
          const text = info.preview || info.text || '';
          if (name && text) preview = `${name}: ${text}`;
          else if (text) preview = text;
          else if (name) preview = name;
        }
      } catch (e) {
        console.warn('lookupReply failed:', e);
      }
    }
    return this.renderReply(ts, preview);
  }

  /**
   * Embed: rich link card (title/desc/domain/color from descriptions).
   */
  renderEmbedV2(desc, payload) {
    const url = payload || '';
    const title = desc.title || undefined;
    const cardDesc = desc.desc || undefined;
    const card = this.renderLinkCard(url, title, cardDesc);

    // Override domain display if provided
    if (desc.domain && card) {
      const site = card.querySelector('.sekai-link-site');
      if (site) site.textContent = desc.domain;
    }
    if (desc.color && card) {
      const accent = card.querySelector('.sekai-link-accent');
      if (accent) {
        let hex = desc.color.startsWith('#') ? desc.color : '#' + desc.color;
        if (/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(hex)) {
          accent.style.background = hex;
        }
      }
    }
    return card;
  }

  renderFile(url, name = 'File', size) {
    const card = document.createElement('div');
    card.className = 'sekai-file-card';

    // Escape user inputs to prevent XSS
    const escapedUrl = this.renderer.useDOMPurify ? url : this.renderer.escapeHtml(url);
    const escapedName = this.renderer.useDOMPurify ? name : this.renderer.escapeHtml(name);
    const escapedSize = this.renderer.useDOMPurify ? (size || '') : this.renderer.escapeHtml(size || '');

    card.onclick = (e) => {
        if (!e.target.closest('a')) {
            window.open(url, '_blank');
        }
    };

    const ext = name.split('.').pop().toLowerCase();
    const icon = this.getFileIcon(ext);

    const fileHTML = `
      <div class="sekai-file-icon">${icon}</div>
      <a href="${escapedUrl}" target="_blank" rel="noopener" class="sekai-file-details">
        <div class="sekai-file-name" title="${escapedName}">${escapedName}</div>
        <div class="sekai-file-meta">${escapedSize || ext.toUpperCase()}</div>
      </a>
      <a href="${escapedUrl}" download="${escapedName}" class="sekai-file-action" title="下载" aria-label="下载 ${escapedName}">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
      </a>
    `;

    card.innerHTML = this.renderer.useDOMPurify ? this.renderer._sanitizeHTML(fileHTML) : fileHTML;

    return card;
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
    const escapedDomain = this.renderer.useDOMPurify ? domain : this.renderer.escapeHtml(domain);
    const escapedTitle = this.renderer.useDOMPurify ? (title || url) : this.renderer.escapeHtml(title || url);
    const escapedUrl = this.renderer.useDOMPurify ? url : this.renderer.escapeHtml(url);
    const escapedDesc = this.renderer.useDOMPurify ? (desc || '') : this.renderer.escapeHtml(desc || '');

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

    card.innerHTML = this.renderer.useDOMPurify ? this.renderer._sanitizeHTML(linkHTML) : linkHTML;

    return card;
  }

  renderReply(timestamp, preview) {
    const chip = document.createElement('div');
    chip.className = 'sekai-reply-chip';
    chip.tabIndex = 0;
    chip.setAttribute('role', 'button');
    chip.title = `点击跳转到 #${timestamp}`;

    // Escape user content
    const escapedPreview = this.renderer.useDOMPurify ? (preview || '回复') : this.renderer.escapeHtml(preview || '回复');

    const replyHTML = `
      <div class="sekai-reply-accent">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true" focusable="false">
              <path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" stroke="none"></path>
          </svg>
      </div>
      <div class="sekai-reply-content">${escapedPreview}</div>
    `;

    chip.innerHTML = this.renderer.useDOMPurify ? this.renderer._sanitizeHTML(replyHTML) : replyHTML;

    chip.onclick = () => {
        // Convert string timestamp to number for messageIndex lookup
        const event = new CustomEvent('reply-jump', { detail: { timestamp: Number(timestamp) } });
        document.dispatchEvent(event);
    };
    chip.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      chip.click();
    });

    return chip;
  }

  getFileIcon(ext) {
    // Audio Icon: A music note with sound waves
    const audioIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="24" height="24" aria-hidden="true" focusable="false">
        <path d="M9 18V5l12-2v13"></path>
        <circle cx="6" cy="18" r="3"></circle>
        <circle cx="18" cy="16" r="3"></circle>
    </svg>`;

    // Image Icon: Picture frame with mountain and sun
    const imageIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="24" height="24" aria-hidden="true" focusable="false">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
        <circle cx="8.5" cy="8.5" r="1.5"></circle>
        <polyline points="21 15 16 10 5 21"></polyline>
    </svg>`;

    // Generic File Icon: Paper with folded corner
    const defaultIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="24" height="24" aria-hidden="true" focusable="false">
        <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
        <polyline points="13 2 13 9 20 9"></polyline>
    </svg>`;

    // Code/Data Icon: Brackets
    const codeIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="24" height="24" aria-hidden="true" focusable="false">
        <polyline points="16 18 22 12 16 6"></polyline>
        <polyline points="8 6 2 12 8 18"></polyline>
    </svg>`;

    // Archive Icon: Box/Zip
    const archiveIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="24" height="24" aria-hidden="true" focusable="false">
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
}
