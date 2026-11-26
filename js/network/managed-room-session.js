/* SPDX-License-Identifier: AGPL-3.0-only */
class ManagedRoomProtocol {
  constructor(manager) { this.manager = manager; this.attempt = 0; }
  attach(connection) { this.connection = connection; }
  url(id) { return this.manager.base.replace(/^http/, 'ws') + '/rooms/' + id + '/websocket'; }
  reset() { clearTimeout(this.timer); clearTimeout(this.leaseTimer); this.authWork = null; this.expiresAt = 0; }
  async prepare(gen) {
    try {
      const token = await this.manager.getAccessToken();
      if (gen !== this.connection._gen) return;
      if (!token) throw new Error('请登录 SEKAI Pass。');
      return { token };
    } catch (error) {
      if (gen === this.connection._gen) { this.connection.pauseAutoReconnect(); this.manager.status = error.message; this.manager.update(); }
    }
  }
  open(ws, { token }) {
    this.connection.reconnectDelay = Math.min(30000, 1000 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.25);
    ws.send(JSON.stringify({ type: 'auth', requestId: crypto.randomUUID(), accessToken: token,
      ...(this.manager.loaded ? { afterSeq: this.manager.syncedSeq } : {}) }));
    this.timer = setTimeout(() => ws.close(1013, 'Authentication timeout'), 12000);
  }
  message(data, ws) {
    if (data.type === 'ready') {
      this.authWork = null; this.attempt = 0; this.connection.ready = true; this.expiresAt = data.authExpiresAt;
      clearTimeout(this.timer); clearTimeout(this.leaseTimer);
      this.timer = setTimeout(() => this.refreshAuthentication(), Math.max(1000, this.expiresAt - Date.now() - 60000));
      this.leaseTimer = setTimeout(() => { this.manager.messages.clear(); this.manager.ready = false; this.manager.update(); ws.close(4001); }, Math.max(0, this.expiresAt - Date.now()));
    }
    return true;
  }
  close(event) {
    this.reset();
    if ([4001, 4003].includes(event.code)) {
      this.connection.pauseAutoReconnect(); this.manager.clearRoom();
      this.manager.status = event.code === 4003 ? '已失去房间访问权限。' : '登录已过期，请重新进入房间。'; this.manager.update();
    }
  }
  canSend() { return !!this.expiresAt && this.expiresAt > Date.now(); }
  async refreshAuthentication() {
    if (this.authWork || !this.connection.isConnected()) return this.authWork;
    const ws = this.connection.ws, gen = this.connection._gen;
    this.authWork = (async () => {
      const value = await this.prepare(gen);
      if (!value || this.connection.ws !== ws) return;
      ws.send(JSON.stringify({ type: 'auth', requestId: crypto.randomUUID(), accessToken: value.token }));
      clearTimeout(this.timer); this.timer = setTimeout(() => ws.close(1013), 12000);
    })();
    return this.authWork;
  }
}
