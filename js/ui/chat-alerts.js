/* SPDX-License-Identifier: AGPL-3.0-only */
/** Coordinates chat feedback; message classification is shared with the inbox. */
class ChatAlerts {
  constructor(ui) {
    this.ui = ui;
    this.classifier = new MessageAlerts(ui.mentions, ui.replyTargets ? text => ui.replyTargets(text) : undefined);
    this.preferences = new AlertPreferences(() => ({ room: ui.currentRoom, userId: ui.currentUser?.id }));
    this.sounds = new AlertSounds();
    this.banner = new AlertBanner(this);
    this.scope = this.preferences.key();
    this.seen = new Set(); this.presence = new Map(); this.transitions = new Map();
    this.recent = []; this.unread = 0; this.generation = 0; this.lastSound = 0;
    this.delivery = new AlertDelivery(() => ({ scope: this.preferences.key(), viewing: this.viewing() }));
    this.view = new AlertSettingsView(this);
    const bus = ui.eventBus;
    this.off = [
      ...['roster:clear', 'connection:close', 'room:left', 'room:joining', 'session:unavailable', 'auth:required', 'guest:required'].map(event => bus.on(event, () => this.reset())),
      bus.on('session:updated', () => { if (this.scope !== this.preferences.key()) this.reset(); }),
      bus.on('room:changed', () => this.reset()),
      bus.on('room:synced', () => this.synced()), bus.on('room:ready', () => this.synced()),
      bus.on('user:joined', data => this.member(data.user?.id, data.username, true)),
      bus.on('user:quit', data => this.member(data.userId, data.username, false))
    ];
    this.attention = () => {
      if (this.viewing()) {
        this.unread = 0; this.renderUnread();
        if (this.banner.kindName === 'message' && this.preferences.read().messageNotice !== 'always'
          && !this.banner.node?.contains(document.activeElement)) this.banner.dismiss();
      }
      this.delivery.announce();
    };
    for (const event of ['focus', 'blur']) window.addEventListener(event, this.attention);
    document.addEventListener('visibilitychange', this.attention);
    document.addEventListener('focusin', this.attention);
    ui.elements.chatlog?.addEventListener('scroll', this.attention, { passive: true });
    this.storageChanged = event => {
      if (event.key !== null && event.key !== this.preferences.key()) return;
      this.preferences.invalidate(event.key); this.settingsChanged(); this.view.refresh();
    };
    window.addEventListener('storage', this.storageChanged);
  }
  viewing() {
    return !document.hidden && document.hasFocus() && this.ui.isAtBottom
      && !this.ui.elements.main?.classList.contains('tool-view') && !document.querySelector('dialog[open]');
  }
  reasons(message, lookup) {
    return this.classifier.classify(message, this.ui.currentUser,
      lookup || (ts => this.ui.messages.find(item => Number(item.timestamp) === ts)));
  }
  paused(prefs = this.preferences.read()) { return prefs.pausedUntil > Date.now(); }
  reset() {
    this.ready = false; this.generation++;
    for (const transition of this.transitions.values()) clearTimeout(transition.timer);
    this.transitions.clear(); this.presence.clear();
    this.sounds.stop(); this.dismiss();
    const scope = this.preferences.key();
    if (scope !== this.scope) {
      this.scope = scope; this.seen.clear(); this.recent = []; this.unread = 0;
      this.renderUnread(); this.view.refresh();
    }
    this.delivery.announce();
  }
  synced() {
    this.scope = this.preferences.key(); this.ready = true;
    for (const entry of this.ui.roster) if (entry.profile?.id) this.presence.set(entry.profile.id, true);
    this.delivery.announce();
  }
  settingsChanged() {
    this.generation++; this.sounds.stop(); this.dismiss();
    for (const transition of this.transitions.values()) clearTimeout(transition.timer);
    this.transitions.clear();
    this.presence = new Map(this.ui.roster.filter(entry => entry.profile?.id).map(entry => [entry.profile.id, true]));
    this.delivery.announce();
  }
  receive(data) {
    if (!this.ready || !this.ui.mentionsReady || data.isNako) return;
    const message = { text: data.message, profile: data.user, sender: data.sender, timestamp: data.timestamp, user: data.name };
    const reasons = this.reasons(message);
    if (!reasons.length || this.seen.has(data.timestamp)) return;
    this.seen.add(data.timestamp);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value);
    if (!this.viewing()) { this.unread++; this.renderUnread(); }
    const prefs = this.preferences.read();
    if (this.paused(prefs)) return;
    const important = reasons.filter(kind => kind !== 'message');
    const notice = important.find(kind => prefs[`${kind}Notice`]);
    if (notice) this.notice(`${data.name} ${notice === 'reply' ? '回复了你' : notice === 'everyone' ? '提及了所有人' : '提到了你'}`, message, notice);
    else if (!important.length && (prefs.messageNotice === 'always' || (prefs.messageNotice === 'away' && !this.viewing()))) {
      this.notice(`${data.name} 发来新消息`, message, 'message');
    }
    this.sound(reasons, `message:${data.timestamp}`, prefs);
  }
  sound(reasons, key, prefs) {
    if (!prefs.sound || prefs.volume <= 0 || this.paused(prefs)) return;
    // A disabled personal/group alert must not ring as an ordinary message.
    const specific = reasons.filter(kind => kind !== 'message');
    const candidates = specific.length ? specific : reasons;
    const scope = this.preferences.key(), generation = this.generation;
    const eligible = kind => {
      const away = !this.delivery.viewing(scope);
      if (prefs.awayOnly && !away) return false;
      if (kind === 'message') return prefs.message === 'always' || (prefs.message === 'away' && away);
      return prefs[`${kind}Sound`] === true;
    };
    if (!candidates.some(eligible)) return;
    void this.delivery.deliver(`${scope}:${key}`, async () => {
      if (generation !== this.generation || !this.ready) return false;
      const kind = candidates.find(eligible);
      if (!kind) return false;
      const now = Date.now(), priority = kind === 'mention' || kind === 'reply' ? 2 : 1;
      if (now - this.lastSound < (priority === 2 ? 1000 : 2000) && priority <= this.lastPriority) return true;
      const previousTime = this.lastSound, previousPriority = this.lastPriority;
      this.lastSound = now; this.lastPriority = priority;
      // Blocked notification sounds expire here; never replay a backlog on tap.
      const played = await this.sounds.play(kind === 'everyone' ? 'message' : kind, prefs.volume);
      if (!played && this.lastSound === now) { this.lastSound = previousTime; this.lastPriority = previousPriority; }
      return played;
    });
  }
  member(id, name, online) {
    if (!id || id === this.ui.currentUser?.id || !this.ready) return;
    const previous = this.presence.get(id) === true;
    const pending = this.transitions.get(id);
    if (pending?.online === online) return;
    if (pending) { clearTimeout(pending.timer); this.transitions.delete(id); }
    if (previous === online) return;
    const generation = this.generation;
    const transition = { online, timer: setTimeout(() => {
      this.transitions.delete(id);
      if (generation !== this.generation || !this.ready) return;
      this.presence.set(id, online);
      const prefs = this.preferences.read(), kind = online ? 'online' : 'offline';
      const follow = prefs.followed[id];
      if (prefs.presence === 'off' || (prefs.presence === 'followed' && !follow?.[kind]) || this.paused(prefs)) return;
      const text = `${name} ${online ? '进入了' : '离开了'}这个聊天室`;
      this.recent.unshift({ text, id, at: Date.now(), kind }); this.recent.length = Math.min(this.recent.length, 40);
      if (prefs[`${kind}Notice`]) this.notice(text, null, kind);
      this.view.refreshActivity();
      // The identity transition is shared across tabs; wall-clock timestamps aren't.
      this.sound([kind], `presence:${id}:${kind}`, prefs);
    }, online ? 2000 : 15000) };
    this.transitions.set(id, transition);
  }
  dismiss() { this.ui.clearNotices?.(); this.banner.dismiss(); }
  notice(text, message, kind) {
    if (kind === 'mention' || kind === 'everyone' || kind === 'reply') {
      this.banner.dismiss();
      const data = { name: message.user, message: message.text, timestamp: message.timestamp, user: message.profile,
        noticeLabel: kind === 'everyone' ? '全体提及' : null };
      if (kind === 'reply') this.ui.showReplyNotice(data);
      else this.ui.showMentionNotice(data);
    } else this.banner.show(text, message, kind);
  }
  jump(message) {
    this.ui.sidebarFeatures?.close(false);
    const target = this.ui.messageIndex.get(Number(message.timestamp));
    if (!target) { this.ui.sidebarFeatures?.open('inbox'); return; }
    if (this.ui.sidebarFeatures && this.reasons(message).some(kind => kind !== 'message')) {
      const key = SidebarHelpers.messageKey(message);
      this.ui.sidebarFeatures.saveRead(read => { read[key] = true; });
    }
    target.scrollIntoView({ block: 'center' }); target.tabIndex = -1; target.focus({ preventScroll: true });
  }
  renderUnread() {
    if (!this.unreadButton && this.ui.elements.main) {
      this.unreadButton = document.createElement('button'); this.unreadButton.type = 'button';
      this.unreadButton.className = 'chat-unread';
      this.unreadButton.addEventListener('click', () => {
        this.ui.sidebarFeatures?.close(false);
        const log = this.ui.elements.chatlog;
        log.scrollTop = log.scrollHeight; this.ui.isAtBottom = true; this.unread = 0;
        this.renderUnread(); this.delivery.announce(); this.ui.elements.chatInput?.focus();
      });
      this.ui.elements.main.append(this.unreadButton);
    }
    if (this.unreadButton) { this.unreadButton.hidden = !this.unread; this.unreadButton.textContent = `${this.unread} 条新消息 · 回到最新`; }
  }
  destroy() {
    this.reset(); this.delivery.destroy(); this.view.destroy(); this.unreadButton?.remove();
    for (const unsubscribe of this.off) unsubscribe();
    for (const event of ['focus', 'blur']) window.removeEventListener(event, this.attention);
    document.removeEventListener('visibilitychange', this.attention);
    document.removeEventListener('focusin', this.attention);
    this.ui.elements.chatlog?.removeEventListener('scroll', this.attention);
    window.removeEventListener('storage', this.storageChanged);
  }
}
