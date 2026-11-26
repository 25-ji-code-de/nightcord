/* SPDX-License-Identifier: AGPL-3.0-only */
/** Account-scoped private messaging. Payloads and drafts remain in memory. */
class DirectMessageManager {
  constructor({ eventBus, hostname, getAccessToken, fetcher, createSocket }) {
    this.bus = eventBus;
    this.base = 'https://' + (hostname || 'chat.nightcord.de5.net') + '/api/dm';
    this.getAccessToken = getAccessToken;
    this.fetcher = fetcher || ((...args) => globalThis.fetch(...args));
    this.createSocket = createSocket || (url => new globalThis.WebSocket(url));
    this.conversations = new Map(); this.messages = new Map(); this.moreBefore = new Map();
    this.syncedSeq = new Map();
    this.pending = new Map(); this.drafts = new Map(); this.loading = new Map(); this.reading = new Map();
    this.readPending = new Map(); this.readTimers = new Map();
    this.generation = 0; this.controller = new AbortController(); this.mode = 'off'; this.ready = false;
    this.status = ''; this.reconnectAttempt = 0;
    this.off = [
      this.bus.on('session:updated', ({ user }) => this.setUser(user)),
      ...['session:unavailable', 'auth:required', 'guest:required'].map(event => this.bus.on(event, () => this.reset())),
    ];
    this.configPromise = this.configure();
  }
  update() { this.bus.emit('dm:updated'); }
  static error(code) {
    const labels = {
      login_required: '登录已失效，请重新登录 SEKAI Pass。', dm_disabled: '私信暂未开放。',
      dm_read_only: '私信暂时只读，请稍后再试。', recipient_refused: '对方已拒收，消息未发送。',
      request_pending: '私信请求尚未接受，暂时不能继续发送。', request_rejected: '对方已拒绝此私信请求。',
      request_not_yours: '只有接收方可以处理私信请求。', invalid_message: '消息不能为空或超过 256 字符。',
      rate_limited: '操作太快了，请稍后重试。', request_rate_limited: '本时段发起的新私信过多，请稍后再试。',
      peer_unavailable: '暂时无法核实这个账号，请从聊天室成员资料重新发起。',
      conversation_full: '这段会话的存储空间已满，暂时无法发送。', message_id_conflict: '发送记录冲突，请刷新后确认历史。',
      not_found: '无法访问这段私信。', auth_unavailable: '登录服务暂时不可用，请稍后重试。',
      stale_session: '登录状态已改变。', dm_unavailable: '私信服务暂时不可用，请重试。',
    };
    return labels[code] || '操作未完成，请检查网络后重试。';
  }
  async configure() {
    try {
      const response = await this.fetcher(this.base + '/config', { cache: 'no-store' });
      const config = await response.json();
      this.mode = response.ok && ['on', 'read-only'].includes(config.mode) ? config.mode : 'off';
    } catch { this.mode = 'off'; }
    this.update();
  }
  reset() {
    this.generation++; this.controller.abort(); this.controller = new AbortController();
    clearTimeout(this.retryTimer); this.retryTimer = null;
    this.disconnect();
    this.connecting = this.authWork = null;
    for (const task of this.readTimers.values()) { clearTimeout(task.timer); task.resolve(); }
    this.readTimers.clear(); this.readPending.clear();
    this.user = null; this.ready = false; this.status = '';
    this.conversations.clear(); this.messages.clear(); this.syncedSeq.clear(); this.moreBefore.clear(); this.pending.clear(); this.drafts.clear(); this.loading.clear(); this.reading.clear();
    this.syncing = null; this.update();
  }
  async setUser(user) {
    if (!user?.authenticated) { this.reset(); return; }
    if (this.user?.id === user.id) { this.user = user; return; }
    this.reset(); this.user = user;
    const gen = this.generation;
    await this.configPromise;
    if (gen === this.generation && this.mode !== 'off') void this.connect();
    this.update();
  }
  expired() { this.reset(); this.bus.emit('auth:required', { error: new Error(DirectMessageManager.error('login_required')) }); }
  async token(gen) {
    let token;
    try { token = await this.getAccessToken(); }
    catch (error) {
      if (gen !== this.generation) throw Object.assign(new Error('Session changed'), { code: 'stale_session' });
      if (/not authenticated|token refresh failed/i.test(error.message || '')) this.expired();
      throw error;
    }
    if (gen !== this.generation) throw Object.assign(new Error('Session changed'), { code: 'stale_session' });
    if (!token) { this.expired(); throw Object.assign(new Error('Login required'), { code: 'login_required' }); }
    return token;
  }
  async call(path, data) {
    const gen = this.generation;
    const token = await this.token(gen);
    const response = await this.fetcher(this.base + path, {
      method: data === undefined ? 'GET' : 'POST', cache: 'no-store',
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
      headers: { Authorization: 'Bearer ' + token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const value = await response.json();
    if (gen !== this.generation) throw Object.assign(new Error('Session changed'), { code: 'stale_session' });
    if (!response.ok) {
      if (response.status === 401) this.expired();
      throw Object.assign(new Error(DirectMessageManager.error(value.code)), { code: value.code, status: response.status });
    }
    return value;
  }
  put(conversation, revision = 0) {
    const old = this.conversations.get(conversation.id);
    if (old && revision && revision < (old._revision || 0)) return old;
    // Room versions and account revisions are independent clocks.
    const metadata = old && old.version > conversation.version ? old : conversation;
    const personal = revision || !old ? conversation : old;
    const next = { ...old, ...metadata,
      hidden: personal.hidden ?? old?.hidden ?? false,
      readSeq: Math.max(old?.readSeq || 0, personal.readSeq || 0),
      readIncoming: Math.max(old?.readIncoming || 0, personal.readIncoming || 0),
      _revision: revision || old?._revision || 0,
    };
    next.unread = next.hidden ? 0 : Math.max(0, next.incoming - next.readIncoming);
    this.conversations.set(next.id, next);
    if (next.hidden) { this.messages.delete(next.id); this.syncedSeq.delete(next.id); }
    return next;
  }
  async sync() {
    if (this.syncing) return this.syncing;
    const gen = this.generation;
    const promise = (async () => {
      let cursor = '';
      do {
        const result = await this.call('/conversations' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
        for (const conversation of result.conversations) this.put(conversation, result.revision);
        cursor = result.next;
      } while (cursor && gen === this.generation);
      this.update();
    })();
    this.syncing = promise;
    try { await promise; } finally { if (this.syncing === promise) this.syncing = null; }
  }
  async refresh(id, silent = true) {
    const value = await this.call('/conversations/' + id);
    return this.changed(value.conversation, value.revision, silent);
  }
  changed(snapshot, revision, silent = true) {
    const previous = this.conversations.get(snapshot.id);
    const conversation = this.put(snapshot, revision);
    this.update();
    if (!silent && this.ready && !conversation.hidden && conversation.incoming > (previous?.incoming || 0)) {
      this.bus.emit('dm:incoming', { conversation });
    }
    return conversation;
  }
  async connect() {
    if (this.connecting) return this.connecting;
    const work = this.openConnection();
    this.connecting = work;
    try { await work; } finally { if (this.connecting === work) this.connecting = null; }
  }
  disconnect() {
    const socket = this.socket; this.socket = null;
    clearTimeout(this.authTimer); clearTimeout(this.leaseTimer);
    this.authTimer = this.leaseTimer = null;
    this.authWork = null; this.expiresAt = 0; this.ready = false;
    try { socket?.close(); } catch { /* Already disconnected. */ }
  }
  async openConnection() {
    if (!this.user || this.mode === 'off') return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.disconnect();
    const gen = this.generation;
    this.status = '正在连接私信…'; this.update();
    try {
      const token = await this.token(gen);
      const socket = this.createSocket(this.base.replace(/^http/, 'ws') + '/events?account=' + encodeURIComponent(this.user.id));
      this.socket = socket;
      this.authWork = null;
      let socketRevision = null;
      const current = () => gen === this.generation && socket === this.socket;
      this.leaseTimer = setTimeout(() => { if (current()) this.reconnect(); }, 20000);
      socket.addEventListener('open', () => {
        if (!current()) return;
        this.authWork = { socket, promise: Promise.resolve() };
        socket.send(JSON.stringify({ type: 'auth', accessToken: token }));
      });
      socket.addEventListener('message', async event => {
        if (!current()) return;
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'dm:ready') {
            this.authWork = null;
            if (data.user.id !== this.user.id) { this.expired(); return; }
            this.mode = data.mode;
            this.expiresAt = data.expiresAt;
            clearTimeout(this.leaseTimer);
            // The receive lease is shorter than the login session. Suspended tabs
            // and failed renewals need a new connection, not a global logout.
            this.leaseTimer = setTimeout(() => { if (current()) this.reconnect(); }, Math.max(0, data.expiresAt - Date.now()));
            clearTimeout(this.authTimer);
            this.authTimer = setTimeout(() => { if (current()) void this.renew(); }, Math.max(1000, data.expiresAt - Date.now() - 60000));
            const needsSync = socketRevision === null || socketRevision < data.revision;
            socketRevision = Math.max(socketRevision || 0, data.revision);
            if (needsSync) {
              try { await this.sync(); }
              catch (error) { socketRevision = null; throw error; }
            }
            if (!current()) return;
            this.reconnectAttempt = 0;
            this.ready = true; this.status = this.mode === 'read-only' ? '私信当前只读' : ''; this.update();
            void this.flushReads();
            if (needsSync) this.bus.emit('dm:synced');
          } else if (data.type === 'dm:changed') {
            const gap = socketRevision !== null && data.revision > socketRevision + 1;
            if (socketRevision !== null) socketRevision = Math.max(socketRevision, data.revision);
            if (data.conversation) this.changed(data.conversation, data.revision, data.silent);
            else await this.refresh(data.id, data.silent); // Older server during rollout.
            if (gap) {
              // An in-flight list may predate the missing events. Repair with a
              // fresh snapshot once it finishes; historical changes stay silent.
              if (this.syncing) await this.syncing;
              if (!current()) return;
              await this.sync();
              if (current()) this.bus.emit('dm:synced');
            }
          }
          else if (data.type === 'dm:error') {
            this.authWork = null;
            if (data.code === 'login_required') this.expired();
            else { this.status = DirectMessageManager.error(data.code); this.update(); }
          }
        } catch (error) { if (current()) this.reconnect(error); }
      });
      socket.addEventListener('close', () => {
        if (!current()) return;
        this.reconnect();
      });
      socket.addEventListener('error', () => { /* close drives retry; HTTP history stays available. */ });
    } catch (error) {
      if (gen === this.generation && this.user) this.reconnect(error);
    }
  }
  reconnect(error) {
    this.disconnect();
    this.status = error?.message || '私信连接中断，正在重连…'; this.update();
    clearTimeout(this.retryTimer);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.reconnectAttempt++, 5));
    this.retryTimer = setTimeout(() => void this.connect(), delay * (0.75 + Math.random() * 0.25));
  }
  renew() {
    const socket = this.socket, gen = this.generation;
    if (!socket || socket.readyState !== 1) return;
    if (this.authWork?.socket === socket) return this.authWork.promise;
    const work = { socket };
    work.promise = (async () => {
      try {
        const token = await this.token(gen);
        if (gen === this.generation && this.socket === socket && socket.readyState === 1) socket.send(JSON.stringify({ type: 'auth', accessToken: token }));
      } catch {
        if (gen === this.generation && this.socket === socket) socket.close();
      }
    })();
    // Keep the operation pending until ready/error/close, including server verification.
    this.authWork = work;
    return work.promise;
  }
  async resume() {
    if (!this.user || this.mode === 'off') return;
    if (this.expiresAt && Date.now() >= this.expiresAt) return this.connect();
    if (this.socket?.readyState === 0) return;
    if (!this.socket || this.socket.readyState !== 1) { if (!this.retryTimer) return this.connect(); return; }
    // Focus/visibility/pageshow can arrive together. The lease timer already
    // renews a healthy connection; only a nearly expired lease needs attention.
    if (this.expiresAt - Date.now() > 60000) return;
    return this.renew();
  }
  async create(peerId, sourceRoom, sourceType) {
    const value = await this.call('/conversations', { peerId, sourceRoom, ...(sourceType ? { sourceType } : {}) });
    this.put(value.conversation, value.revision); this.update();
    return value.conversation;
  }
  async history(id, older = false) {
    const key = id + ':' + older;
    if (this.loading.has(key)) return this.loading.get(key);
    if (!older && this.syncedSeq.has(id) && this.syncedSeq.get(id) >= (this.conversations.get(id)?.lastSeq || 0)) return;
    const gen = this.generation;
    const promise = (async () => {
      const existing = this.messages.get(id) || [];
      let after = !older && this.syncedSeq.has(id) ? this.syncedSeq.get(id) : null;
      const before = older && existing.length ? existing[0].seq : null;
      do {
        const query = before !== null ? '?before=' + before : after !== null ? '?after=' + after : '';
        const result = await this.call('/conversations/' + id + '/messages' + query);
        if (gen !== this.generation || this.conversations.get(id)?.hidden) return;
        this.put(result.conversation);
        const combined = new Map((this.messages.get(id) || []).map(message => [message.seq, message]));
        for (const message of result.messages) combined.set(message.seq, message);
        this.messages.set(id, [...combined.values()].sort((a, b) => a.seq - b.seq));
        if (before === null) this.syncedSeq.set(id, Math.max(this.syncedSeq.get(id) || 0, result.messages.at(-1)?.seq || 0));
        if (before !== null || after === null) { this.moreBefore.set(id, result.more); break; }
        if (!result.more || !result.messages.length) break;
        after = result.messages.at(-1).seq;
      } while (gen === this.generation);
      this.update();
    })();
    this.loading.set(key, promise);
    try { await promise; } finally { if (this.loading.get(key) === promise) this.loading.delete(key); }
  }
  async action(id, action, data = {}) {
    const value = await this.call('/conversations/' + id + '/' + action, data);
    // Command replies include the caller's inbox preferences and revision.
    this.put(value.conversation, value.revision); this.update();
    return value;
  }
  async read(id, seq) {
    const conversation = this.conversations.get(id);
    if (!conversation || conversation.hidden || seq <= (conversation.readSeq || 0)
      || conversation.incoming <= (conversation.readIncoming || 0)) return;
    this.readPending.set(id, Math.max(seq, this.readPending.get(id) || 0));
    if (this.reading.has(id)) return this.reading.get(id);
    if (this.readTimers.has(id)) return this.readTimers.get(id).promise;
    const task = {};
    task.promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
    task.timer = setTimeout(() => { void this.flushRead(id).catch(() => {}); }, 350);
    this.readTimers.set(id, task);
    return task.promise;
  }
  async flushRead(id) {
    if (this.reading.has(id)) return this.reading.get(id);
    const task = this.readTimers.get(id), gen = this.generation;
    if (task) { clearTimeout(task.timer); this.readTimers.delete(id); }
    const promise = (async () => {
      while (gen === this.generation && this.readPending.has(id)) {
        const seq = this.readPending.get(id), conversation = this.conversations.get(id);
        if (!conversation || conversation.hidden || seq <= (conversation.readSeq || 0)
          || conversation.incoming <= (conversation.readIncoming || 0)) { this.readPending.delete(id); break; }
        await this.action(id, 'read', { seq });
        if (gen !== this.generation) return;
        if (this.readPending.get(id) <= seq) this.readPending.delete(id);
      }
    })();
    this.reading.set(id, promise);
    try { await promise; task?.resolve(); }
    catch (error) { task?.reject(error); throw error; }
    finally { if (this.reading.get(id) === promise) this.reading.delete(id); }
  }
  flushReads() { return Promise.allSettled([...this.readPending.keys()].map(id => this.flushRead(id))); }
  async send(id, payload, retryItem) {
    if (!this.user) throw Object.assign(new Error(DirectMessageManager.error('login_required')), { code: 'login_required' });
    const gen = this.generation;
    const item = retryItem || { ...payload, clientMessageId: crypto.randomUUID() };
    const pending = this.pending.get(id) || [];
    if (!retryItem) { pending.push(item); this.pending.set(id, pending); }
    item.status = 'sending'; delete item.error; this.update();
    try {
      const value = await this.call('/conversations/' + id + '/messages', {
        kind: item.kind || 'text', text: item.text, clientMessageId: item.clientMessageId,
        ...(item.replyTo ? { replyTo: item.replyTo } : {}),
      });
      this.put(value.conversation, value.revision);
      const messages = new Map((this.messages.get(id) || []).map(message => [message.seq, message]));
      messages.set(value.message.seq, value.message);
      this.messages.set(id, [...messages.values()].sort((a, b) => a.seq - b.seq));
      // Advance only through contiguous confirmed messages. An acknowledgement
      // must never skip a peer message that still needs to be fetched.
      if (this.syncedSeq.has(id)) {
        let seq = this.syncedSeq.get(id);
        while (messages.has(seq + 1)) seq++;
        this.syncedSeq.set(id, seq);
      }
      this.pending.set(id, (this.pending.get(id) || []).filter(entry => entry !== item));
    } catch (error) {
      if (gen !== this.generation) return;
      item.status = 'failed'; item.error = error.message || '发送结果未确认，请重试。';
    }
    if (gen === this.generation) this.update();
  }
  destroy() { this.reset(); this.off.forEach(off => off?.()); }
}
