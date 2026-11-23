/* SPDX-License-Identifier: AGPL-3.0-only */
class AlertSounds {
  constructor() {
    this.ext = new Audio().canPlayType('audio/ogg; codecs=opus') ? 'opus' : 'mp3';
    this.active = null;
    this.state = 'ready';
  }
  async play(kind, volume) {
    this.stop();
    const audio = new Audio(`se_notify_${kind}.${this.ext}?v=3`);
    audio.volume = volume;
    this.active = audio;
    try {
      await audio.play();
      if (this.active !== audio) return false;
      this.state = 'ready';
      return true;
    } catch (error) {
      if (this.active !== audio) return false;
      this.state = error.name === 'NotAllowedError' ? 'blocked' : 'failed';
      return false;
    }
  }
  stop() { this.active?.pause(); this.active = null; }
}
