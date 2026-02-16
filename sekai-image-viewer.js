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
    this.maxScale = 8;
    this.scaleStep = 0.2;

    this.idleTimer = null;
    this.idleDelay = 3000;
    
    this.wheelTimer = null;
    
    // Smooth zoom state
    this.targetScale = 1;
    this.isZooming = false;

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
      
      <button class="sekai-viewer-close-fixed" title="关闭 (ESC)">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>

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
    this.fixedCloseBtn = viewer.querySelector('.sekai-viewer-close-fixed');
  }

  bindEvents() {
    this.boundResetIdle = this.resetIdle.bind(this);
    
    // Fixed close button
    this.fixedCloseBtn.addEventListener('click', () => this.close());

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
        case 'r': case 'R':
          if (e.shiftKey) {
            this.rotateCounterClockwise();
          } else {
            this.rotate();
          }
          break;
        case ' ': e.preventDefault(); this.reset(); break;
        case 'd': case 'D': this.download(); break;
      }
    });

    this.container.addEventListener('wheel', (e) => {
      if (!this.isOpen) return;
      e.preventDefault();

      // Smoother exponential zoom based on delta
      // Smaller factor for smoother control. e.deltaY is usually +-100 or +-53
      const zoomFactor = Math.exp(-e.deltaY * 0.001);

      const newScale = this.scale * zoomFactor;

      // Clamp to min/max before calculating translation
      const clampedScale = Math.max(this.minScale, Math.min(this.maxScale, newScale));

      // Only adjust translation if scale actually changed
      if (clampedScale !== this.scale) {
        // Calculate scaling relative to cursor position
        const rect = this.container.getBoundingClientRect();
        const offsetX = e.clientX - rect.left - rect.width / 2;
        const offsetY = e.clientY - rect.top - rect.height / 2;

        // Adjust translation to zoom towards cursor
        // Formula: newTrans = oldTrans + (cursorOffset - oldTrans) * (1 - zoomFactor)
        // This keeps the point under cursor stable
        const actualZoomFactor = clampedScale / this.scale;
        this.translateX += (offsetX - this.translateX) * (1 - actualZoomFactor);
        this.translateY += (offsetY - this.translateY) * (1 - actualZoomFactor);
      }

      this.setScale(clampedScale);

      // Force immediate update without transition for wheel to feel instant/snappy
      this.image.style.transition = 'none';
      this.updateTransform();

      // Debounce re-enabling transition
      clearTimeout(this.wheelTimer);
      this.wheelTimer = setTimeout(() => {
          this.image.style.transition = 'transform 0.2s cubic-bezier(0.19, 1, 0.22, 1)';
      }, 100);

    }, { passive: false });

    // Drag to pan
    this.container.addEventListener('mousedown', (e) => {
      if (this.scale <= 1) return; // Only drag when zoomed
      
      this.isDragging = true;
      this.dragStartX = e.clientX - this.translateX;
      this.dragStartY = e.clientY - this.translateY;
      
      this.image.style.cursor = 'grabbing';
      this.image.style.transition = 'none'; // Disable transition for instant drag response
      e.preventDefault();
    });

    // Window mousemove to handle dragging outside container
    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      e.preventDefault();

      this.translateX = e.clientX - this.dragStartX;
      this.translateY = e.clientY - this.dragStartY;
      
      this.image.style.transform = 
        `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale}) rotate(${this.rotation}deg)`;
    });

    window.addEventListener('mouseup', () => {
      if (this.isDragging) {
        this.isDragging = false;
        this.image.style.cursor = this.scale > 1 ? 'grab' : 'default';
        this.image.style.transition = 'transform 0.2s cubic-bezier(0.19, 1, 0.22, 1)'; // Restore transition
      }
    });

    // Double tap/click handler
    const handleDoubleAction = (e) => {
      e.stopPropagation(); // Prevent bubbling issues
      
      if (this.scale > 1.1) { // Fuzzy compare against 1
        this.reset(); // Reset to fit
      } else {
        this.setScale(2.5); // Zoom to 2.5x
      }
    };

    // Double click (Desktop)
    this.container.addEventListener('dblclick', (e) => {
      if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
      handleDoubleAction(e);
    });

    // Touch gestures (Pinch Zoom + Pan/Drag + Double Tap)
    let touchStartDistance = 0;
    let touchStartScale = 1;
    let lastTouchScale = 1; // Track last scale to calculate incremental zoom
    let isPinching = false;
    let isTouchDragging = false;
    let touchDragStartX = 0;
    let touchDragStartY = 0;
    let lastTap = 0;
    let lastPinchEnd = -1000; // Initialize to old time to allow initial taps

    this.container.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        // Two-finger pinch zoom
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        touchStartDistance = Math.sqrt(dx * dx + dy * dy);
        touchStartScale = this.scale;
        lastTouchScale = this.scale; // Initialize for incremental calculation

        isPinching = true;
        isTouchDragging = false; // Cancel any drag

        // Disable transition for smooth pinch
        this.image.style.transition = 'none';
      } else if (e.touches.length === 1 && this.scale > 1) {
        // Single-finger drag when zoomed
        isTouchDragging = true;
        touchDragStartX = e.touches[0].clientX - this.translateX;
        touchDragStartY = e.touches[0].clientY - this.translateY;

        // Disable transition for smooth drag
        this.image.style.transition = 'none';
      }
    }, { passive: false });

    this.container.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && isPinching) {
        // Two-finger pinch zoom
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const scaleDelta = distance / touchStartDistance;
        const newScale = touchStartScale * scaleDelta;

        // Clamp scale
        const clampedScale = Math.max(this.minScale, Math.min(this.maxScale, newScale));

        // Calculate center point between two fingers (for this frame)
        const rect = this.container.getBoundingClientRect();
        const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left - rect.width / 2;
        const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top - rect.height / 2;

        // Adjust translation incrementally to zoom towards touch center
        // Formula: newTrans = oldTrans + (center - oldTrans) * (1 - zoomFactor)
        // This keeps the point under fingers stable
        const zoomFactor = clampedScale / lastTouchScale;
        this.translateX += (centerX - this.translateX) * (1 - zoomFactor);
        this.translateY += (centerY - this.translateY) * (1 - zoomFactor);

        this.scale = clampedScale;
        lastTouchScale = clampedScale; // Update for next frame

        // Reset translation if zooming out to 1x
        if (this.scale <= 1) {
          this.translateX = 0;
          this.translateY = 0;
        }

        // Update transform immediately
        this.image.style.transform =
          `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale}) rotate(${this.rotation}deg)`;
        this.scaleText.textContent = `${Math.round(this.scale * 100)}%`;
        this.image.style.cursor = this.scale > 1 ? 'grab' : 'default';
      } else if (isPinching && e.touches.length < 2) {
        // One finger lifted during pinch - end pinch immediately
        isPinching = false;
        lastPinchEnd = Date.now();

        // Re-enable transition
        this.image.style.transition = 'transform 0.2s cubic-bezier(0.19, 1, 0.22, 1)';

        // Persist the scale
        touchStartScale = this.scale;
      } else if (e.touches.length === 1 && isTouchDragging && this.scale > 1) {
        // Single-finger drag
        e.preventDefault();
        this.translateX = e.touches[0].clientX - touchDragStartX;
        this.translateY = e.touches[0].clientY - touchDragStartY;

        this.image.style.transform =
          `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale}) rotate(${this.rotation}deg)`;
      }
    }, { passive: false });

    this.container.addEventListener('touchend', (e) => {
      // Handle pinch end
      if (isPinching) {
        isPinching = false;
        lastPinchEnd = Date.now();

        // Re-enable transition
        this.image.style.transition = 'transform 0.2s cubic-bezier(0.19, 1, 0.22, 1)';

        // Update the final scale - this persists the zoom level
        touchStartScale = this.scale;
        return;
      }

      // Handle drag end
      if (isTouchDragging) {
        isTouchDragging = false;

        // Re-enable transition
        this.image.style.transition = 'transform 0.2s cubic-bezier(0.19, 1, 0.22, 1)';

        // If no remaining touches, allow double tap detection
        if (e.touches.length === 0) {
          // Continue to double tap detection below
        } else {
          return;
        }
      }

      // Double tap detection - only for single-finger taps
      // e.touches.length === 0 means all fingers are now off the screen
      if (e.touches.length === 0) {
        const currentTime = Date.now();
        const timeSincePinch = currentTime - lastPinchEnd;
        const tapLength = currentTime - lastTap;

        // Only process if no recent pinch (within 300ms) and within double tap window
        if (timeSincePinch > 300 && tapLength < 300 && tapLength > 0) {
          if (e.target.tagName !== 'BUTTON' && !e.target.closest('button')) {
            handleDoubleAction(e);
          }
        }
        lastTap = currentTime;
      }
    });
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

    // Initial idle reset
    this.resetIdle();

    // Add activity listeners
    window.addEventListener('mousemove', this.boundResetIdle);
    window.addEventListener('touchstart', this.boundResetIdle);
    window.addEventListener('keydown', this.boundResetIdle);
    this.viewer.addEventListener('click', this.boundResetIdle);

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
    this.viewer.classList.remove('ui-hidden');
    clearTimeout(this.idleTimer);
    
    window.removeEventListener('mousemove', this.boundResetIdle);
    window.removeEventListener('touchstart', this.boundResetIdle);
    window.removeEventListener('keydown', this.boundResetIdle);
    this.viewer.removeEventListener('click', this.boundResetIdle);

    document.body.style.overflow = '';
    this.image.src = '';
    this.reset();
  }

  resetIdle() {
    if (!this.isOpen) return;
    this.viewer.classList.remove('ui-hidden');
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // Don't hide if dragging or hovering toolbar (optional, but good UX)
      if (this.isOpen && !this.isDragging) {
        this.viewer.classList.add('ui-hidden');
      }
    }, this.idleDelay);
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

  rotateCounterClockwise() {
    this.rotation = (this.rotation - 90 + 360) % 360;
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

    // Only update transition if not dragging
    if (!this.isDragging) {
      this.image.style.transition = 'transform 0.2s cubic-bezier(0.19, 1, 0.22, 1)';
    }

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
