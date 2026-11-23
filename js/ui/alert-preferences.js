/* SPDX-License-Identifier: AGPL-3.0-only */
class AlertPreferences {
  static defaults = {
    sound: true, volume: 0.5, effects: true, awayOnly: false, pausedUntil: 0,
    message: 'away', messageNotice: 'away', mentionSound: true, mentionNotice: true,
    replySound: true, replyNotice: true, everyoneSound: false, everyoneNotice: true,
    presence: 'followed', onlineNotice: true, onlineSound: true,
    offlineNotice: true, offlineSound: false, followed: {}
  };

  constructor(getScope) { this.getScope = getScope; this.memory = new Map(); this.unsaved = new Set(); }
  key() {
    const { room, userId } = this.getScope();
    return room && userId ? `nightcord-alerts:${encodeURIComponent(userId)}:${encodeURIComponent(room)}` : null;
  }
  normalize(data) {
    const defaults = AlertPreferences.defaults, result = { ...defaults, followed: {} };
    if (!data || typeof data !== 'object') return result;
    for (const [key, value] of Object.entries(defaults)) {
      if (typeof value === 'boolean' && typeof data[key] === 'boolean') result[key] = data[key];
    }
    if (Number.isFinite(data.volume)) result.volume = Math.max(0, Math.min(1, data.volume));
    if (Number.isFinite(data.pausedUntil) && data.pausedUntil >= 0) result.pausedUntil = data.pausedUntil;
    if (['off', 'away', 'always'].includes(data.message)) result.message = data.message;
    if (['off', 'away', 'always'].includes(data.messageNotice)) result.messageNotice = data.messageNotice;
    if (['off', 'followed', 'all'].includes(data.presence)) result.presence = data.presence;
    for (const [id, follow] of Object.entries(data.followed || {}).slice(0, 500)) {
      if (!/^(sekai|guest):.{1,240}$/.test(id) || !follow || typeof follow !== 'object') continue;
      result.followed[id] = {
        name: typeof follow.name === 'string' ? follow.name.slice(0, 100) : id,
        online: follow.online !== false, offline: follow.offline === true
      };
    }
    return result;
  }
  read() {
    const key = this.key();
    if (!key) return this.normalize(null);
    if (this.unsaved.has(key)) return this.memory.get(key);
    try {
      const value = this.normalize(JSON.parse(localStorage.getItem(key) || 'null'));
      this.memory.set(key, value); return value;
    } catch { return this.memory.get(key) || this.normalize(null); }
  }
  save(change) {
    const key = this.key();
    if (!key) return false;
    const value = this.read(); change(value);
    const normalized = this.normalize(value);
    this.memory.set(key, normalized);
    try { localStorage.setItem(key, JSON.stringify(normalized)); this.unsaved.delete(key); }
    catch { this.unsaved.add(key); }
    return !this.unsaved.has(key);
  }
  invalidate(key) {
    if (key === null) { this.memory.clear(); this.unsaved.clear(); }
    else { this.memory.delete(key); this.unsaved.delete(key); }
  }
}
