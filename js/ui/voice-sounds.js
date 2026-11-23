/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** Entry and voice audio feedback; it does not control room or call state. */
class VoiceSounds {
  constructor(eventBus, getPreferences = () => ({})) {
    this.getPreferences = getPreferences;
    // 语音聊天加入、退出音效（优先 Opus，回退 MP3）
    const canOpus = new Audio().canPlayType('audio/ogg; codecs=opus');
    const ext = canOpus ? 'opus' : 'mp3';
    this.sounds = {
      enter: new Audio(`se_nightcord_enter.${ext}`),
      join: new Audio(`se_cord.${ext}?v=2`),
      quit: new Audio(`se_dcord.${ext}?v=2`)
    };
    const playSound = name => {
      const prefs = this.getPreferences();
      if (prefs.effects === false || prefs.pausedUntil > Date.now()) return;
      const audio = this.sounds[name].cloneNode();
      audio.volume = prefs.volume ?? 1;
      audio.play().catch(() => {});
    };
    // voiceJoined：本地上一次是否处于语音通话中，用于判断“刚加入”或“刚退出”。
    let voiceJoined = false;
    let voiceMembers = new Set();
    this.unsubscribe = eventBus.on('voice:changed', state => {
      // Keep the notification path tolerant of partial state updates. Voice
      // state is internal today, but a transient teardown or an older caller
      // may omit the member snapshot; that must not poison the event bus.
      if (!state || typeof state !== 'object' || typeof state.joined !== 'boolean') return;
      if (state.joined && !Array.isArray(state.members)) return;
      const joined = state.joined;
      const members = Array.isArray(state.members) ? state.members : [];
      // joined：这次事件上报时，本地当前是否处于语音通话中。
      const memberIds = new Set(members.map(member => member?.memberId).filter(Boolean));
      // joined 与 voiceJoined 不同时，说明状态刚刚发生了加入/退出变化。
      if (joined !== voiceJoined) {
        playSound(joined ? 'join' : 'quit');
      } else if (joined) {
        // 仅在通话中提示成员进出，重复快照和麦克风状态更新保持安静。
        if ([...memberIds].some(id => !voiceMembers.has(id))) playSound('join');
        if ([...voiceMembers].some(id => !memberIds.has(id))) playSound('quit');
      }
      voiceJoined = joined;
      voiceMembers = memberIds;
    });
    this.removeEntrySound = this.bindEntrySound(eventBus);
  }

  bindEntrySound(eventBus) {
    let roomReady = false;
    let attempt = null;
    const gestures = ['click', 'keydown'];
    const stopWaiting = () => {
      for (const event of gestures) document.removeEventListener(event, retry, true);
    };
    const play = () => {
      if (!attempt || attempt.started) return;
      const prefs = this.getPreferences();
      if (prefs.effects === false || prefs.pausedUntil > Date.now()) { reset(); return; }
      const current = attempt;
      current.audio.volume = prefs.volume ?? 1;
      current.started = true;
      stopWaiting();
      current.audio.play().catch(error => {
        // A late rejection must not rearm a cue from a room we already left.
        if (attempt !== current) return;
        if (error.name === 'NotAllowedError') {
          current.started = false;
          for (const event of gestures) document.addEventListener(event, retry, true);
        }
      });
    };
    const retry = event => {
      // Call play synchronously inside the first real tap or key press.
      if (event.isTrusted) play();
    };
    const reset = () => {
      roomReady = false;
      const previous = attempt;
      attempt = null;
      stopWaiting();
      previous?.audio.pause();
    };
    const unsubscribers = [
      eventBus.on('room:ready', () => {
        if (roomReady) return;
        roomReady = true;
        attempt = { audio: this.sounds.enter.cloneNode(), started: false };
        play();
      }),
      // room:synced also fires on reconnect; only an explicit join gets a cue.
      eventBus.on('room:joining', reset),
      eventBus.on('room:left', reset)
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      reset();
    };
  }

  destroy() {
    this.unsubscribe();
    this.removeEntrySound();
  }
}
