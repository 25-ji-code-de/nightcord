/* SPDX-License-Identifier: AGPL-3.0-only */
class RoomDestination {
  static valid(value) { return value && /^r_[a-f0-9]{32}$/.test(value.id) && (!value.secret || /^[a-f0-9]{64}$/.test(value.secret)); }
  static capture() {
    const params = new URLSearchParams(location.search), fragment = new URLSearchParams(location.hash.slice(1));
    const value = { id: params.get('room'), secret: fragment.get('invite') || undefined };
    if (fragment.has('invite')) history.replaceState({}, '', location.pathname + location.search);
    if (this.valid(value)) this.pending = value;
    else if (params.has('code') && params.has('state')) {
      try { const saved = JSON.parse(sessionStorage.getItem('nightcord-room-destination')); if (this.valid(saved)) this.pending = saved; } catch {}
    }
    try { sessionStorage.removeItem('nightcord-room-destination'); } catch { /* Storage can be blocked; keep the in-memory destination. */ }
  }
  static save() {
    try { if (this.valid(this.pending)) sessionStorage.setItem('nightcord-room-destination', JSON.stringify(this.pending)); } catch { /* Login can continue without a saved return destination. */ }
  }
  static clear() {
    this.pending = null;
    try { sessionStorage.removeItem('nightcord-room-destination'); } catch { /* No persistent destination is accessible. */ }
  }
}
