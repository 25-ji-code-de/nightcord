/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** Owns AI context and forwarding; all dependencies are data providers or callbacks. */
class AIConversation {
  constructor({ eventBus, loadMessages, aiConfig, settings, getUser, getUsername, getRoom, ask, send }) {
    Object.assign(this, { aiConfig, settings, getUser, getRoom });
    this.messages = [];
    this.pending = new Map();
    this.clearTimestamp = this.loadNakoClearTimestamp();
    eventBus.on('room:joining', ({ roomname }) => {
      this.messages = loadMessages(roomname);
      this.pending.clear();
    });
    eventBus.on('message:received', data => this.receive(data));
    eventBus.on('nako:clear', () => {
      this.clearTimestamp = Date.now();
      this.saveNakoClearTimestamp(this.clearTimestamp);
    });
    eventBus.on('nako:ask', data => ask(data.prompt, {
      userId: getUsername() || 'Anonymous',
      history: this.getRecentHistory(15),
      persona: data.persona || 'nako'
    }));
    eventBus.on('nako:stream:end', data => {
      const message = { user: data.user, text: data.fullContent.trim(), timestamp: Date.now() };
      this.messages.push(message);
      this.pending.set(data.messageId, { message, senderId: getUser()?.id, room: getRoom() });
      send(`[${data.user}]${message.text}`);
    });
  }

  receive(data) {
    if (data.name === '系统') return;
    const exists = this.messages.some(m => m.timestamp === data.timestamp && m.user === data.name
      && m.profile?.id === data.user?.id && m.sender?.id === data.sender?.id);
    if (exists) return;
    if (data.isNako && data.sender?.id) {
      for (const [id, pending] of this.pending) {
        if (pending.room !== this.getRoom() || !this.messages.includes(pending.message)) {
          this.pending.delete(id);
          continue;
        }
        if (pending.senderId !== data.sender.id || pending.message.user !== data.name || pending.message.text !== data.message) continue;
        Object.assign(pending.message, { timestamp: data.timestamp, sender: data.sender });
        this.pending.delete(id);
        return;
      }
    }
    this.messages.push({ user: data.name, text: data.message, timestamp: data.timestamp, profile: data.user, sender: data.sender });
    this.messages = this.messages.slice(-2000);
  }

  getRecentHistory(limit = 10) {
    return this.messages
      .filter(message => message.user !== '系统' && message.timestamp > this.clearTimestamp)
      .slice(-limit)
      .map(message => ({
        userId: message.user,
        message: message.text,
        isBot: this.aiConfig.getAllDisplayNames().includes(message.user)
      }));
  }

  loadNakoClearTimestamp() {
    try {
      const timestamp = this.settings.getItem('nightcord-nako-clear-timestamp');
      return timestamp ? Number(timestamp) : 0;
    } catch { return 0; }
  }

  saveNakoClearTimestamp(timestamp) {
    try { this.settings.setItem('nightcord-nako-clear-timestamp', String(timestamp)); }
    catch (error) { console.warn('Failed to save Nako clear timestamp:', error); }
  }
}
