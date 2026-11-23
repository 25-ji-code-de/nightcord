/* SPDX-License-Identifier: AGPL-3.0-only */
/** Same-origin tabs coordinate attention and serialize audible deliveries. */
class AlertDelivery {
  constructor(getState) {
    this.getState = getState;
    this.id = crypto.randomUUID?.() || [...crypto.getRandomValues(new Uint32Array(4))].join('-');
    this.peers = new Map();
    this.seen = new Map();
    this.pending = new Map();
    this.claims = new Map();
    try { this.channel = new BroadcastChannel('nightcord-alerts'); } catch { /* Single tab fallback. */ }
    if (this.channel) this.channel.onmessage = ({ data }) => {
      if (!data || data.id === this.id) return;
      if (data.type === 'state') {
        this.peers.set(data.id, { ...data, at: Date.now() });
        if (data.hello) this.announce();
      } else if (data.type === 'claim' && typeof data.key === 'string') {
        if (!this.claims.has(data.key)) this.claims.set(data.key, new Map());
        this.claims.get(data.key).set(data.id, Date.now());
        this.pending.get(data.key)?.candidates.add(data.id);
      } else if (data.type === 'delivered') this.seen.set(data.key, Date.now());
      else if (data.type === 'bye') this.peers.delete(data.id);
    };
    this.announce(true);
    this.timer = setInterval(() => this.announce(), 5000);
  }
  announce(hello = false) {
    if (this.destroyed) return;
    this.channel?.postMessage({ type: 'state', id: this.id, ...this.getState(), hello });
    const before = Date.now() - 15000;
    for (const [id, peer] of this.peers) if (peer.at < before) this.peers.delete(id);
    for (const [key, at] of this.seen) if (at < Date.now() - 60000) this.seen.delete(key);
    for (const [key, claims] of this.claims) {
      for (const [id, at] of claims) if (at < before) claims.delete(id);
      if (!claims.size) this.claims.delete(key);
    }
  }
  viewing(scope) {
    return (this.getState().scope === scope && this.getState().viewing)
      || [...this.peers.values()].some(peer => peer.scope === scope && peer.viewing && Date.now() - peer.at < 15000);
  }
  async deliver(key, callback) {
    if (this.destroyed || this.seen.has(key) || this.pending.has(key)) return;
    const state = this.getState();
    const token = { candidates: new Set([this.id, ...(this.claims.get(key)?.keys() || [])]), controller: new AbortController(), at: Date.now() };
    this.pending.set(key, token);
    const run = async () => {
      if (this.destroyed || this.getState().scope !== state.scope || this.seen.has(key) || Date.now() - token.at > 3000) return false;
      let recent = {};
      try { recent = JSON.parse(localStorage.getItem('nightcord-alert-delivery') || '{}'); } catch { /* memory fallback */ }
      if (!recent || typeof recent !== 'object' || Array.isArray(recent)) recent = {};
      if (Number(recent[key]) > Date.now() - 60000) return;
      if (!await callback()) return;
      this.seen.set(key, Date.now());
      recent = Object.fromEntries(Object.entries(recent).filter(([, at]) => Number(at) > Date.now() - 60000).slice(-250));
      recent[key] = Date.now();
      try { localStorage.setItem('nightcord-alert-delivery', JSON.stringify(recent)); } catch { /* channel still informs peers */ }
      this.channel?.postMessage({ type: 'delivered', id: this.id, key });
      return true;
    };
    try {
      if (navigator.locks?.request) {
        // Serialize a single event. If the first tab is blocked from playing,
        // another may try; successful delivery reaches peers before release.
        await navigator.locks.request(`nightcord-alert:${key}`, { signal: token.controller.signal }, async () => {
          if (await run() && !this.destroyed) {
            await new Promise(resolve => { token.release = resolve; token.timer = setTimeout(resolve, 150); });
          }
        });
      } else {
        this.channel?.postMessage({ type: 'claim', id: this.id, key });
        await new Promise(resolve => { token.release = resolve; token.timer = setTimeout(resolve, 160); });
        if ([...token.candidates].sort()[0] === this.id) await run();
      }
    } catch { /* A closed page or unavailable coordination must not break chat. */ }
    finally { clearTimeout(token.timer); this.pending.delete(key); }
  }
  destroy() {
    this.destroyed = true;
    clearInterval(this.timer);
    for (const pending of this.pending.values()) { pending.controller.abort(); clearTimeout(pending.timer); pending.release?.(); }
    this.pending.clear();
    this.channel?.postMessage({ type: 'bye', id: this.id });
    this.channel?.close();
  }
}
