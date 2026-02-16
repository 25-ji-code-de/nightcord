/**
 * SEKAI Image Viewer - Lightweight image preview component
 *
 * Features:
 * - Full-screen preview
 * - Zoom in/out (mouse wheel + buttons)
 * - Rotate (90° increments)
 * - Pan/drag when zoomed
 * - Download image
 * - Keyboard shortcuts
 * - Touch gestures (pinch zoom)
 */

class SekaiImageViewer {
  constructor() {
    this.isOpen = false;
    this.currentImage = null;
    this.scale = 1;
    this.rotation = 0;
    this.translateX = 0;
    this.translateY = 0;
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;

    this.minScale = 0.1;
    this.maxScale = 5;
    this.scaleStep = 0.2;

    this.createViewer();
    this.bindEvents();
  }

  createViewer() {
    const viewer = document.createElement('div');
    viewer.className = 'sekai-image-viewer';
    viewer.innerHTML = `
      <div class="sekai-viewer-backdrop"></div>
      <div class="sekai-viewer-container">
        <img class="sekai-viewer-image" alt="Preview">
        <div class="sekai-viewer-loading">
          <div class="sekai-spinner"></div>
        </div>
      </div>
      <div class="sekai-viewer-toolbar">
        <button class="sekai-viewer-btn" data-action="zoom-out" title="缩小 (Scroll Down)">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"></circle>
            <path d="m21 21-4.35-4.35"></path>
            <line x1="8" y1="11" x2="14" y2="11"></line>
          </svg>
        </button>
        <span class="sekai-viewer-scale">100%</span>
        <button class="sekai-viewer-btn" data-action="zoom-in" title="放大 (Scroll Up)">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"></circle>
            <path d="m21 21-4.35-4.35"></path>
            <line x1="11" y1="8" x2="11" y2="14"></line>
            <line x1="8" y1="11" x2="14" y2="11"></line>
          </svg>
        </button>
        <button class="sekai-viewer-btn" data-action="rotate" title="旋转 (R)">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"></path>
          </svg>
        </button>
        <button class="sekai-viewer-btn" data-action="reset" title="重置 (Space)">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
            <path d="M3 3v5h5"></path>
          </svg>
        </button>
        <button class="sekai-viewer-btn" data-action="download" title="下载 (D)">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
        </button>
        <button class="sekai-viewer-btn" data-action="close" title="关闭 (ESC)">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      <div class="sekai-viewer-info">
        <span class="sekai-viewer-filename"></span>
      </div>
    `;

    document.body.appendChild(viewer);
    this.viewer = viewer;
    this.backdrop = viewer.querySelector('.sekai-viewer-backdrop');
    this.container = viewer.querySelector('.sekai-viewer-container');
    this.image = viewer.querySelector('.sekai-viewer-image');
    this.loading = viewer.querySelector('.sekai-viewer-loading');
    this.toolbar = viewer.querySelector('.sekai-viewer-toolbar');
    this.scaleText = viewer.querySelector('.sekai-viewer-scale');
    this.filenameText = viewer.querySelector('.sekai-viewer-filename');
  }

  bindEvents() {
    // Toolbar buttons
    this.toolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('.sekai-viewer-btn');
      if (!btn) return;

      const action = btn.dataset.action;
      switch (action) {
        case 'zoom-in': this.zoomIn(); break;
        case 'zoom-out': this.zoomOut(); break;
        case 'rotate': this.rotate(); break;
        case 'reset': this.reset(); break;
        case 'download': this.download(); break;
        case 'close': this.close(); break;
      }
    });

    // Backdrop click to close
    this.backdrop.addEventListener('click', () => this.close());

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;

      switch (e.key) {
        case 'Escape': this.close(); break;
        case '+': case '=': this.zoomIn(); break;
        case '-': case '_': this.zoomOut(); break;
        case 'r': case 'R': this.rotate(); break;
        case ' ': e.preventDefault(); this.reset(); break;
        case 'd': case 'D': this.download(); break;
      }
    });

    // Mouse wheel zoom
    this.container.addEventListener('wheel', (e) => {
      if (!this.isOpen) return;
      e.preventDefault();

      if (e.deltaY < 0) {
        this.zoomIn();
      } else {
        this.zoomOut();
      }
    }, { passive: false });

    // Drag to pan (when zoomed)
    this.image.addEventListener('mousedown', (e) => {
      if (this.scale <= 1) return;

      this.isDragging = true;
      this.dragStartX = e.clientX - this.translateX;
      this.dragStartY = e.clientY - this.translateY;
      this.image.style.cursor = 'grabbing';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;

      this.translateX = e.clientX - this.dragStartX;
      this.translateY = e.clientY - this.dragStartY;
      this.updateTransform();
    });

    document.addEventListener('mouseup', () => {
      if (this.isDragging) {
        this.isDragging = false;
        this.image.style.cursor = this.scale > 1 ? 'grab' : 'default';
      }
    });

    // Double click to toggle zoom
    this.image.addEventListener('dblclick', () => {
      if (this.scale === 1) {
        this.scale = 2;
      } else {
        this.scale = 1;
        this.translateX = 0;
        this.translateY = 0;
      }
      this.updateTransform();
    });

    // Touch gestures (basic pinch zoom)
    let touchStartDistance = 0;
    let touchStartScale = 1;

    this.container.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        touchStartDistance = Math.sqrt(dx * dx + dy * dy);
        touchStartScale = this.scale;
      }
    });

    this.container.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const scaleDelta = distance / touchStartDistance;
        this.setScale(touchStartScale * scaleDelta);
      }
    }, { passive: false });
  }

  open(imageSrc, filename = '') {
    this.currentImage = imageSrc;
    this.isOpen = true;
    this.reset();

    this.viewer.classList.add('active');
    this.loading.style.display = 'flex';
    this.image.style.opacity = '0';
    document.body.style.overflow = 'hidden';

    // Set filename
    this.filenameText.textContent = filename || this.getFilenameFromUrl(imageSrc);

    // Load image
    this.image.src = imageSrc;
    this.image.onload = () => {
      this.loading.style.display = 'none';
      this.image.style.opacity = '1';
    };
  }

  close() {
    this.isOpen = false;
    this.viewer.classList.remove('active');
    document.body.style.overflow = '';
    this.image.src = '';
    this.reset();
  }

  zoomIn() {
    this.setScale(this.scale + this.scaleStep);
  }

  zoomOut() {
    this.setScale(this.scale - this.scaleStep);
  }

  setScale(newScale) {
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, newScale));

    // Reset translation if zooming out to 1x
    if (this.scale <= 1) {
      this.translateX = 0;
      this.translateY = 0;
    }

    this.updateTransform();
  }

  rotate() {
    this.rotation = (this.rotation + 90) % 360;
    this.updateTransform();
  }

  reset() {
    this.scale = 1;
    this.rotation = 0;
    this.translateX = 0;
    this.translateY = 0;
    this.updateTransform();
  }

  updateTransform() {
    this.image.style.transform =
      `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale}) rotate(${this.rotation}deg)`;

    this.scaleText.textContent = `${Math.round(this.scale * 100)}%`;
    this.image.style.cursor = this.scale > 1 ? 'grab' : 'default';
  }

  download() {
    if (!this.currentImage) return;

    const filename = this.filenameText.textContent || 'image.jpg';

    // Try to download using fetch (works for same-origin or CORS-enabled images)
    fetch(this.currentImage)
      .then(res => res.blob())
      .then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch(() => {
        // Fallback: open in new tab
        window.open(this.currentImage, '_blank');
      });
  }

  getFilenameFromUrl(url) {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      return pathname.split('/').pop() || 'image.jpg';
    } catch {
      return 'image.jpg';
    }
  }
}

// Create global instance
window.sekaiImageViewer = new SekaiImageViewer();
