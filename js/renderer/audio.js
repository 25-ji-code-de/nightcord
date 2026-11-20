/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** SekaiAudioRenderer: audioRenderer component; renderer supplies shared presentation context. */
class SekaiAudioRenderer {
  constructor(renderer) { this.renderer = renderer; }

  renderAudio(url, duration) {
    const container = document.createElement('div');
    container.className = 'sekai-audio-player-simple';

    const audio = this.renderer._createAudioElement(url);
    const ICONS = this.renderer._getAudioIcons(16);

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
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

    const { canvas: visualizerCanvas, ctx, width, height, gradient } = this.renderer._createOscilloscope(200, 20);
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
    let lastDrawTime = 0;
    let lastIndicatorUpdate = 0;

    const setupAudioContext = () => {
      if (analysisContext) return;
      analysisContext = this.renderer._setupAudioAnalysis(audio, AUDIO_VIZ_CONFIG.OSCILLOSCOPE.FFT_SIZE);
    };

    const updateVisualizer = (timestamp = 0) => {
      if (!analysisContext) return;

      const { analyser, dataArray } = analysisContext;
      const cfg = AUDIO_VIZ_CONFIG.OSCILLOSCOPE;
      const drawInterval = 1000 / cfg.DRAW_FPS;

      // Throttle drawing to target FPS
      if (timestamp - lastDrawTime < drawInterval) {
        if (!audio.paused) {
          animationId = requestAnimationFrame(updateVisualizer);
        }
        return;
      }
      lastDrawTime = timestamp;

      // Get Time Domain Data (Waveform)
      analyser.getByteTimeDomainData(dataArray);

      // Clear with transparency for "Afterglow" effect
      ctx.fillStyle = cfg.BG_COLOR_PLAYING;
      ctx.fillRect(0, 0, width, height);

      // Use cached gradient
      ctx.lineWidth = cfg.LINE_WIDTH;
      ctx.strokeStyle = gradient;
      ctx.beginPath();

      const sliceWidth = width / dataArray.length;
      let x = 0;

      // RMS calculation with sampling for performance
      let sumSquares = 0;
      let sampleCount = 0;
      const sampleRate = cfg.RMS_SAMPLE_RATE;

      for(let i = 0; i < dataArray.length; i++) {
        const v = dataArray[i] / 128.0;
        const y = v * height / 2;

        if(i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }

        x += sliceWidth;

        // Sample every Nth point for RMS
        if (i % sampleRate === 0) {
          const amplitude = (dataArray[i] - 128) / 128;
          sumSquares += amplitude * amplitude;
          sampleCount++;
        }
      }

      ctx.lineTo(width, height / 2);
      ctx.stroke();

      // RMS-based indicator pulsing (throttled DOM updates)
      if (timestamp - lastIndicatorUpdate > AUDIO_VIZ_CONFIG.INDICATOR.UPDATE_THROTTLE) {
        const rms = Math.sqrt(sumSquares / sampleCount);
        const indicatorCfg = AUDIO_VIZ_CONFIG.INDICATOR;

        // Skip update if audio is silent
        if (rms > 0.005) {
          const pulseScale = 1 + (rms * indicatorCfg.RMS_SCALE);
          const pulseOpacity = indicatorCfg.BASE_OPACITY + (rms * 2);
          const glowSpread = indicatorCfg.GLOW_BASE + (rms * indicatorCfg.GLOW_SCALE);

          // Batch DOM updates with cssText
          indicator.style.cssText = `
            transform: scale(${Math.min(indicatorCfg.MAX_SCALE, pulseScale)});
            opacity: ${Math.min(1, pulseOpacity)};
            box-shadow: 0 0 ${glowSpread}px ${indicatorCfg.ACCENT_COLOR};
          `;
        }

        lastIndicatorUpdate = timestamp;
      }

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

            this.renderer._resetOscilloscope(ctx, width, height);

            if (animationId) {
              cancelAnimationFrame(animationId);
              animationId = null;
            }
        }
    };

    playBtn.onclick = async () => {
        if (audio.paused) {
            try {
                await audio.play();
            } catch {
                updatePlayState(false);
                timeDisplay.textContent = '无法播放，点击重试';
            }
        } else {
            audio.pause();
        }
    };

    audio.onplay = () => updatePlayState(true);
    audio.onpause = () => updatePlayState(false);
    audio.onerror = () => { updatePlayState(false); timeDisplay.textContent = '无法播放，点击重试'; };

    audio.ontimeupdate = () => {
      const current = audio.currentTime;
      const total = audio.duration || 0;

      if (total > 0) {
        progressFill.style.width = `${(current / total) * 100}%`;
        progressBar.setAttribute('aria-valuenow', String(Math.round((current / total) * 100)));
        timeDisplay.textContent = `${this.renderer._formatTime(current)} / ${this.renderer._formatTime(total)}`;
      }
    };

    this.renderer._bindAudioSlider(progressBar, {
      label: '播放进度',
      value: () => Number.isFinite(audio.duration) && audio.duration > 0 ? audio.currentTime / audio.duration : 0,
      input: ratio => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          audio.currentTime = ratio * audio.duration;
          audio.ontimeupdate();
        }
      }
    });

    audio.onended = () => {
        updatePlayState(false);
        progressFill.style.width = '0%';
        audio.currentTime = 0;

        progressBar.setAttribute('aria-valuenow', '0');
    };

    container.appendChild(audio);
    container.appendChild(playBtn);
    container.appendChild(contentArea);

    return container;
  }
}
