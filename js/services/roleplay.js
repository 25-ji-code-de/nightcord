/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/**
 * 语C：以角色名发言。
 *
 * 线路格式为 `[角色:名字]正文`，由真实发送者发出；接收端解析后用与 AI 回复相同的
 * 「由 …… 转发」样式显示，所以角色不是账号，也无法冒充别人。
 * 只在 ROOM_ID 房间内编码和解析，其他房间的消息原样处理。
 * 依赖（存储、当前房间、保留名）全部注入，本文件不接触 DOM 或 localStorage。
 */
class Roleplay {
  static ROOM_ID = 'nightcord-roleplay';
  static DEFAULT_ROLES = Object.freeze(['K', '雪', 'えななん', 'Amia']);
  static AVATARS = Object.freeze({
    K: '/icons/roleplay/k.png',
    雪: '/icons/roleplay/yuki.png',
    えななん: '/icons/roleplay/enanan.png',
    Amia: '/icons/roleplay/amia.png'
  });
  static MAX_CUSTOM = 16;
  static MAX_NAME = 16;
  static ROLES_KEY = 'nightcord-roleplay-roles';
  static ACTIVE_KEY = 'nightcord-roleplay-active';
  static WIRE = /^\[角色:([^\[\]\r\n]+)\]([\s\S]+)$/;

  constructor({ settings, getRoom, reserved = () => [] }) {
    Object.assign(this, { settings, getRoom, reserved });
    this.custom = this.loadCustom();
    const active = this.read(Roleplay.ACTIVE_KEY);
    // 恢复旧版默认角色的选择；同名自定义角色仍使用用户保存的名称。
    const restored = active === 'Yuki' ? '雪' : active === 'Enanan' ? 'えななん' : active;
    this.active = this.roles.includes(active) ? active : this.roles.includes(restored) ? restored : null;
    if (this.active && this.active !== active) this.write(Roleplay.ACTIVE_KEY, this.active);
  }

  get roles() { return [...Roleplay.DEFAULT_ROLES, ...this.custom]; }

  static avatarUrl(name) {
    const role = name === 'Yuki' ? '雪' : name === 'Enanan' ? 'えななん' : name;
    return Object.hasOwn(Roleplay.AVATARS, role) ? Roleplay.AVATARS[role] : null;
  }

  inRoom(room = this.getRoom()) { return room === Roleplay.ROOM_ID; }

  isCustom(name) { return this.custom.includes(name); }

  read(key) {
    try { return this.settings.getItem(key); } catch { return null; }
  }

  write(key, value) {
    try { this.settings.setItem(key, value); return true; } catch { return false; }
  }

  loadCustom() {
    let stored;
    try { stored = JSON.parse(this.read(Roleplay.ROLES_KEY) || '[]'); } catch { stored = []; }
    const custom = [];
    for (const value of Array.isArray(stored) ? stored : []) {
      const checked = this.validate(value, [...Roleplay.DEFAULT_ROLES, ...custom]);
      if (checked.ok && custom.length < Roleplay.MAX_CUSTOM) custom.push(checked.name);
    }
    return custom;
  }

  /** @returns {{ok: true, name: string} | {ok: false, error: string}} */
  validate(value, existing = this.roles) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name) return { ok: false, error: '请输入角色名称。' };
    if ([...name].length > Roleplay.MAX_NAME) return { ok: false, error: `角色名称不能超过 ${Roleplay.MAX_NAME} 个字符。` };
    if (/[\[\]\p{Cc}]/u.test(name)) return { ok: false, error: '角色名称不能包含方括号或控制字符。' };
    const key = name.toLowerCase();
    if (key === '系统' || this.reserved().some(reserved => String(reserved).toLowerCase() === key)) {
      return { ok: false, error: '该名称已被系统或 AI 使用。' };
    }
    if (existing.some(role => role.toLowerCase() === key)) return { ok: false, error: '已经有同名角色。' };
    return { ok: true, name };
  }

  add(value) {
    if (this.custom.length >= Roleplay.MAX_CUSTOM) return { ok: false, error: `最多添加 ${Roleplay.MAX_CUSTOM} 个自定义角色。` };
    const checked = this.validate(value);
    if (!checked.ok) return checked;
    this.custom.push(checked.name);
    this.saveCustom();
    return checked;
  }

  /** 默认角色不可删除。 */
  remove(name) {
    if (!this.isCustom(name)) return false;
    this.custom = this.custom.filter(role => role !== name);
    this.saveCustom();
    if (this.active === name) this.select(null);
    return true;
  }

  /** @param {string|null} name 角色名；null 表示以本人身份发言。 */
  select(name) {
    this.active = name !== null && this.roles.includes(name) ? name : null;
    this.write(Roleplay.ACTIVE_KEY, this.active || '');
    return this.active;
  }

  saveCustom() { this.write(Roleplay.ROLES_KEY, JSON.stringify(this.custom)); }

  /** 在语C且已选角色时给消息加上角色前缀，否则原样返回。 */
  encode(message) {
    return this.active && this.inRoom() ? `[角色:${this.active}]${message}` : message;
  }

  /**
   * 解析收到的消息。只在语C内生效，名称必须合法且不能是 AI 或系统名，
   * 否则按普通消息显示，避免用角色前缀伪造 AI 或系统消息。
   * @returns {{name: string, text: string} | null}
   */
  decode(message, room) {
    if (!this.inRoom(room) || typeof message !== 'string') return null;
    const match = Roleplay.WIRE.exec(message);
    if (!match) return null;
    const checked = this.validate(match[1], []);
    if (!checked.ok || checked.name !== match[1]) return null;
    return { name: checked.name, text: match[2] };
  }
}
