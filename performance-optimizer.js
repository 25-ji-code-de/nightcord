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
 * Performance Optimizer for Nightcord
 *
 * Provides performance optimizations for large message lists:
 * - Virtual scrolling for efficient DOM rendering
 * - Batch rendering with requestAnimationFrame
 * - Intersection Observer for lazy loading
 * - Throttle/Debounce utilities
 *
 * @example
 * const optimizer = new PerformanceOptimizer({
 *   container: document.getElementById('messages'),
 *   itemHeight: 80,
 *   buffer: 5
 * });
 */
class PerformanceOptimizer {
  /**
   * Throttle function - limits execution rate
   * @param {Function} func - Function to throttle
   * @param {number} wait - Minimum time between executions (ms)
   * @returns {Function} Throttled function
   */
  static throttle(func, wait) {
    let lastTime = 0;
    let timeout = null;

    return function throttled(...args) {
      const now = Date.now();
      const remaining = wait - (now - lastTime);

      if (remaining <= 0) {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        lastTime = now;
        func.apply(this, args);
      } else if (!timeout) {
        timeout = setTimeout(() => {
          lastTime = Date.now();
          timeout = null;
          func.apply(this, args);
        }, remaining);
      }
    };
  }

  /**
   * Debounce function - delays execution until after wait time
   * @param {Function} func - Function to debounce
   * @param {number} wait - Wait time in ms
   * @returns {Function} Debounced function
   */
  static debounce(func, wait) {
    let timeout = null;

    return function debounced(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  /**
   * Request Animation Frame with fallback
   * @param {Function} callback - Function to call
   * @returns {number} Request ID
   */
  static raf(callback) {
    return (window.requestAnimationFrame ||
            window.webkitRequestAnimationFrame ||
            window.mozRequestAnimationFrame ||
            function(cb) { return setTimeout(cb, 16); })(callback);
  }

  /**
   * Cancel Animation Frame with fallback
   * @param {number} id - Request ID to cancel
   */
  static cancelRaf(id) {
    (window.cancelAnimationFrame ||
     window.webkitCancelAnimationFrame ||
     window.mozCancelAnimationFrame ||
     clearTimeout)(id);
  }

  /**
   * Batch DOM operations with RAF
   * @param {Function} readOps - Read operations (measurements)
   * @param {Function} writeOps - Write operations (DOM updates)
   */
  static batchDOMOperation(readOps, writeOps) {
    // Read phase
    if (readOps) {
      const readData = readOps();

      // Write phase in next frame
      PerformanceOptimizer.raf(() => {
        if (writeOps) writeOps(readData);
      });
    } else if (writeOps) {
      PerformanceOptimizer.raf(() => writeOps());
    }
  }

  /**
   * Create intersection observer for lazy loading
   * @param {Function} callback - Callback when element becomes visible
   * @param {Object} options - IntersectionObserver options
   * @returns {IntersectionObserver} Observer instance
   */
  static createLazyObserver(callback, options = {}) {
    const defaultOptions = {
      root: null,
      rootMargin: '50px',
      threshold: 0.01
    };

    const observerOptions = { ...defaultOptions, ...options };

    if (typeof IntersectionObserver === 'undefined') {
      // Fallback: immediately execute callback for all elements
      console.warn('IntersectionObserver not supported, using fallback');
      return {
        observe: (elem) => callback([{ target: elem, isIntersecting: true }]),
        unobserve: () => {},
        disconnect: () => {}
      };
    }

    return new IntersectionObserver(callback, observerOptions);
  }

  /**
   * Batch insert elements into container
   * @param {HTMLElement} container - Target container
   * @param {Array<HTMLElement>} elements - Elements to insert
   * @param {boolean} useFragment - Use DocumentFragment (default true)
   */
  static batchInsert(container, elements, useFragment = true) {
    if (!container || !elements || elements.length === 0) return;

    PerformanceOptimizer.raf(() => {
      if (useFragment) {
        const fragment = document.createDocumentFragment();
        elements.forEach(elem => fragment.appendChild(elem));
        container.appendChild(fragment);
      } else {
        elements.forEach(elem => container.appendChild(elem));
      }
    });
  }

  /**
   * Measure DOM elements without triggering layout thrashing
   * @param {Array<HTMLElement>} elements - Elements to measure
   * @returns {Array<Object>} Measurements {width, height, top, left}
   */
  static batchMeasure(elements) {
    const measurements = [];

    // Batch all reads together to avoid layout thrashing
    elements.forEach(elem => {
      const rect = elem.getBoundingClientRect();
      measurements.push({
        width: rect.width,
        height: rect.height,
        top: rect.top,
        left: rect.left
      });
    });

    return measurements;
  }

  /**
   * Apply styles in batch to avoid layout thrashing
   * @param {Array<{element: HTMLElement, styles: Object}>} operations
   */
  static batchStyle(operations) {
    PerformanceOptimizer.raf(() => {
      operations.forEach(({ element, styles }) => {
        Object.assign(element.style, styles);
      });
    });
  }

  /**
   * Virtualized list renderer for large datasets
   * Only renders visible items + buffer
   */
  constructor(options = {}) {
    this.container = options.container;
    this.itemHeight = options.itemHeight || 80;
    this.buffer = options.buffer || 5;
    this.items = [];
    this.visibleRange = { start: 0, end: 0 };
    this.scrollTop = 0;

    if (this.container) {
      this.setupVirtualScroll();
    }
  }

  setupVirtualScroll() {
    const onScroll = PerformanceOptimizer.throttle(() => {
      this.updateVisibleRange();
    }, 16); // ~60fps

    this.container.addEventListener('scroll', onScroll, { passive: true });
  }

  updateVisibleRange() {
    const scrollTop = this.container.scrollTop;
    const containerHeight = this.container.clientHeight;

    const start = Math.max(0, Math.floor(scrollTop / this.itemHeight) - this.buffer);
    const end = Math.min(
      this.items.length,
      Math.ceil((scrollTop + containerHeight) / this.itemHeight) + this.buffer
    );

    if (start !== this.visibleRange.start || end !== this.visibleRange.end) {
      this.visibleRange = { start, end };
      this.render();
    }
  }

  render() {
    // Override in implementation
    console.log('Virtual scroll render:', this.visibleRange);
  }

  /**
   * Memory usage monitor
   */
  static getMemoryUsage() {
    if (performance.memory) {
      return {
        usedJSHeapSize: Math.round(performance.memory.usedJSHeapSize / 1048576) + ' MB',
        totalJSHeapSize: Math.round(performance.memory.totalJSHeapSize / 1048576) + ' MB',
        jsHeapSizeLimit: Math.round(performance.memory.jsHeapSizeLimit / 1048576) + ' MB'
      };
    }
    return null;
  }

  /**
   * Performance marker for debugging
   */
  static mark(name) {
    if (performance.mark) {
      performance.mark(name);
    }
  }

  /**
   * Measure performance between two marks
   */
  static measure(name, startMark, endMark) {
    if (performance.measure) {
      try {
        performance.measure(name, startMark, endMark);
        const measure = performance.getEntriesByName(name)[0];
        return measure ? measure.duration : 0;
      } catch (e) {
        console.warn('Performance measurement failed:', e);
        return 0;
      }
    }
    return 0;
  }
}

// Export for global use
window.PerformanceOptimizer = PerformanceOptimizer;
