/* SPDX-License-Identifier: AGPL-3.0-only */
class RoomManager {
  constructor({ eventBus, hostname, getAccessToken, fetcher }) {
    this.bus = eventBus; this.getAccessToken = getAccessToken;
    this.base = 'https://' + (hostname || 'chat.nightcord.de5.net') + '/api'; this.fetcher = fetcher || globalThis.fetch.bind(globalThis);
    this.generation = 0; this.roomGeneration = 0; this.cache = new Map(); this.requests = new Map();
    this.messages = new Map(); this.pending = new Map(); this.members = []; this.status = ''; this.mode = 'off';
    this.resetVisibility(); this.memberRevision = 0;
    this.controller = new AbortController();
    this.protocol = new ManagedRoomProtocol(this);
    this.transport = new WebSocketManager({ protocol: this.protocol, onMessage: data => this.receive(data),
      onClose: () => { this.ready = false; this.resetVisibility('disconnected'); this.update(); },
      onReconnect: () => { this.status = '连接中…'; this.resetVisibility(); this.update(); } });
    this.off = [eventBus.on('session:updated', ({ user }) => {
      if (this.user?.id !== user?.id) this.reset(); this.user = user?.authenticated ? user : null; this.update();
    }), ...['session:unavailable', 'auth:required', 'guest:required'].map(event => eventBus.on(event, () => this.reset()))];
    this.configPromise = this.configure();
  }
  async configure() {
    try {
      // Public capabilities are independent of account request cancellation.
      const response = await this.fetcher(this.base + '/rooms/config', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (!this.destroyed && response.ok) { this.config = data; this.mode = data.mode; this.update(); }
    } catch {}
  }
  update() { this.bus.emit('rooms:updated'); }
  resetVisibility(reason = 'connecting') {
    this.visibilityGeneration = (this.visibilityGeneration || 0) + 1;
    this.visibilityState = { visibility: null, pending: null, available: false, reason, error: '' };
  }
  allowedVisibility() {
    return this.room?.visibilityPolicy === 'online' ? ['online'] : this.room?.visibilityPolicy === 'offline' ? ['online', 'offline'] : ['online', 'offline', 'hidden'];
  }
  async setVisibility(visibility, confirmPolicy) {
    const required = this.visibilityState.required;
    if ((!this.ready && !required) || !this.visibilityState.available || this.visibilityState.pending || !this.allowedVisibility().includes(visibility)
      || required && confirmPolicy !== this.room?.visibilityPolicy) return false;
    const gen = this.visibilityGeneration;
    Object.assign(this.visibilityState, { pending: visibility, error: '' }); this.update();
    try {
      await this.request('room:visibility', { visibility, ...(required ? { confirmPolicy } : {}) });
      return gen === this.visibilityGeneration;
    } catch (error) {
      if (gen === this.visibilityGeneration) Object.assign(this.visibilityState, { error: error.message,
        ...(!error.code ? { available: false, reason: 'unconfirmed' } : {}) });
      return false;
    } finally {
      if (gen === this.visibilityGeneration) { this.visibilityState.pending = null; this.update(); }
    }
  }
  reset() {
    this.generation++; this.controller.abort(); this.controller = new AbortController();
    this.user = null; this.disconnect(); this.cache.clear(); this.status = ''; this.update();
  }
  clearRoom() {
    this.resetVisibility(); this.memberRevision++;
    this.online = []; this.secret = null; this.roomGeneration++; this.room = null; this.role = null; this.messages.clear(); this.pending.clear(); this.members = [];
    this.syncedSeq = 0; this.loaded = false; this.ready = false; this.syncing = null;
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(new Error('房间连接已关闭。')); }
    this.requests.clear();
  }
  disconnect() { this.transport.pauseAutoReconnect(); this.transport.disconnect(); this.clearRoom(); this.update(); }
  static error(code) {
    return ({ not_found: '无法访问此房间。', login_required: '请登录 SEKAI Pass。', rooms_disabled: '用户房暂未开放。', rooms_read_only: '用户房暂时只读。',
      invite_unavailable: '邀请已失效或不适用于此账号。', creation_quota: '创建数量已达上限。', rate_limited: '操作太快，请稍后重试。',
      room_full: '房间成员已满。', daily_limit: '房间今日发送额度已用完。', room_capacity: '房间存储已满，历史仍可查看。',
      transfer_required: '请先将房主转让给其他成员。', room_archived: '房间已归档。', invalid_message: '请输入 1–256 字符。',
      owner_required: '此操作需要房主权限。', invite_limit: '有效邀请已达上限，请撤销旧邀请。',
      invalid_visibility_policy: '请选择有效的成员显示规则。', visibility_not_allowed: '房间规则不允许使用此显示状态。',
      visibility_confirmation_required: '房间显示规则已变更，请确认允许的状态后继续。',
      invalid_visibility: '请选择有效的显示状态。', invalid_frame: '当前房间服务暂不支持此操作，请更新服务后重试。' })[code] || '操作未完成，请稍后重试。';
  }
  async call(path, data, method = data === undefined ? 'GET' : 'POST', auth = true) {
    const gen = this.generation, token = auth ? await this.getAccessToken() : null;
    if (gen !== this.generation) throw new Error('账号已切换。');
    if (auth && !token) throw new Error('请登录 SEKAI Pass。');
    const response = await this.fetcher(this.base + path, { method, cache: 'no-store',
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}) });
    const value = await response.json();
    if (gen !== this.generation) throw new Error('账号已切换。');
    if (!response.ok) throw Object.assign(new Error(RoomManager.error(value.code)), { code: value.code });
    return value;
  }
  async list(mine = false, cursor = '', refresh = false) {
    const key = [mine, cursor].join(':'), saved = this.cache.get(key);
    if (!refresh && saved && Date.now() - saved.at < 30000) return saved.value;
    const value = await this.call((mine ? '/me/rooms' : '/rooms') + '?cursor=' + encodeURIComponent(cursor), undefined, 'GET', mine);
    this.cache.set(key, { at: Date.now(), value }); return value;
  }
  async enter(id, secret) {
    this.disconnect(); const gen = this.roomGeneration;
    const value = await this.call('/rooms/' + id + (secret ? '/invites/preview' : ''), secret ? { secret } : undefined);
    if (gen !== this.roomGeneration) return;
    this.room = value.room; this.role = value.role; this.secret = secret; this.update();
    if (this.role) this.connect();
  }
  connect() { this.status = '连接中…'; this.transport.connect(this.room.id); this.update(); }
  async action(endpoint, input = {}, method = 'POST') {
    const id = this.room.id, gen = this.roomGeneration;
    const value = await this.call('/rooms/' + id + endpoint, input, method);
    this.cache.clear();
    if (gen !== this.roomGeneration) return;
    if (value.room && value.room.revision >= (this.room?.revision || 0)) { this.room = value.room; this.role = value.role; }
    this.status = value.syncing ? '目录同步中，请稍后重试确认。' : '';
    if (endpoint === '/leave' || value.role === null) this.disconnect();
    this.update(); return value;
  }
  async join() {
    const gen = this.roomGeneration;
    await this.action(this.secret ? '/invites/accept' : '/join', this.secret ? { secret: this.secret } : {});
    if (gen !== this.roomGeneration) return;
    this.secret = null; if (this.room && this.role) this.connect();
  }
  request(type, input = {}) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(requestId); reject(new Error('响应超时，可重试。')); }, 12000);
      this.requests.set(requestId, { resolve, reject, timer });
      if (!this.transport.send({ ...input, type, requestId })) { clearTimeout(timer); this.requests.delete(requestId); reject(new Error('连接恢复后再试。')); }
    });
  }
  merge(messages) {
    for (const message of messages) { this.messages.set(message.seq, message); if (message.senderId === this.user?.id) this.pending.delete(message.clientMessageId); }
    while (this.messages.has(this.syncedSeq + 1)) this.syncedSeq++;
  }
  receive(data) {
    const presenceChanged = data.online && JSON.stringify(data.online) !== JSON.stringify(this.online);
    if (data.online) this.online = data.online;
    if (data.type === 'ready' || data.type === 'room:visibility-required') {
      if (this.user && data.user.id !== this.user.id) { this.reset(); return; }
      const required = data.type === 'room:visibility-required';
      this.user = data.user; this.room = data.room; this.role = data.role; this.ready = !required; this.status = required ? '请确认房间显示规则' : '';
      const supported = ['online', 'offline', 'hidden'].includes(data.visibility);
      Object.assign(this.visibilityState, { visibility: supported ? data.visibility : null, available: supported, required,
        reason: required ? 'policy' : supported ? '' : 'unsupported', error: '' });
      if (required) {
        this.messages.clear(); this.pending.clear(); this.members = []; this.online = []; this.memberRevision++;
        this.loaded = false; this.syncedSeq = 0;
      }
      if (data.messages) {
        const initial = !this.loaded;
        if (initial) { this.syncedSeq = data.messages.length ? data.messages[0].seq - 1 : 0; this.loaded = true; this.moreBefore = (data.messages[0]?.seq || 0) > 1; }
        this.merge(data.messages); if (!initial && data.more) void this.sync();
      }
    }
    if (data.type === 'room:visibility' && data.userId === this.user?.id && ['online', 'offline', 'hidden'].includes(data.visibility)) {
      Object.assign(this.visibilityState, { visibility: data.visibility, available: this.ready, reason: '', error: '' });
    }
    if (Array.isArray(data.members)) { this.members = data.members.filter(member => member.status === 'active'); this.memberRevision++; }
    if (data.type === 'message' || data.type === 'ack') {
      this.merge([data.message]);
      if (this.loaded && data.message.seq > this.syncedSeq) void this.sync();
    }
    if (data.type === 'changed' && data.room.revision >= (this.room?.revision || 0)) { this.room = data.room; this.role = this.user.id === data.room.ownerId ? 'owner' : 'member'; }
    const request = this.requests.get(data.requestId);
    if (request) {
      clearTimeout(request.timer); this.requests.delete(data.requestId);
      if (data.type === 'error') request.reject(Object.assign(new Error(data.code === 'message_repeated'
        ? `相似内容发送过于频繁，请在 ${data.retryAfter || 60} 秒后再试。` : RoomManager.error(data.code)),
        { code: data.code, retryAfter: data.retryAfter })); else request.resolve(data);
    } else if (data.type === 'error') this.status = RoomManager.error(data.code);
    if (this.ready && ((data.type === 'presence' && presenceChanged && !data.members) || data.type === 'changed' || data.type === 'ready' && data.cursor)) void this.refreshMembers();
    this.update();
  }
  async refreshMembers() {
    const gen = this.roomGeneration, id = this.room?.id;
    if (!id || !this.role) return;
    if (this.membersLoading === gen) { this.membersDirty = true; return; }
    this.membersLoading = gen; this.membersDirty = false;
    const revision = this.memberRevision;
    try {
      let cursor = '', members = [];
      do {
        const page = await this.call('/rooms/' + id + '/members?view=roster&cursor=' + encodeURIComponent(cursor));
        if (gen !== this.roomGeneration || revision !== this.memberRevision) return;
        members.push(...page.members.filter(member => member.status === 'active')); cursor = page.cursor;
      } while (cursor);
      this.members = members; this.update();
    } catch { /* Keep the authenticated snapshot until the next membership update. */ }
    finally {
      if (this.membersLoading === gen) {
        this.membersLoading = null;
        if (gen === this.roomGeneration && this.membersDirty) void this.refreshMembers();
      }
    }
  }
  async sync() {
    if (this.syncing) return this.syncing;
    const gen = this.roomGeneration;
    this.syncing = (async () => {
      let more;
      do {
        const data = await this.request('history', { afterSeq: this.syncedSeq });
        if (gen !== this.roomGeneration) return;
        this.merge(data.messages); more = data.more; this.update();
        if (more) await new Promise(resolve => setTimeout(resolve, 120));
      } while (more);
    })().catch(error => { if (gen === this.roomGeneration) { this.status = error.message; this.update(); } })
      .finally(() => { if (gen === this.roomGeneration) this.syncing = null; });
    return this.syncing;
  }
  async older() {
    const gen = this.roomGeneration, data = await this.request('history', { beforeSeq: Math.min(...this.messages.keys()) });
    if (gen !== this.roomGeneration) return;
    this.merge(data.messages); this.moreBefore = data.more; this.update();
  }
  async send(content, retry) {
    const item = retry || { ...content, clientMessageId: crypto.randomUUID() }, gen = this.roomGeneration;
    this.pending.set(item.clientMessageId, item); this.update();
    try { await this.request('send', item); }
    catch (error) { if (gen === this.roomGeneration && this.pending.has(item.clientMessageId)) { item.error = error.message; this.update(); } }
  }
  destroy() { this.destroyed = true; this.reset(); this.off.forEach(off => off()); }
}
