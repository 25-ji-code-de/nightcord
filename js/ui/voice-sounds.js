/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** Audio feedback follows voice state; it does not control the call. */
class VoiceSounds {
  constructor(eventBus) {
    // 语音聊天加入、退出音效（优先 Opus，回退 MP3）
    const canOpus = new Audio().canPlayType('audio/ogg; codecs=opus');
    const ext = canOpus ? 'opus' : 'mp3';
    this.sounds = {
      join: new Audio(`se_cord.${ext}?v=2`),
      quit: new Audio(`se_dcord.${ext}?v=2`)
    };
    const playSound = name => this.sounds[name].cloneNode().play().catch(() => {});
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

  }
  destroy() { this.unsubscribe(); }
}
