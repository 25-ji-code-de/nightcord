/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** SekaiTextRenderer: textRenderer component; renderer supplies shared presentation context. */
class SekaiTextRenderer {
  constructor(renderer) { this.renderer = renderer; }

  renderText(content) {
    // Most chat messages are ordinary text. Avoid DOMPurify, innerHTML and the
    // sticker tree walk for that common path; rich syntax still follows
    // the full renderer below. This keeps history replay cheap without changing
    // the resulting text semantics or the rich-text security boundary.
    const plain = String(content ?? '');
    const mayHaveRichContent = /[<>&`*~|\r\n\[\]]|https?:\/\//.test(plain);
    if (!mayHaveRichContent) {
      const span = this.renderer._getElement('span');
      span.className = 'sekai-text-node';
      span.textContent = plain;
      if (this.renderer.emojiService) this.renderer.emojiService.processElement(span);
      return span;
    }

    // Apply basic markdown formatting here
    // We process this line by line to handle block elements if needed,
    // but for now we focus on inline formatting.

    // 1. Escape HTML (safety first) - Only if DOMPurify not available
    let html = this.renderer.useDOMPurify ? content : this.renderer.escapeHtml(content);

    // 2. Apply Markdown Rules (Order matters!)

    // Blockquote (> text)
    // Use a function to handle potential multiline or single line quotes more cleanly
    // For now, simple line replacement is robust enough
    const gtSymbol = this.renderer.useDOMPurify ? '>' : '&gt;';
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

    // Spoiler (||text||) — no inline onclick (event delegation below)
    html = html.replace(/\|\|(.*?)\|\|/g, '<span class="sekai-spoiler" tabindex="0" role="button" aria-label="Spoiler">$1</span>');

    // Links (Simple URL detection) - Before processing inline code to avoid linking inside code blocks
    // Use negative lookbehind/lookahead to avoid matching URLs already in href attributes
    const urlRegex = /(?<!href=["'])(?<!>)(https?:\/\/[^\s<]+)(?![^<]*<\/a>)/g;
    html = html.replace(urlRegex, (url) => {
        // Escape URL for safe insertion
        const escapedUrl = this.renderer.useDOMPurify ? url : url.replace(/"/g, '&quot;');
        return `<a href="${escapedUrl}" target="_blank" rel="noopener" class="sekai-link-inline">${url}</a>`;
    });

    // Newlines to <br>
    html = html.replace(/\n/g, '<br>');

    // Sanitize with DOMPurify if available
    if (this.renderer.useDOMPurify) {
      html = this.renderer._sanitizeHTML(html);
    }

    // Create wrapper (use object pool)
    const span = this.renderer._getElement('span');
    span.className = 'sekai-text-node';
    span.innerHTML = html;
    span.querySelectorAll('img:not([alt])').forEach(image => { image.alt = '图片'; });

    // Wire spoiler interaction without inline handlers
    this._bindSpoilers(span);

    // Process legacy stickers [airi_name] etc.
    if (this.renderer.stickerService) {
         this.processStickerInHTML(span);
    }

    if (this.renderer.emojiService) {
      this.renderer.emojiService.processElement(span);
    }

    return span;
  }

  /**
   * Bind click / keyboard reveal for .sekai-spoiler nodes.
   * @private
   */
  _bindSpoilers(root) {
    if (!root) return;
    root.querySelectorAll('.sekai-spoiler').forEach((el) => {
      if (el.dataset.sekaiBound === '1') return;
      el.dataset.sekaiBound = '1';
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
      const toggle = (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.toggle('revealed');
      };
      el.addEventListener('click', toggle);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') toggle(e);
      });
    });
  }

  processStickerInHTML(element) {
    if (!this.renderer.stickerService) return;

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
         const frag = this.renderer.stickerService.renderTextWithStickers(text);

         // If modification happened (fragment has elements or different text)
         if (frag.childNodes.length > 0) {
             textNode.replaceWith(frag);
         }
      }
    });
  }

  /**
   * Format: spoiler / color / preserve (truecolor).
   * Payload is already decoded (base64 handled in tokenizer).
   */
  renderFormat(desc, text) {
    const spoiler = this.renderer._descBool(desc, 'spoiler', false);
    const color = desc.color || null;
    const preserve = this.renderer._descBool(desc, 'preserve', false);
    const content = text == null ? '' : String(text);

    let node;
    if (color) {
      node = this.renderColor(color, content, preserve);
    } else {
      node = document.createElement('span');
      node.className = 'sekai-format-text';
      node.textContent = content;
    }

    if (spoiler) {
      const wrap = document.createElement('span');
      wrap.className = 'sekai-spoiler';
      wrap.setAttribute('tabindex', '0');
      wrap.setAttribute('role', 'button');
      wrap.setAttribute('aria-label', 'Spoiler');
      wrap.appendChild(node);
      // Bind on wrap itself (querySelectorAll would miss the root)
      wrap.dataset.sekaiBound = '1';
      const toggle = (e) => {
        e.preventDefault();
        e.stopPropagation();
        wrap.classList.toggle('revealed');
      };
      wrap.addEventListener('click', toggle);
      wrap.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') toggle(e);
      });
      return wrap;
    }

    return node;
  }

  /**
   * Mention chip. The host binds identity/profile and composer actions.
   */
  renderMention(desc, payload) {
    const mType = (desc.type || 'user').toLowerCase();
    const display = desc.display || payload || mType;
    const span = document.createElement('span');
    span.className = `sekai-mention sekai-mention-${mType}`;
    span.dataset.mentionType = mType;
    span.dataset.mentionId = payload || '';
    span.textContent = mType === 'all' ? '@everyone' : `@${display}`;
    span.title = mType === 'ai' ? `AI: ${display}` : `Mention: ${display}`;
    this.renderer.bindMention?.(span, { type: mType, id: payload || '', name: display });
    return span;
  }

  /**
   * Code block with optional lang / name / collapse.
   */
  renderCodeV2(desc, payload) {
    const lang = desc.lang || 'plain';
    const name = desc.name || '';
    const collapse = this.renderer._descBool(desc, 'collapse', false);
    const codeText = payload == null ? '' : String(payload);

    const wrapper = document.createElement('div');
    wrapper.className = 'sekai-code-wrapper';
    if (collapse) wrapper.classList.add('collapsed');

    if (name || lang) {
      const header = document.createElement('div');
      header.className = 'sekai-code-header';
      if (name) {
        const nameEl = document.createElement('span');
        nameEl.className = 'sekai-code-name';
        nameEl.textContent = name;
        header.appendChild(nameEl);
      }
      if (lang && lang !== 'plain') {
        const langEl = document.createElement('span');
        langEl.className = 'sekai-code-lang';
        langEl.textContent = lang;
        header.appendChild(langEl);
      }
      if (collapse) {
        const toggle = document.createElement('button');
        toggle.className = 'sekai-code-toggle';
        toggle.type = 'button';
        toggle.setAttribute('aria-label', 'Expand code');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.textContent = 'Expand';
        toggle.addEventListener('click', (e) => {
          e.stopPropagation();
          wrapper.classList.toggle('collapsed');
          const collapsed = wrapper.classList.contains('collapsed');
          toggle.textContent = collapsed ? 'Expand' : 'Collapse';
          toggle.setAttribute('aria-label', collapsed ? 'Expand code' : 'Collapse code');
          toggle.setAttribute('aria-expanded', String(!collapsed));
        });
        header.appendChild(toggle);
      }
      wrapper.appendChild(header);
    }

    const code = document.createElement('code');
    code.className = 'sekai-code-block';
    if (lang) code.dataset.lang = lang;
    code.textContent = codeText;
    wrapper.appendChild(code);
    return wrapper;
  }

  renderCodeBlock(lang, content) {
      // v1: [code:lang|content] — if no content, lang field may actually be the body
      const body = content != null && content !== '' ? content : '';
      const language = body ? (lang || 'plain') : 'plain';
      const text = body || lang || '';
      return this.renderCodeV2({ lang: language }, text);
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
}
