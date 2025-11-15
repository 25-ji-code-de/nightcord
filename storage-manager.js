/**
 * StorageManager - 负责按房间管理 localStorage 中的消息存取与旧数据迁移
 */
class StorageManager {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.legacyMessagesKey] 旧的 messages key
   * @param {string} [opts.legacyLastKey] 旧的 lastmsg key
   * @param {string} [opts.defaultRoom] 默认房间名
   */
  constructor(opts = {}) {
    this.legacyMessagesKey = opts.legacyMessagesKey || 'nightcord-messages';
    this.legacyLastKey = opts.legacyLastKey || 'nightcord-lastmsg';
    this.defaultRoom = opts.defaultRoom || 'nightcord-default';

    // 自动执行一次旧数据迁移（如果存在旧键）
    try {
      this.migrateLegacy();
    } catch (e) {
      // 不阻塞主流程
      console.warn('StorageManager: migrateLegacy failed', e);
    }
  }

  storageKeyMessages(room) { return `nightcord-messages:${room}`; }
  storageKeyLastMsg(room) { return `nightcord-lastmsg:${room}`; }

  loadMessages(room) {
    try {
      return JSON.parse(localStorage.getItem(this.storageKeyMessages(room)) || '[]');
    } catch (e) { return []; }
  }

  saveMessages(room, msgs) {
    try { localStorage.setItem(this.storageKeyMessages(room), JSON.stringify(msgs)); } catch (e) {}
  }

  getLastMsgTimestamp(room) {
    try { return Number(localStorage.getItem(this.storageKeyLastMsg(room)) || 0); } catch (e) { return 0; }
  }

  setLastMsgTimestamp(room, ts) {
    try { localStorage.setItem(this.storageKeyLastMsg(room), String(ts)); } catch (e) {}
  }

  // 迁移旧数据到 per-room key（将旧的 nightcord-messages 移动到 defaultRoom）
  migrateLegacy() {
    // 读取旧数据
    let oldMsgs = null;
    try {
      const raw = localStorage.getItem(this.legacyMessagesKey);
      if (raw) oldMsgs = JSON.parse(raw);
    } catch (e) { oldMsgs = null; }

    // 如果没有旧消息则仅确保 lastmsg 也被迁移/清理
    if (!Array.isArray(oldMsgs) || oldMsgs.length === 0) {
      // 仍尝试迁移 lastmsg（如果存在）到 defaultRoom
      try {
        const last = localStorage.getItem(this.legacyLastKey);
        if (last) {
          localStorage.setItem(this.storageKeyLastMsg(this.defaultRoom), last);
          localStorage.removeItem(this.legacyLastKey);
        }
      } catch (e) {}
      return;
    }

    // 将旧消息合并到 defaultRoom 的现有消息中，避免重复（以 timestamp+user+text 判重）
    const existing = this.loadMessages(this.defaultRoom) || [];
    const idx = {};
    existing.forEach(m => { idx[`${m.timestamp}_${m.user}_${m.text}`] = true; });
    const toAppend = [];
    oldMsgs.forEach(m => {
      const key = `${m.timestamp}_${m.user}_${m.text}`;
      if (!idx[key]) {
        toAppend.push(m);
        idx[key] = true;
      }
    });
    // 将旧消息放在现有消息之前（保留时间顺序：旧的应该在前）
    const merged = [...existing, ...toAppend];
    // 限制长度（与 UI 使用的相同策略）
    const MAX = 2000;
    const trimmed = merged.length > MAX ? merged.slice(merged.length - MAX) : merged;
    this.saveMessages(this.defaultRoom, trimmed);

    // 迁移 lastmsg（如果存在旧的，则以旧的为准，除非已有更大的值）
    try {
      const oldLast = Number(localStorage.getItem(this.legacyLastKey) || 0);
      const curLast = this.getLastMsgTimestamp(this.defaultRoom) || 0;
      const finalLast = Math.max(curLast, oldLast);
      if (finalLast > 0) this.setLastMsgTimestamp(this.defaultRoom, finalLast);
    } catch (e) {}

    // 删除旧键
    try {
      localStorage.removeItem(this.legacyMessagesKey);
      localStorage.removeItem(this.legacyLastKey);
    } catch (e) {}
  }
}

// 使其在全局可用（兼容当前非模块化加载方式）
window.StorageManager = StorageManager;
