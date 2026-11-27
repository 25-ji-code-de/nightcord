/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** SekaiImageRenderer: imageRenderer component; renderer supplies shared presentation context. */
class SekaiImageRenderer {
  constructor(renderer) { this.renderer = renderer; }

  /**
   * Image with optional w/h aspect-ratio, alt, name, spoiler.
   */
  renderImageV2(desc, payload) {
    const url = this.renderer.resolveResource(payload, 'image');
    const alt = desc.alt || desc.name || 'Image';
    const container = this.renderImage(url, alt);

    // Pre-reserve the real box when w/h known (spec §9.1).
    // 否则会落回 .loading 的固定 400×225 横屏占位，竖图/方图加载时整页跳动。
    const w = parseInt(desc.w, 10);
    const h = parseInt(desc.h, 10);
    if (w > 0 && h > 0 && container && container.style) {
      this._applyImageBox(container, w, h);
    }

    if (this.renderer._descBool(desc, 'spoiler', false) && container) {
      container.classList.add('sekai-image-spoiler');
      container.setAttribute('tabindex', '0');
      container.setAttribute('role', 'button');
      container.setAttribute('aria-label', '查看剧透图片');
      // Keep the reveal hint separate from the loading shimmer (::after).
      const cover = document.createElement('span');
      cover.className = 'sekai-image-spoiler-cover';
      cover.setAttribute('aria-hidden', 'true');
      cover.innerHTML = `<span class="sekai-image-spoiler-label">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
          <path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A10.6 10.6 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.8M6.1 6.1A20 20 0 0 0 2 12s4 7 10 7a11 11 0 0 0 5.9-1.9"/>
        </svg>
        <span>查看图片</span>
      </span>`;
      container.appendChild(cover);
      // Capture phase so reveal runs before img.onclick opens the viewer
      const reveal = (e) => {
        if (container.classList.contains('revealed')) return;
        e.preventDefault();
        e.stopPropagation();
        if (container.classList.contains('loading')) return;
        container.classList.add('revealed');
        container.setAttribute('aria-label', `预览图片 ${alt}`);
        container.removeEventListener('click', reveal, true);
      };
      container.addEventListener('click', reveal, { capture: true });
      container.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !container.classList.contains('revealed')) {
          reveal(e);
        }
      }, { capture: true });
    }

    return container;
  }

  /**
   * 用 v2 Image 的 w/h 预留加载占位框，尺寸与加载完成后一致。
   *
   * 加载完成后容器的盒子由两层约束决定（见 css/renderer.css）：
   *   .sekai-image-large   max-width: 400px
   *   .sekai-image-small   max-width: 200px
   *   .sekai-image-content max-height: 400px
   * 所以这里按同样的上限算出显示尺寸，加载时就不会再跳。
   * 宽度同时用 min(…, 100%) 保证窄屏不溢出，高度交给 aspect-ratio 等比推导。
   *
   * @private
   */
  _applyImageBox(container, w, h) {
    const large = w > this.renderer.imageWidthThreshold;
    const maxW = large ? 400 : 200;
    const maxH = 400;
    let boxW = Math.min(w, maxW);
    let boxH = (boxW * h) / w;
    if (boxH > maxH) {
      boxH = maxH;
      boxW = (boxH * w) / h;
    }

    container.classList.add(large ? 'sekai-image-large' : 'sekai-image-small');
    container.style.width = `min(${Math.max(1, Math.round(boxW))}px, 100%)`;
    // 覆盖 .loading 的固定 225px 高度，让 aspect-ratio 生效
    container.style.height = 'auto';
    container.style.aspectRatio = `${w} / ${h}`;

    // renderImage releases this box only after decoding (or failure), keeping
    // the placeholder stable while the downloaded bitmap is not yet ready.
  }

  /**
   * Stamp: library name or custom=true UUID.
   */
  renderStampV2(desc, payload, isSingle) {
    if (this.renderer._descBool(desc, 'custom', false)) {
      const url = this.renderer.resolveResource(payload, 'sticker');
      return this.renderSticker(url, isSingle);
    }
    return this.renderStamp(payload, isSingle);
  }

  /**
   * Library stamp. Accepts bare digits ("0042") or full name ("stamp0042").
   */
  renderStamp(idOrName, isSingle) {
    const raw = String(idOrName || '').trim();
    if (!raw) return document.createTextNode('[stamp]');

    // Normalize: "0042" / "stamp0042" / "stamp_0042" → stamp name for CDN
    let stampName;
    if (/^stamp[_-]?\d+$/i.test(raw)) {
      stampName = 'stamp' + raw.replace(/^stamp[_-]?/i, '');
    } else if (/^\d+$/.test(raw)) {
      stampName = 'stamp' + raw;
    } else {
      // Non-numeric library codes (legacy category_label) — try as-is
      stampName = raw;
    }

    const cleanName = stampName.toLowerCase();
    const src = `${this.renderer.stickerDir}/${encodeURIComponent(cleanName)}.png`;

    const img = document.createElement('img');
    img.className = `sekai-sticker ${isSingle ? 'sekai-sticker-single' : 'sekai-sticker-inline'}`;
    img.src = src;
    img.alt = `[${stampName}]`;
    img.title = stampName;
    img.loading = 'lazy';

    img.onerror = () => {
        const replacement = document.createElement('span');
        replacement.className = 'sticker-broken';
        replacement.textContent = `[${stampName}]`;
        img.replaceWith(replacement);
    };

    return img;
  }

  renderSticker(url, isSingle) {
    const img = document.createElement('img');
    img.className = `sekai-sticker ${isSingle ? 'sekai-sticker-single' : 'sekai-sticker-inline'}`;
    img.src = url;
    img.alt = '[sticker]';
    img.title = 'Custom Sticker';
    img.loading = 'lazy';

    img.onerror = () => {
        const replacement = document.createElement('span');
        replacement.className = 'sticker-broken';
        replacement.textContent = '[sticker]';
        img.replaceWith(replacement);
    };

    return img;
  }

  renderImage(url, alt) {
    const container = document.createElement('div');
    container.className = 'sekai-image-container';
    container.tabIndex = 0;
    container.setAttribute('role', 'button');
    container.setAttribute('aria-label', `预览图片 ${alt || ''}`.trim());
    container.setAttribute('aria-haspopup', 'dialog');

    // Loading State
    container.classList.add('loading');

    const img = document.createElement('img');
    img.className = 'sekai-image-content';
    img.alt = alt || 'Image';
    img.loading = 'lazy';
    img.decoding = 'async';

    const releaseBox = () => {
      container.style.width = '';
      container.style.height = '';
      container.style.aspectRatio = '';
    };
    let failed = false;
    const showError = () => {
        if (failed) return;
        failed = true;
        container.innerHTML = `<div class="sekai-error-placeholder">
            <span class="sekai-error-icon">⚠️</span>
            <span class="sekai-error-text">Failed to load image</span>
        </div>`;
        releaseBox();
        container.classList.remove('loading');
    };

    img.onload = async () => {
      try {
        // load means the response arrived; decode makes the entire bitmap ready
        // before a lazy/offscreen thumbnail is revealed and painted.
        if (typeof img.decode === 'function') await img.decode();
      } catch (_) {
        showError();
        return;
      }
      if (failed) return;
      const large = img.naturalWidth > this.renderer.imageWidthThreshold;
      container.classList.toggle('sekai-image-large', large);
      container.classList.toggle('sekai-image-small', !large);
      releaseBox();
      container.classList.remove('loading');
    };
    img.onerror = showError;
    img.src = url;

    // Open in full-screen image viewer (blocked while parent spoiler is unrevealed)
    img.onclick = (e) => {
      const spoilerHost = img.closest('.sekai-image-spoiler');
      if (spoilerHost && !spoilerHost.classList.contains('revealed')) {
        // Let the container's capture-phase handler reveal; do not open viewer yet
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (window.sekaiImageViewer) {
        window.sekaiImageViewer.open(url, alt || '');
      } else {
        // Fallback if viewer not loaded
        window.open(url, '_blank');
      }
    };

    container.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.target !== container) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      img.click();
    });

    container.appendChild(img);
    if (alt) {
        const caption = document.createElement('div');
        caption.className = 'sekai-image-caption';
        caption.textContent = alt;
        container.appendChild(caption);
    }

    return container;
  }
}
