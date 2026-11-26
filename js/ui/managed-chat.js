/* SPDX-License-Identifier: AGPL-3.0-only */
/** Adapts managed-room data to the existing chat surface. Never persists messages. */
class ManagedChatView {
  constructor(view) {
    this.view = view; this.ui = view.ui; this.manager = view.manager;
    this.info = view.button('房间信息', () => view.details(), 'chat-header-action');
    this.info.hidden = true;
    document.querySelector('.chat-header-actions').prepend(this.info);
    this.history = view.element('div', 'managed-chat-history'); this.history.hidden = true;
    this.older = view.button('加载更早消息', () => void view.attempt(() => this.manager.older()));
    this.sync = view.button('同步消息', () => void view.attempt(() => this.manager.sync()));
    this.history.append(this.older, this.sync);
    this.ui.elements.chatlog.before(this.history);
  }
  activate(id) {
    const ui = this.ui;
    if (!ui.managedChat) this.previous = { room: ui.currentRoom, userId: ui.currentUser?.id, draft: ui.elements.chatInput.value, send: ui.onSendMessage };
    ui.managedChat = this;
    ui.currentRoom = id; ui.localNakoMessages.clear();
    ui.elements.main.classList.add('managed-chat');
    document.querySelector('#voice-panel')?.hidePopover?.();
    ui.uploads.setFileUploadMenuOpen(false);
    ui.setupChatRoom(text => this.send(text));
    this.clear();
    ui.eventBus.emit('room:changed', { roomname: id, source: 'managed' });
  }
  clear() {
    const ui = this.ui;
    ui.roomVisibility = { available: false, reason: 'connecting' }; ui.alerts?.view.refreshVisibility();
    this.signature = null; this.memberSignature = null; this.rendered = []; this.hadPending = false; this.wasReady = false;
    ui.clearChatInput(); ui.autocomplete?.hideList(); ui.closeMentionPicker?.({ restoreFocus: false });
    ui.eventBus.emit('chat:cleared');
    ui.sidebarFeatures?.close(false); ui.sidebarFeatures?.content?.replaceChildren();
    ui.alerts?.reset();
    if (ui.alerts) { ui.alerts.seen.clear(); ui.alerts.unread = 0; ui.alerts.renderUnread(); }
    ui.profileUI.dialog?.close(); ui.clearNotices(); ui.clearRoster();
    ui.messages = []; ui.messageIndex.clear(); ui.messageMeta.clear();
    ui.elements.chatlog.replaceChildren(); ui.renderMessages();
    ui.sidebarFeatures?.scheduleRefresh();
    ui.mentionsReady = false; ui.isAtBottom = true;
  }
  deactivate() {
    if (this.ui.managedChat !== this) return;
    this.clear();
    const ui = this.ui;
    ui.managedChat = null; ui.currentRoom = this.previous?.room;
    ui.roomVisibility = { available: false, reason: 'disconnected' }; ui.alerts?.view.refreshVisibility();
    ui.onSendMessage = this.previous?.send;
    ui.elements.chatInput.value = this.previous?.userId === ui.currentUser?.id ? this.previous?.draft || '' : '';
    ui.elements.chatInput.disabled = false; ui.elements.chatInput.placeholder = '发送消息';
    for (const id of ['mentionBtn', 'formatBtn', 'stickerBtn']) document.getElementById(id).disabled = false;
    ui.elements.main.classList.remove('managed-chat');
    this.info.hidden = true; this.history.hidden = true;
    ui.roomView.updateHeading(); ui.setConnectionStatus('');
    ui.eventBus.emit('room:changed', { roomname: ui.currentRoom });
  }
  writable() {
    const m = this.manager;
    return this.ui.managedChat === this && m.ready && !!m.role && m.room?.status === 'active' && m.mode === 'on';
  }
  send(text) {
    if (!this.writable()) return false;
    const content = { kind: 'text', text };
    // The shared reply UI uses a room-local sequence for managed messages.
    const reply = /<\$SEKAI:Reply::(\d+)>\s*/i.exec(text);
    if (reply && this.ui.replyTargets(text).includes(Number(reply[1]))) {
      content.replyTo = Number(reply[1]);
      content.text = (text.slice(0, reply.index) + text.slice(reply.index + reply[0].length)).trim();
    }
    if (!content.text) return false;
    const code = /^\[([^\]\n]+)\]$/.exec(content.text)?.[1];
    const sticker = code && this.ui.stickerService?.getStickers().find(item => item.code === code);
    if (sticker) { content.kind = 'sticker'; content.text = sticker.category + '/' + sticker.label; }
    this.ui.clearChatInput();
    void this.manager.send(content);
    return true;
  }
  message(item, pending = false) {
    const profile = pending ? this.manager.user : item.sender;
    const message = this.ui.createMessageData(profile.displayName, item.text, item.timestamp);
    message.profile = profile;
    if (item.kind === 'sticker') {
      message.sticker = 'https://sticker.nightcord.de5.net/stickers/' + item.text.split('/').map(encodeURIComponent).join('/') + '.png';
      message.text = '';
    }
    if (item.replyTo) message.text = `<$SEKAI:Reply::${item.replyTo}> ` + message.text;
    if (pending) {
      message.delivery = item.error || '发送中…';
      if (item.error) message.retry = () => {
        if (this.writable()) { delete item.error; void this.manager.send({}, item); }
      };
    } else { message.seq = item.seq; message.replyKey = item.seq; }
    return message;
  }
  update() {
    if (this.ui.managedChat !== this) return;
    const m = this.manager, ui = this.ui;
    ui.roomVisibility = { ...m.visibilityState, available: m.ready && m.visibilityState.available };
    ui.alerts?.view.refreshVisibility();
    ui.roomView.updateHeading();
    ui.elements.chatInput.disabled = !this.writable();
    for (const id of ['mentionBtn', 'formatBtn', 'stickerBtn']) document.getElementById(id).disabled = !this.writable();
    ui.elements.chatInput.placeholder = m.room?.status === 'archived' ? '房间已归档' : m.mode !== 'on' ? '当前房间为只读模式' : '发送消息';
    ui.setConnectionStatus(m.status || (!m.ready && m.role ? '正在连接…' : ''));
    this.info.hidden = !m.room;
    this.older.hidden = !m.ready || !m.moreBefore;
    this.sync.hidden = !m.ready || Math.max(0, ...m.messages.keys()) <= m.syncedSeq;
    this.history.hidden = this.older.hidden && this.sync.hidden;
    ui.mentionsReady = m.ready;
    if (m.ready && !this.wasReady) ui.alerts?.synced();
    if (!m.ready && this.wasReady) { ui.alerts?.reset(); ui.clearNotices(); }
    const members = m.ready ? m.members : [];
    const memberSignature = JSON.stringify([members, m.online, m.ready]);
    if (memberSignature !== this.memberSignature) {
      this.memberSignature = memberSignature;
      ui.roomMembers = new Map(members.map(profile => [profile.id, profile]));
      ui.roster = members.filter(profile => m.online?.includes(profile.id)).map(profile => ({ ...ui.generateAvatar(profile.displayName), profile }));
      ui.voiceMembers.clear(); ui.renderVoiceUsers();
    }
    const messages = m.ready && m.role ? [...m.messages.values()].sort((a, b) => a.seq - b.seq) : [];
    const pending = m.ready && m.role ? [...m.pending.values()] : [];
    const signature = JSON.stringify([messages, pending]);
    if (signature !== this.signature) {
      this.signature = signature;
      const latest = this.rendered.at(-1)?.seq || 0;
      const append = !pending.length && !this.hadPending && ui.messages.length === this.rendered.length
        && messages.length >= this.rendered.length && this.rendered.every((item, index) => item === messages[index]);
      if (append) {
        for (const item of messages.slice(this.rendered.length)) {
          const message = this.message(item); ui.messages.push(message); ui.appendMessageToDOM(message);
        }
      } else {
        ui.messages = [...messages.map(item => this.message(item)), ...pending.map(item => this.message(item, true))];
        ui.renderMessages();
      }
      this.rendered = messages; this.hadPending = !!pending.length;
      if (!messages.length && !pending.length) {
        ui.elements.chatlog.replaceChildren(); ui.messageIndex.clear(); ui.messageMeta.clear();
      }
      ui.sidebarFeatures?.scheduleRefresh();
      if (this.wasReady && m.ready) for (const item of messages.filter(item => item.seq > latest)) {
        const message = this.message(item);
        ui.alerts?.receive({ name: message.user, user: message.profile, message: message.text, timestamp: message.timestamp });
      }
    }
    this.wasReady = m.ready;
  }
  destroy() { this.deactivate(); this.info.remove(); this.history.remove(); }
}
