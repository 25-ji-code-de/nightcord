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
      container.setAttribute('aria-label', 'Spoiler image');
      // Capture phase so reveal runs before img.onclick opens the viewer
      const reveal = (e) => {
        if (container.classList.contains('revealed')) return;
        e.preventDefault();
        e.stopPropagation();
        container.classList.add('revealed');
        container.setAttribute('aria-label', `预览图片 ${alt}`);
      };
      container.addEventListener('click', reveal, { capture: true, once: true });
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

    // 加载完成后把尺寸交还给浏览器自然排版：
    // - w/h 正确时自然排版的盒子与预留框逐像素相同，无跳动；
    // - w/h 被写错（第三方客户端、奇怪浏览器）时，这里会纠正成真实尺寸，
    //   而不是留下一块比例错误的底色。
    const img = container.querySelector('img');
    if (!img) return;
    const release = () => {
      container.style.width = '';
      container.style.height = '';
      container.style.aspectRatio = '';
      // 大/小类以真实宽度为准，避免描述与实物不符时两个 class 并存
      const nw = img.naturalWidth;
      if (nw > 0) {
        const isLarge = nw > this.renderer.imageWidthThreshold;
        container.classList.toggle('sekai-image-large', isLarge);
        container.classList.toggle('sekai-image-small', !isLarge);
      }
    };
    if (img.complete) {
      release(); // 缓存命中 / data URI 可能已经解码
    } else {
      img.addEventListener('load', release, { once: true });
      img.addEventListener('error', release, { once: true });
    }
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
    img.src = url;
    img.alt = alt || 'Image';
    img.loading = 'lazy';

    img.onload = () => {
      container.classList.remove('loading');

      // 根据图片实际宽度调整容器大小类
      if (img.naturalWidth > this.renderer.imageWidthThreshold) {
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
