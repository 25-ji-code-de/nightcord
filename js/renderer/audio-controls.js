/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
// Audio Visualizer Configuration
const AUDIO_VIZ_CONFIG = {
  OSCILLOSCOPE: {
    BG_COLOR_IDLE: '#2f273f',
    BG_COLOR_PLAYING: 'rgba(53, 46, 70, 0.25)',
    LINE_COLOR: 'rgba(167, 139, 250, 1)',
    LINE_WIDTH: 1.5,
    FFT_SIZE: 2048,
    DRAW_FPS: 60, // Target framerate
    RMS_SAMPLE_RATE: 4 // Sample every Nth point for RMS
  },
  INDICATOR: {
    ACCENT_COLOR: '#ff5500',
    RMS_SCALE: 1.5,
    BASE_OPACITY: 0.6,
    GLOW_BASE: 2,
    GLOW_SCALE: 15,
    MAX_SCALE: 1.5,
    UPDATE_THROTTLE: 16 // Min ms between DOM updates (~60fps)
  }
};

/** SekaiAudioControls: audioControls component; renderer supplies shared presentation context. */
class SekaiAudioControls {
  constructor(renderer) { this.renderer = renderer; }

  /**
   * 获取全局共享的 AudioContext
   * @private
   */
  _getAudioContext() {
    if (!this.renderer.audioContext) {
      try {
        this.renderer.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        console.warn('Web Audio API not supported:', e);
        return null;
      }
    }

    // 恢复被暂停的 AudioContext
    if (this.renderer.audioContext.state === 'suspended') {
      this.renderer.audioContext.resume();
    }

    return this.renderer.audioContext;
  }

  /**
   * Common icons used in audio players
   * @private
   */
  _getAudioIcons(size = 16) {
    return {
      PLAY: `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false"><polygon points="6 4 20 12 6 20 6 4" fill="currentColor"></polygon></svg>`,
      PAUSE: `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false"><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"></rect><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"></rect></svg>`,
      STOP: `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false"><rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor"></rect></svg>`,
      RW: `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false"><polygon points="11 19 2 12 11 5 11 19" fill="currentColor"></polygon><polygon points="22 19 13 12 22 5 22 19" fill="currentColor"></polygon></svg>`,
      FF: `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false"><polygon points="13 19 22 12 13 5 13 19" fill="currentColor"></polygon><polygon points="2 19 11 12 2 5 2 19" fill="currentColor"></polygon></svg>`
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

  /** Bind a local slider without retaining detached players on document. */
  _bindAudioSlider(element, { label, value, input, commit, vertical = false }) {
    element.tabIndex = 0;
    element.setAttribute('role', 'slider');
    element.setAttribute('aria-label', label);
    element.setAttribute('aria-valuemin', '0');
    element.setAttribute('aria-valuemax', '100');
    if (vertical) element.setAttribute('aria-orientation', 'vertical');
    element.style.touchAction = 'none';
    const sync = (ratio = value()) => element.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    const update = ratio => {
      ratio = Math.max(0, Math.min(1, ratio));
      input(ratio);
      sync(ratio);
      return ratio;
    };
    const position = event => {
      const rect = element.getBoundingClientRect();
      return vertical ? 1 - (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width;
    };
    let pointer = null;
    let preview = 0;
    element.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      element.focus({ preventScroll: true });
      pointer = event.pointerId;
      element.setPointerCapture(pointer);
      preview = update(position(event));
    });
    element.addEventListener('pointermove', event => {
      if (event.pointerId === pointer) preview = update(position(event));
    });
    element.addEventListener('pointerup', event => {
      if (event.pointerId !== pointer) return;
      preview = update(position(event));
      commit?.(preview);
      pointer = null;
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    });
    const cancel = () => { pointer = null; sync(); };
    element.addEventListener('pointercancel', cancel);
    element.addEventListener('lostpointercapture', cancel);
    element.addEventListener('keydown', event => {
      const steps = { ArrowRight: 0.05, ArrowUp: 0.05, ArrowLeft: -0.05, ArrowDown: -0.05, PageUp: 0.1, PageDown: -0.1 };
      if (!(event.key in steps) && event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault();
      event.stopPropagation();
      const ratio = update(event.key === 'Home' ? 0 : event.key === 'End' ? 1 : value() + steps[event.key]);
      commit?.(ratio);
    });
    sync();
    return sync;
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

    const ctx = canvas.getContext('2d', {
      alpha: true,
      desynchronized: true // Performance hint for animations
    });
    ctx.scale(dpr, dpr);

    // Cache gradient (created once, reused)
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, 'rgba(167, 139, 250, 0)');
    gradient.addColorStop(0.1, AUDIO_VIZ_CONFIG.OSCILLOSCOPE.LINE_COLOR);
    gradient.addColorStop(0.9, AUDIO_VIZ_CONFIG.OSCILLOSCOPE.LINE_COLOR);
    gradient.addColorStop(1, 'rgba(167, 139, 250, 0)');

    // Initial State
    ctx.fillStyle = AUDIO_VIZ_CONFIG.OSCILLOSCOPE.BG_COLOR_IDLE;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = gradient;
    ctx.lineWidth = AUDIO_VIZ_CONFIG.OSCILLOSCOPE.LINE_WIDTH;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    return { canvas, ctx, width, height, gradient };
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
}
