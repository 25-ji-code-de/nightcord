/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** Persists sidebar data by room and identity, retaining unsaved changes in memory. */
const SidebarStorage = (() => {
const { validDate, timestamp, listOf, safeText } = SidebarHelpers;
return class SidebarStorage {
  constructor(getScope) {
    this.getScope = getScope;
    this.memory = new Map();
    this.unsaved = new Set();
    this.storageError = false;
  }

  key() {
    const { room, userId } = this.getScope();
    return room && userId ? `nightcord-sidebar:${encodeURIComponent(room)}:${encodeURIComponent(userId)}` : null;
  }

  read() {
    const key = this.key();
    if (!key) return { tasks: [], read: {} };
    if (this.unsaved.has(key)) return this.memory.get(key);
    let data;
    try { data = JSON.parse(localStorage.getItem(key) || '{}'); }
    catch { this.storageError = true; return this.memory.get(key) || { tasks: [], read: {} }; }
    const tasks = (Array.isArray(data?.tasks) ? data.tasks : []).filter(task => task && typeof task.id === 'string'
      && typeof task.title === 'string' && task.title.trim()).slice(0, 200).map(task => ({
      id: task.id.slice(0, 80), title: task.title.slice(0, 200), done: task.done === true, due: validDate(task.due) ? task.due : '',
      createdAt: timestamp(task.createdAt), completedAt: task.done === true ? timestamp(task.completedAt) : null,
      number: Number.isSafeInteger(task.number) && task.number > 0 ? task.number : null,
      operator: safeText(task.operator, 60), archived: task.done === true && task.archived === true,
      station: !task.archived && ['printer', 'clock'].includes(task.station) ? task.station : null,
      startedAt: task.done === true ? null : timestamp(task.startedAt),
      sessions: listOf(task.sessions).filter(s => timestamp(s?.end)).map(s => ({
        start: timestamp(s.start) && s.start <= s.end ? s.start : null, end: s.end,
      })),
      items: listOf(task.items).slice(0, 30).filter(i => typeof i?.text === 'string').map(i => ({ text: i.text.slice(0, 120), checked: i.checked === true })),
      notes: listOf(task.notes).filter(n => typeof n?.text === 'string').map(n => ({ id: safeText(n.id, 80), text: n.text.slice(0, 200), at: timestamp(n.at) })),
    }));
    const read = Object.fromEntries(Object.entries(data?.read && typeof data.read === 'object' ? data.read : {})
      .filter(([key, value]) => key.length < 300 && value === true && Number.isFinite(Number(key.split(':')[0])))
      .sort(([a], [b]) => Number(b.split(':')[0]) - Number(a.split(':')[0])).slice(0, 2000));
    const sequence = Math.max(Number.isSafeInteger(data?.sequence) && data.sequence > 0 ? data.sequence : 0, ...tasks.map(task => task.number || 0));
    const slips = listOf(data?.slips).filter(s => s && typeof s.id === 'string' && typeof s.text === 'string' && s.text.trim()).slice(0, 200)
      .map(s => ({id:s.id.slice(0,80), text:s.text.slice(0,200), at:timestamp(s.at), station:s.station === 'printer' ? 'printer' : 'loose'}));
    const state = { tasks, slips, read, sequence, operator: safeText(data?.operator, 60) };
    this.memory.set(key, state);
    return state;
  }

  save(change) {
    const key = this.key();
    if (!key) return null;
    const state = this.read();
    change(state);
    state.read = Object.fromEntries(Object.entries(state.read)
      .sort(([a], [b]) => Number(b.split(':')[0]) - Number(a.split(':')[0])).slice(0, 2000));
    this.memory.set(key, state);
    try {
      localStorage.setItem(key, JSON.stringify(state));
      this.unsaved.delete(key); this.storageError = false;
    } catch { this.unsaved.add(key); this.storageError = true; }
    return state;
  }
};
})();
