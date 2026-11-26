/* SPDX-License-Identifier: AGPL-3.0-only */
class PushNotifications {
  constructor(app, registration, changed) {
    this.app = app; this.registration = registration; this.changed = changed;
    this.app.pushNotifications = this;
    if (app.ui) app.ui.pushNotifications = this;
    this.base = app.directMessages.base.replace(/\/dm$/, '/push');
    this.user = app.directMessages.user;
    this.config = null; this.state = null; this.busy = false; this.generation = 0; this.queue = Promise.resolve();
    this.pending = new URLSearchParams(location.search).get('dm');
    try {
      this.pending ||= sessionStorage.getItem('nightcord-push-destination');
      if (/^[a-f0-9]{64}$/.test(this.pending)) sessionStorage.setItem('nightcord-push-destination', this.pending);
    } catch { /* Storage is optional for notification navigation. */ }
    if (this.pending && !/^[a-f0-9]{64}$/.test(this.pending)) this.pending = null;
    this.openInbox = new URLSearchParams(location.search).get('view') === 'messages';
    this.storageKey = 'nightcord-push-device';
    this.app.eventBus.on('session:updated', ({ user }) => { void this.setUser(user); });
    this.app.eventBus.on('dm:updated', () => this.badge());
    this.app.eventBus.on('dm:synced', () => this.openPending());
    for (const event of ['room:synced', 'room:ready', 'rooms:updated']) this.app.eventBus.on(event, () => { void this.roomAttention(); });
    for (const event of ['auth:required', 'session:unavailable']) {
      this.app.eventBus.on(event, () => { if (this.user || this.state) void this.logout(); });
    }
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data?.type === 'OPEN_DM' && /^[a-f0-9]{64}$/.test(event.data.conversation)
        && (!this.user || event.data.ownerId === this.user.id)) {
        this.pending = event.data.conversation;
        try { sessionStorage.setItem('nightcord-push-destination', this.pending); } catch { /* Optional storage. */ }
        this.openPending();
        event.ports?.[0]?.postMessage({ ok: true });
      }
      if (event.data?.type === 'OPEN_ROOM' && this.validRoom(event.data.room) && this.user?.id === event.data.ownerId) {
        const room = event.data.room;
        // Only reuse a tab already in that room; another room may contain a draft.
        if (this.app.ui?.currentRoom === room && !this.app.ui.elements?.main?.classList.contains('dm-view')) {
          this.app.ui.sidebarFeatures?.close?.();
          this.app.ui.elements?.chatlog?.scrollTo?.({ top: this.app.ui.elements.chatlog.scrollHeight });
          event.ports?.[0]?.postMessage({ ok: true });
        } else event.ports?.[0]?.postMessage({ ok: false });
      }
    });
    window.addEventListener('storage', event => {
      if (event.key === this.storageKey || event.key === null) { this.generation++; this.state = this.read(); this.changed(); }
    });
    this.ready = this.initialize();
  }
  supported() { return 'PushManager' in window && 'Notification' in window; }
  validRoom(room) { return typeof room === 'string' && /^(?:[a-z0-9-]{1,32}|[a-f0-9]{64}|r_[a-f0-9]{32})$/.test(room); }
  roomPreferences(room = this.app.ui?.currentRoom) {
    return { message: false, reply: false, mention: false, everyone: false, pausedUntil: 0,
      ...(this.state?.ownerId === this.user?.id ? this.state?.rooms?.[room] : {}) };
  }
  async setRoomPreferences(room, preferences) {
    if (!this.validRoom(room) || !this.user) throw new Error('请登录并进入聊天室后设置推送。');
    const scope = this.scope();
    // Keep the permission request in the originating switch gesture.
    if (!this.state) await this.enable();
    this.check(scope);
    return this.serial(async () => {
      this.check(scope);
      const state = this.read(), sub = await (await this.registration)?.pushManager.getSubscription();
      this.check(scope);
      if (!state || state.ownerId !== scope.ownerId || !sub) throw new Error('请重新启用推送通知。');
      const prefs = { ...this.roomPreferences(room), ...preferences };
      await this.call('/room', { room, endpoint: sub.endpoint, preferences: prefs }, scope);
      try { await this.save({ ...state, rooms: { ...state.rooms, [room]: { ...prefs, syncedAt: Date.now() } } }, scope); }
      catch (error) {
        await this.call('/room', { room, endpoint: sub.endpoint, preferences: this.roomPreferences(room) }, scope).catch(() => {});
        throw error;
      }
      this.attentionState = null; await this.roomAttention();
    });
  }
  async roomAttention() {
    try {
      const ui = this.app.ui, room = ui?.currentRoom;
      if (!room || !this.state || this.state.ownerId !== this.user?.id || !this.state.rooms?.[room]) return;
      const saved = this.state.rooms[room];
      if (!this.busy && saved.syncedAt < Date.now() - 86400000 && ['message', 'reply', 'mention', 'everyone'].some(key => saved[key])) {
        this.roomRenewals ||= new Map();
        if (!(this.roomRenewals.get(room) > Date.now() - 600000)) {
          this.roomRenewals.set(room, Date.now());
          void this.setRoomPreferences(room, {}).catch(() => {});
        }
      }
      const ws = ui.managedChat ? this.app.rooms?.transport?.ws : this.app.chatRoom?.wsManager?.ws;
      if (!ws || ws.readyState !== 1) return;
      if (this.attentionSocket === ws && this.attentionState === room + ':' + (ui.alerts?.viewing() === true)) return;
      const scope = this.scope(), registration = await this.registration;
      const sub = await registration?.pushManager?.getSubscription();
      if (sub && this.attentionEndpoint !== sub.endpoint) {
        this.attentionDevice = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub.endpoint))), n => n.toString(16).padStart(2, '0')).join('');
        this.attentionEndpoint = sub.endpoint;
      }
      if (!sub || scope.generation !== this.generation || ui.currentRoom !== room) return;
      // Focus may change while the browser retrieves its subscription.
      const viewing = ui.alerts?.viewing() === true, key = room + ':' + viewing;
      if (this.attentionSocket === ws && this.attentionState === key) return;
      ws.send(JSON.stringify({ type: 'push:attention', requestId: crypto.randomUUID(), device: this.attentionDevice, viewing }));
      this.attentionSocket = ws; this.attentionState = key;
    } catch { /* Browser subscription lookup must not interrupt chat. */ }
  }
  read() {
    try {
      const state = JSON.parse(localStorage.getItem(this.storageKey) || 'null');
      return state?.ownerId?.startsWith('sekai:') && typeof state.publicKey === 'string'
        && Number.isSafeInteger(state.pausedUntil) && state.pausedUntil >= 0 ? state : null;
    } catch { return null; }
  }
  scope() { return { generation: this.generation, ownerId: this.user?.id }; }
  check(scope) {
    if (scope.generation !== this.generation || scope.ownerId !== this.user?.id) throw new Error('您的账户已切换，请重新执行该操作。');
  }
  serial(action) {
    const work = this.queue.then(async () => {
      this.busy = true; this.changed();
      try { return await (navigator.locks ? navigator.locks.request('nightcord:push-device', action) : action()); }
      finally { this.busy = false; this.changed(); }
    });
    this.queue = work.catch(() => {}); return work;
  }
  async workerState(state) {
    const registration = await this.registration;
    const worker = registration?.active;
    if (!worker) throw new Error('离线组件尚未就绪，请稍后再试。');
    await new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); reject(new Error('离线组件无响应，请刷新页面后再试。')); }, 5000);
      channel.port1.onmessage = event => {
        clearTimeout(timer); channel.port1.close();
        event.data?.ok ? resolve() : reject(new Error('无法保存推送通知设置。'));
      };
      worker.postMessage({ type: 'PUSH_STATE', state }, [channel.port2]);
    });
  }
  async save(state, scope) {
    this.check(scope);
    await this.workerState(state);
    this.check(scope);
    // Persistence is required: never leave an enabled subscription with no account ownership.
    try { state ? localStorage.setItem(this.storageKey, JSON.stringify(state)) : localStorage.removeItem(this.storageKey); }
    catch { await this.workerState(null); throw new Error('您的浏览器无法保存推送通知设置，请允许本网站存储数据。'); }
    this.state = state; this.changed();
  }
  async initialize() {
    if (this.initializing) return;
    this.initializing = true;
    this.state = this.read();
    try {
      const response = await fetch(this.base + '/config', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (response.ok) this.config = await response.json();
      if (this.app.identity.authExpired) await this.logout();
      else if (this.user) await this.setUser(this.user);
    } catch { /* Settings show that configuration is unavailable; chat remains usable. */ }
    this.initializing = false; this.changed();
  }
  async call(path, body, scope = this.scope()) {
    this.check(scope);
    const token = await this.app.identity.getAccessToken();
    this.check(scope);
    if (!token) throw new Error('请先登录 SEKAI Pass。');
    const response = await fetch(this.base + path, { method: 'POST', cache: 'no-store',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(({ login_required: '请重新登录 SEKAI Pass。', too_many_devices: '已达到 8 台设备的上限，请先在其他设备上关闭推送通知。',
        rate_limited: '请求过于频繁，请稍后再试。', push_unavailable: '服务器端尚未启用推送通知功能。',
        room_push_limit: '这个聊天室的推送订阅已达上限。', not_found: '当前无法订阅这个聊天室，请确认仍有访问权限。',
        invalid_subscription: '设备订阅已失效，请重新启用推送。' })[data.code] || '推送通知设置同步失败，请检查网络连接后再试。');
    }
    this.check(scope);
  }
  async setUser(user) {
    const next = user?.authenticated ? user : null;
    if (this.user?.id !== next?.id) this.generation++;
    this.user = next;
    const scope = this.scope();
    this.state = this.read();
    if (!this.state || this.state.ownerId !== this.user?.id) {
      await this.serial(async () => {
        this.check(scope);
        const saved = this.read();
        if (!saved || saved.ownerId !== scope.ownerId) await this.removeDevice();
      }).catch(() => {});
      this.changed(); this.openPending(); return;
    }
    if (this.state && this.config?.enabled && this.supported() && !this.busy) {
      try {
        await this.serial(async () => {
          this.check(scope);
          const state = this.read(), sub = await (await this.registration)?.pushManager.getSubscription();
          this.check(scope);
          if (!state || state.ownerId !== scope.ownerId) return;
          if (!sub || Notification.permission !== 'granted' || state.publicKey !== this.config.publicKey) await this.removeDevice(scope);
          else {
            await this.call('/subscribe', { subscription: sub.toJSON(), pausedUntil: state.pausedUntil || 0 }, scope);
            await this.save(state, scope);
          }
        });
      } catch { /* Retain the user's choice so a later visit can repair the subscription. */ }
    }
    this.changed(); this.openPending();
    void this.roomAttention();
  }
  async enable() {
    if (!this.user || !this.config?.enabled || !this.supported()) throw new Error('目前无法启用推送通知，请参阅上述说明。');
    const scope = this.scope();
    // Must run in the button gesture, before waiting for registration/network.
    const permission = await Notification.requestPermission();
    this.check(scope);
    if (permission !== 'granted') throw new Error('未获得通知权限。您可以在浏览器的网站设置中调整权限。');
    return this.serial(() => this.subscribe(scope));
  }
  async subscribe(scope) {
    this.check(scope);
    const registration = await this.registration;
    if (!registration?.pushManager) throw new Error('离线组件尚未就绪，请连接互联网并重新打开应用程序。');
    let sub = await registration.pushManager.getSubscription();
    try {
      this.check(scope);
      if (sub && this.state?.publicKey !== this.config.publicKey) { await sub.unsubscribe(); sub = null; }
      const key = Uint8Array.from(atob(this.config.publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      sub ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      this.check(scope);
      await this.call('/subscribe', { subscription: sub.toJSON(), pausedUntil: 0 }, scope);
      await this.save({ ownerId: scope.ownerId, publicKey: this.config.publicKey, pausedUntil: 0 }, scope);
    } catch (error) {
      await this.workerState(null).catch(() => {});
      await sub?.unsubscribe().catch(() => {});
      this.state = null;
      try { localStorage.removeItem(this.storageKey); } catch { /* Device was revoked above. */ }
      throw error;
    }
  }
  disable() {
    this.generation++; const scope = this.scope();
    return this.serial(async () => { this.check(scope); await this.removeDevice(scope); });
  }
  async removeDevice(scope, logoutToken) {
    this.state = null;
    try { localStorage.removeItem(this.storageKey); } catch { /* Browser unsubscribe remains available. */ }
    this.changed();
    const registration = await this.registration;
    const sub = await registration?.pushManager?.getSubscription();
    let cleared = false;
    try { await this.workerState(null); cleared = true; } catch { /* Still revoke at the browser and server. */ }
    let removed = !sub;
    if (sub) {
      try { removed = await sub.unsubscribe() || removed; } catch { /* The worker already suppresses notifications on this device. */ }
      if (scope?.ownerId) {
        try { await this.call('/unsubscribe', { endpoint: sub.endpoint }, scope); removed = true; } catch { /* Browser unsubscribe also invalidates the endpoint. */ }
      } else if (logoutToken) {
        // The caller captured the departing account's credential before local
        // logout. Never obtain the replacement account's token during cleanup.
        try {
          const token = await logoutToken;
          if (token) {
            const response = await fetch(this.base + '/unsubscribe', { method: 'POST', cache: 'no-store',
              headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
              body: JSON.stringify({ endpoint: sub.endpoint }), signal: AbortSignal.timeout(5000) });
            removed ||= response.ok;
          }
        } catch { /* Browser revocation or a later 410 also cleans up the endpoint. */ }
      }
    }
    if (!removed || !cleared) throw new Error('取消推送通知订阅的操作尚未完成，请连接互联网、更新应用程序后再试。');
  }
  async logout() {
    const departing = this.user;
    this.generation++;
    this.user = null; this.state = null; this.badge(); this.changed();
    const token = departing ? this.app.identity.getAccessToken().catch(() => null) : null;
    try { localStorage.removeItem(this.storageKey); } catch { /* Worker cleanup below. */ }
    // Clear worker ownership immediately, even if an older network operation is
    // pending. The queue then revokes that operation's browser subscription.
    void this.workerState(null).catch(() => {});
    try { await this.serial(() => this.removeDevice(undefined, token)); } catch { /* Retry cleanup on the next verified session. */ }
  }
  pause() {
    if (!this.state) return;
    const scope = this.scope();
    return this.serial(async () => {
      this.check(scope);
      const previous = this.read();
      if (!previous || previous.ownerId !== scope.ownerId) throw new Error('请重新启用推送通知。');
      const state = { ...previous, pausedUntil: previous.pausedUntil > Date.now() ? 0 : Date.now() + 3600000 };
      const sub = await (await this.registration).pushManager.getSubscription();
      this.check(scope);
      if (!sub) throw new Error('未找到有效的推送订阅，请重新启用。');
      await this.call('/subscribe', { subscription: sub.toJSON(), pausedUntil: state.pausedUntil }, scope);
      await this.save(state, scope);
    });
  }
  badge() {
    const count = this.user ? [...this.app.directMessages.conversations.values()].reduce((n, item) => n + (item.hidden ? 0 : item.unread || 0), 0) : 0;
    try { Promise.resolve(count ? navigator.setAppBadge?.(count) : navigator.clearAppBadge?.()).catch(() => {}); } catch { /* Optional API. */ }
  }
  openPending() {
    if (!this.app.directMessages.ready) return;
    if (this.pending) {
      const id = this.pending;
      if (!this.app.directMessages.conversations.has(id)) return;
      this.pending = null; this.app.directMessageView.open(id);
      try { sessionStorage.removeItem('nightcord-push-destination'); } catch { /* Optional storage. */ }
    } else if (this.openInbox) { this.openInbox = false; this.app.directMessageView.open(); }
    else return;
    const url = new URL(location.href); url.searchParams.delete('dm'); url.searchParams.delete('view');
    history.replaceState(history.state, '', url);
  }
}
