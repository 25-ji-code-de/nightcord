/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** SekaiMusicRenderer: musicRenderer component; renderer supplies shared presentation context. */
class SekaiMusicRenderer {
  constructor(renderer) { this.renderer = renderer; }

  renderMusic(url, title, artist, duration) {
    const container = document.createElement('div');
    container.className = 'sekai-audio-player';

    const audio = this.renderer._createAudioElement(url);
    const ICONS = this.renderer._getAudioIcons(14);

    // --- Container Structure (Hybrid: Walkman x DAW x Console) ---
    // [ [Fader (Vol)] ] - Left Module (Console Style)
    // [ [Screen Window (Waveform + Tape + Time)] ] - Center Module (DAW + Reel)
    // [ [Transport Keys (Mechanical)] ] - Right Module (Walkman Style)

    // 1. Console Module (Vertical Volume Fader)
    const auxModule = document.createElement('div');
    auxModule.className = 'sekai-console-module';

    // Fader Scale
    const faderScale = document.createElement('div');
    faderScale.className = 'sekai-fader-scale';
    for(let i=0; i<5; i++) {
       const tick = document.createElement('div');
       tick.className = 'sekai-fader-tick' + (i%2===0 ? ' major' : '');
       faderScale.appendChild(tick);
    }
    auxModule.appendChild(faderScale);

    const faderTrack = document.createElement('div');
    faderTrack.className = 'sekai-fader-track';

    const faderCap = document.createElement('div');
    faderCap.className = 'sekai-fader-cap';
    faderCap.title = 'Volume';
    faderCap.style.top = '20%'; // Default 80% volume
    audio.volume = 0.8;

    faderTrack.appendChild(faderCap);
    auxModule.appendChild(faderTrack);

    // 2. Main Screen Module (DAW + Tape Hybrid)
    const content = document.createElement('div');
    content.className = 'sekai-audio-content';

    // Top Row: Meta Info & Track Details
    const metaRow = document.createElement('div');
    metaRow.className = 'sekai-screen-meta';

    // Status Box (LED + STEREO)
    const statusBox = document.createElement('div');
    statusBox.className = 'sekai-status-indicator';
    statusBox.innerHTML = `
        <div class="sekai-led"></div>
        <span class="sekai-status-text">STEREO</span>
    `;

    // Track Info (Title - Artist)
    const trackInfo = document.createElement('div');
    trackInfo.className = 'sekai-track-info';
    trackInfo.innerHTML = `
        <div class="sekai-track-title">${this.renderer._escapeHTML(title)}</div>
        <div class="sekai-track-artist">${this.renderer._escapeHTML(artist)}</div>
    `;

    const timeDisplay = document.createElement('div');
    timeDisplay.className = 'sekai-audio-time';
    timeDisplay.textContent = '0:00 / ' + (duration || '-:--');

    metaRow.appendChild(statusBox);
    metaRow.appendChild(trackInfo);
    metaRow.appendChild(timeDisplay);

    // Center: Visualizer Area (Reels + Bars)
    const vizArea = document.createElement('div');
    vizArea.className = 'sekai-viz-area';

    // Tape Mechanism (Background)
    const tapeMech = document.createElement('div');
    tapeMech.className = 'sekai-tape-mechanism';
    tapeMech.innerHTML = `<div class="sekai-reel"></div><div class="sekai-reel"></div>`;
    vizArea.appendChild(tapeMech);

    // Waveform Bars (Foreground) - Use helper method
    const { container: visualizer, bars } = this.renderer._createVisualizerBars(32, 'sekai-viz-bar');
    visualizer.className = 'sekai-audio-visualizer-bars';
    // Randomize initial height for "static" look
    bars.forEach(bar => {
        bar.style.transform = `scaleY(${0.1 + Math.random() * 0.2})`;
    });
    vizArea.appendChild(visualizer);

    // Bottom: Scrubber
    const scrubber = document.createElement('div');
    scrubber.className = 'sekai-tape-scrubber';

    // Buffered progress (background)
    const bufferedFill = document.createElement('div');
    bufferedFill.className = 'sekai-scrub-buffered';

    const progressFill = document.createElement('div');
    progressFill.className = 'sekai-scrub-progress';

    const scrubTime = document.createElement('div');
    scrubTime.className = 'sekai-scrub-time';
    scrubTime.textContent = ''; // Only show on hover?

    scrubber.appendChild(bufferedFill);
    scrubber.appendChild(progressFill);
    scrubber.appendChild(scrubTime);

    content.appendChild(metaRow);
    content.appendChild(vizArea);
    content.appendChild(scrubber);

    // 3. Transport Control Module (Walkman Mechanical Keys)
    const transportModule = document.createElement('div');
    transportModule.className = 'sekai-walkman-transport';

    // Helper for buttons
    const createBtn = (iconSvg, label) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sekai-transport-btn';
        btn.innerHTML = iconSvg;
        btn.setAttribute('aria-label', label);
        return btn;
    };

    const stopBtn = createBtn(ICONS.STOP, 'Stop');
    const playBtn = createBtn(ICONS.PLAY, 'Play');
    // Implement Seek -5s / +10s (Podcast Style)
    const rwBtn = createBtn(ICONS.RW, 'Rewind 5s');
    const ffBtn = createBtn(ICONS.FF, 'Fast Forward 10s');

    // Transport Layout: Play (Big), Stop, RW, FF
    transportModule.appendChild(playBtn);
    transportModule.appendChild(stopBtn);
    transportModule.appendChild(rwBtn);
    transportModule.appendChild(ffBtn);

    // Assemble
    container.appendChild(auxModule);
    container.appendChild(content);
    container.appendChild(transportModule);
    container.appendChild(audio);


    // --- Logic ---
    let isDragging = false;
    let animationId;

    // Audio Analysis Setup - Use helper method
    let analysisContext = null;

    const setupAudioAnalysis = () => {
        if (analysisContext) return;
        analysisContext = this.renderer._setupAudioAnalysis(audio, 64);
    };

    // Tape/Progress Update
    const updateTape = (progress) => {
        // progress: 0 to 1
        const pct = progress * 100;
        progressFill.style.width = `${pct}%`;
        scrubber.setAttribute('aria-valuenow', String(Math.round(pct)));

        // Update buffered progress
        if (audio.buffered.length > 0) {
            const bufferedEnd = audio.buffered.end(audio.buffered.length - 1);
            const bufferedPct = (bufferedEnd / audio.duration) * 100;
            bufferedFill.style.width = `${bufferedPct}%`;

            // Hide buffered bar if fully loaded
            if (bufferedEnd >= audio.duration - 0.1) { // Small tolerance for floating point
                bufferedFill.style.opacity = '0';
            } else {
                bufferedFill.style.opacity = '1';
            }
        }

        // Update Time Display with actual duration
        if (audio.duration && isFinite(audio.duration)) {
             timeDisplay.textContent = `${this.renderer._formatTime(audio.currentTime)} / ${this.renderer._formatTime(audio.duration)}`;
        }
    };

    const togglePlay = async () => {
      if (audio.paused) {
        try {
          await audio.play();
        } catch {
          setPlaying(false);
          timeDisplay.textContent = '无法播放，点击重试';
        }
      } else {
        audio.pause();
      }
    };

    const setPlaying = playing => {
      playBtn.innerHTML = playing ? ICONS.PAUSE : ICONS.PLAY;
      playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      playBtn.classList.toggle('active', playing);
      container.classList.toggle('playing', playing);
      statusBox.querySelector('.sekai-led').classList.toggle('active', playing);
      cancelAnimationFrame(animationId);
      if (playing) {
        if (!analysisContext) setupAudioAnalysis();
        animationId = requestAnimationFrame(animateViz);
      }
    };
    audio.onplay = () => setPlaying(true);
    audio.onpause = () => setPlaying(false);
    audio.onerror = () => { setPlaying(false); timeDisplay.textContent = '无法播放，点击重试'; };

    const animateViz = () => {
        if (audio.paused) return;

        // Real audio visualization using Web Audio API
        if (analysisContext) {
            this.renderer._updateVisualizerBars(analysisContext.analyser, analysisContext.dataArray, bars);
        } else {
            // Fallback: Fake visualization if analysis failed
            bars.forEach(bar => {
                const h = 0.1 + Math.random() * 0.8;
                bar.style.transform = `scaleY(${h})`;
            });
        }

        animationId = requestAnimationFrame(animateViz);
    }

    playBtn.onclick = (e) => {
        e.stopPropagation();
        togglePlay();
    };

    stopBtn.onclick = (e) => {
        e.stopPropagation();
        audio.pause();
        audio.currentTime = 0;
        setPlaying(false);
        updateTape(0);
        // Reset Viz
        bars.forEach(b => b.style.transform = `scaleY(0.1)`);
    };

    // Seek Logic
    const seekRelative = (seconds) => {
        if (!audio.duration) return;
        const newTime = Math.max(0, Math.min(audio.duration, audio.currentTime + seconds));
        audio.currentTime = newTime;
        updateTape(newTime / audio.duration);
    };

    rwBtn.onclick = (e) => {
        e.stopPropagation();
        seekRelative(-5);
        // Visual feedback
        rwBtn.classList.add('active');
        setTimeout(() => rwBtn.classList.remove('active'), 150);
    };

    ffBtn.onclick = (e) => {
        e.stopPropagation();
        seekRelative(10);
        // Visual feedback
        ffBtn.classList.add('active');
        setTimeout(() => ffBtn.classList.remove('active'), 150);
    };

    // Pointer capture supports mouse and touch without document listeners.
    this.renderer._bindAudioSlider(scrubber, {
      label: '播放进度',
      value: () => Number.isFinite(audio.duration) && audio.duration > 0 ? audio.currentTime / audio.duration : 0,
      input: ratio => {
        isDragging = true;
        progressFill.style.width = `${ratio * 100}%`;
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          timeDisplay.textContent = `${this.renderer._formatTime(ratio * audio.duration)} / ${this.renderer._formatTime(audio.duration)}`;
        }
      },
      commit: ratio => {
        isDragging = false;
        if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = ratio * audio.duration;
      }
    });
    const cancelScrub = () => { isDragging = false; updateTape(audio.duration ? audio.currentTime / audio.duration : 0); };
    scrubber.addEventListener('pointercancel', cancelScrub);
    scrubber.addEventListener('lostpointercapture', cancelScrub);
    const syncVolume = this.renderer._bindAudioSlider(faderTrack, {
      label: '音量', vertical: true,
      value: () => audio.volume,
      input: ratio => { audio.volume = ratio; }
    });
    audio.onvolumechange = () => { faderCap.style.top = `${(1 - audio.volume) * 100}%`; syncVolume(); };

    audio.ontimeupdate = () => {
       if (isDragging) return;
       if (audio.duration) {
           updateTape(audio.currentTime / audio.duration);
       }
    };

    audio.onended = () => {
        setPlaying(false);
        updateTape(1);
    };

    return container;
  }
}
