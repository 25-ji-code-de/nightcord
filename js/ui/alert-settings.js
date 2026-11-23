/* SPDX-License-Identifier: AGPL-3.0-only */
class AlertSettingsView {
  constructor(alerts) {
    this.alerts = alerts; this.controls = new Map();
    this.open = () => this.mount();
    window.addEventListener('nightcord:settings-open', this.open);
  }
  node(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  icon(kind) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(name, value);
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', kind === 'chevron' ? 'm6 9 6 6 6-6' : 'm11 5-6 4H2v6h3l6 4V5Zm4 3a5 5 0 0 1 0 8m3-11a9 9 0 0 1 0 14');
    svg.append(path); return svg;
  }
  save(change) {
    const saved = this.alerts.preferences.save(change);
    this.alerts.settingsChanged();
    if (this.status) this.status.textContent = saved ? '已保存，仅对当前身份和聊天室生效。' : '浏览器无法保存，改动仅在当前页面保留。';
    this.refresh();
    return saved;
  }
  toggle(parent, label, description = '', accessibleName = label) {
    const row = this.node('label', '', 'settings-toggle alert-toggle');
    const copy = this.node('span', '', 'settings-toggle-copy');
    copy.append(this.node('span', label, 'settings-toggle-title'));
    if (description) copy.append(this.node('span', description, 'settings-description'));
    const input = this.node('input'); input.type = 'checkbox'; input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', accessibleName);
    const track = this.node('span', '', 'settings-toggle-track'); track.setAttribute('aria-hidden', 'true');
    row.append(copy, input, track); parent.append(row);
    return input;
  }
  checkbox(parent, key, label, description = '', accessibleName = label) {
    const input = this.toggle(parent, label, description, accessibleName); input.dataset.alert = key;
    input.addEventListener('change', () => this.save(prefs => { prefs[key] = input.checked; }));
    this.controls.set(key, input);
  }
  choices(parent, key, label, options) {
    const group = this.node('fieldset', '', 'alert-choice'); group.dataset.alertChoice = key;
    group.append(this.node('legend', label));
    const choices = this.node('div', '', 'alert-segments');
    for (const [value, text] of options) {
      const option = this.node('label', '', 'alert-option'), input = this.node('input');
      input.type = 'radio'; input.name = `nightcord-alert-${key}`; input.value = value; input.dataset.alert = key;
      input.addEventListener('change', () => { if (input.checked) this.save(prefs => { prefs[key] = value; }); });
      option.append(input, this.node('span', text)); choices.append(option);
    }
    group.append(choices); parent.append(group); this.controls.set(key, group);
  }
  heading(parent, label, description, kind, level = 'h3') {
    const header = this.node('div', '', 'alert-kind-heading'), copy = this.node('div');
    copy.append(this.node(level, label));
    if (description) copy.append(this.node('p', description, 'settings-description'));
    header.append(copy);
    if (kind) header.append(this.preview(kind, label));
    parent.append(header);
  }
  kind(parent, kind, label, description) {
    const group = this.node('section', '', 'alert-kind'); group.setAttribute('aria-label', label);
    this.heading(group, label, description, kind, 'h4');
    const controls = this.node('div', '', 'alert-kind-controls');
    this.checkbox(controls, `${kind}Notice`, '提醒', '', `${label}：站内提醒`);
    this.checkbox(controls, `${kind}Sound`, '声音', '', `${label}：声音`);
    group.append(controls); parent.append(group);
  }
  disclosure(parent, key, title, description) {
    const details = this.node('details', '', 'alert-disclosure'); details.dataset.alertSection = key;
    const summary = this.node('summary'), copy = this.node('span');
    copy.append(this.node('span', title, 'alert-disclosure-title'));
    if (description) copy.append(this.node('span', description, 'alert-disclosure-description'));
    summary.append(copy, this.icon('chevron')); details.append(summary); parent.append(details);
    return details;
  }
  mount() {
    const content = document.querySelector('#appearance-settings .settings-content');
    if (!content) return;
    if (this.root?.parentElement === content) { this.refresh(); return; }
    this.root?.remove(); this.controls.clear();
    this.root = this.node('section', '', 'alert-settings'); this.root.setAttribute('aria-label', '提醒与声音');
    this.root.append(this.node('h2', '提醒与声音'));
    this.context = this.node('p', '', 'settings-description'); this.root.append(this.context);
    this.fields = this.node('fieldset'); this.fields.className = 'alert-fields'; this.root.append(this.fields);
    const general = this.node('div', '', 'alert-general'); this.fields.append(general);
    this.checkbox(general, 'sound', '提醒声音', '消息与成员动态的声音总开关');
    const volume = this.node('label', '', 'alert-volume'); volume.append(this.node('span', '音量'));
    const range = this.node('input'); range.type = 'range'; range.min = '0'; range.max = '100'; range.step = '5'; range.dataset.alert = 'volume';
    range.setAttribute('aria-label', '提醒音量');
    this.volumeLabel = this.node('output');
    range.addEventListener('input', () => this.updateVolume(range));
    range.addEventListener('change', () => this.save(prefs => { prefs.volume = Number(range.value) / 100; }));
    volume.append(range, this.volumeLabel); general.append(volume); this.controls.set('volume', range);
    const pause = this.node('label', '', 'alert-select'); pause.append(this.node('span', '暂停提醒'));
    this.pause = this.node('select'); this.pause.dataset.alert = 'pause';
    for (const [value, label] of [['off', '正常提醒'], ['hour', '1 小时'], ['tomorrow', '到明天'], ['manual', '直到手动恢复']]) {
      const option = this.node('option', label); option.value = value; this.pause.append(option);
    }
    this.timedPause = this.node('option'); this.timedPause.value = 'until'; this.timedPause.hidden = true; this.pause.append(this.timedPause);
    this.pause.addEventListener('change', () => {
      const mode = this.pause.value;
      if (mode === 'until') return;
      this.save(prefs => {
        const tomorrow = new Date(); tomorrow.setHours(24, 0, 0, 0);
        prefs.pausedUntil = mode === 'off' ? 0 : mode === 'hour' ? Date.now() + 3600000
          : mode === 'tomorrow' ? tomorrow.getTime() : Number.MAX_SAFE_INTEGER;
      });
    });
    const select = this.node('span', '', 'alert-select-control'); select.append(this.pause, this.icon('chevron'));
    pause.append(select); general.append(pause);
    const advanced = this.disclosure(this.fields, 'sound', '更多声音选项');
    this.checkbox(advanced, 'awayOnly', '阅读时静音', '正在查看最新消息时，不播放提醒音');
    this.checkbox(advanced, 'effects', '进入/退出音效', '进入聊天室，或加入/离开语音会话时播放声音');

    const message = this.node('section', '', 'alert-message'); this.fields.append(message);
    this.heading(message, '新消息', '普通聊天消息的提示方式', 'message');
    const modes = [['off', '关闭'], ['away', '未被查看时'], ['always', '始终']];
    this.choices(message, 'messageNotice', '悬浮提醒', modes);
    this.choices(message, 'message', '提示声音', modes);
    message.append(this.node('p', '“未被查看时”包括离开页面、浏览历史记录或打开其他面板。', 'alert-hint'));

    const mentions = this.node('section', '', 'alert-category'); mentions.append(this.node('h3', '回复与提及')); this.fields.append(mentions);
    this.kind(mentions, 'reply', '回复我', '显示在输入框上方');
    this.kind(mentions, 'mention', '@ 我', '保留该卡片，直到您查看或将其关闭');
    this.kind(mentions, 'everyone', '全体提及', '有人提及聊天室中的所有人');

    const presence = this.disclosure(this.fields, 'presence', '成员动态与关注', '选择您希望追踪的在线/离线状态更新');
    this.choices(presence, 'presence', '提醒范围', [['off', '关闭'], ['followed', '关注的人'], ['all', '所有人']]);
    this.kind(presence, 'online', '成员上线', '在上线 2 秒后发出通知');
    this.kind(presence, 'offline', '成员下线', '在离开 15 秒后提醒，忽略短暂掉线');
    presence.append(this.node('p', '打开成员的个人资料卡，即可关注其在线或离线状态。', 'alert-hint'));
    this.followed = this.node('div', '', 'alert-followed'); presence.append(this.followed);
    this.activity = this.node('div', '', 'alert-activity'); presence.append(this.activity);
    this.status = this.node('p', '', 'alert-status'); this.status.setAttribute('role', 'status');
    this.root.append(this.status, this.node('p', '在暂停期间，收件箱记录仍会保留。当屏幕锁定或网页关闭时，系统不会发送通知。', 'alert-hint alert-footnote'));
    content.append(this.root); this.refresh();
  }
  preview(kind, label) {
    const button = this.node('button', '', 'alert-preview'); button.type = 'button';
    button.append(this.icon('sound'), this.node('span', '试听'));
    button.setAttribute('aria-label', `试听${label}音效`);
    button.addEventListener('click', async () => {
      const prefs = this.alerts.preferences.read();
      if (!prefs.volume) { this.status.textContent = '当前音量为 0，请先调高提醒音量。'; return; }
      // Explicit preview is allowed even while notifications are muted/paused.
      const played = await this.alerts.sounds.play(kind === 'everyone' ? 'message' : kind, prefs.volume);
      if (this.status) this.status.textContent = played ? `正在试听：${label}。` : this.alerts.sounds.state === 'blocked'
        ? '浏览器尚未允许播放，请再次点击试听。' : '音效加载失败，请检查网络后重试。';
    });
    return button;
  }
  updateVolume(range) {
    this.volumeLabel.textContent = `${range.value}%`;
    range.setAttribute('aria-valuetext', `${range.value}%`);
    range.style.setProperty('--alert-volume', `${range.value}%`);
  }
  refresh() {
    if (!this.root) return;
    const prefs = this.alerts.preferences.read(), scope = this.alerts.preferences.key();
    this.fields.disabled = !scope;
    this.fields.hidden = !scope;
    this.context.textContent = scope ? `仅对「${this.alerts.ui.elements.roomName?.textContent || this.alerts.ui.currentRoom}」生效，自动保存在此浏览器。`
      : '进入聊天室后即可设置提醒。';
    for (const [key, control] of this.controls) {
      if (control.matches('fieldset')) {
        for (const input of control.querySelectorAll('input')) input.checked = input.value === prefs[key];
      } else if (control.type === 'checkbox') control.checked = prefs[key];
      else control.value = key === 'volume' ? String(Math.round(prefs.volume * 100)) : prefs[key];
    }
    this.updateVolume(this.controls.get('volume'));
    this.timedPause.hidden = prefs.pausedUntil <= Date.now() || prefs.pausedUntil === Number.MAX_SAFE_INTEGER;
    const until = new Date(Math.min(prefs.pausedUntil, 8640000000000000));
    this.timedPause.textContent = `至 ${until.toLocaleDateString([], { month: 'numeric', day: 'numeric' })} ${until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    this.pause.value = prefs.pausedUntil <= Date.now() ? 'off' : prefs.pausedUntil === Number.MAX_SAFE_INTEGER ? 'manual' : 'until';
    if (this.alerts.paused(prefs)) this.status.textContent = prefs.pausedUntil === Number.MAX_SAFE_INTEGER ? '已暂停提醒，手动恢复后生效。'
      : `已暂停至 ${new Date(prefs.pausedUntil).toLocaleString()}。`;
    else if (this.alerts.sounds.state === 'blocked') this.status.textContent = '浏览器尚未允许播放，点击试听可启用后续音效。';
    this.followed.replaceChildren(this.node('h3', '已关注成员'));
    const entries = Object.entries(prefs.followed);
    if (!entries.length) this.followed.append(this.node('p', '尚未关注任何成员。', 'settings-description'));
    for (const [id, follow] of entries) {
      const row = this.node('div', '', 'alert-follow-row');
      const avatar = this.node('span', Array.from(follow.name)[0] || '?', 'alert-follow-avatar'); avatar.setAttribute('aria-hidden', 'true');
      const copy = this.node('span', '', 'alert-follow-copy');
      copy.append(this.node('span', follow.name), this.node('small', [follow.online && '上线提醒', follow.offline && '下线提醒'].filter(Boolean).join(' · ')));
      row.append(avatar, copy);
      const remove = this.node('button', '取消关注'); remove.type = 'button'; remove.setAttribute('aria-label', `取消关注 ${follow.name}`);
      remove.addEventListener('click', () => {
        this.save(prefs => { delete prefs.followed[id]; });
        (this.followed.querySelector('button') || this.followed.closest('details').querySelector('summary')).focus();
      }); row.append(remove); this.followed.append(row);
    }
    this.refreshActivity();
  }
  refreshActivity() {
    if (!this.activity) return;
    this.activity.replaceChildren(this.node('h3', '近期动态'));
    if (!this.alerts.recent.length) this.activity.append(this.node('p', '自您上次打开此页面以来，没有新的成员通知。', 'settings-description'));
    for (const event of this.alerts.recent.slice(0, 10)) {
      const row = this.node('p', '', 'alert-activity-row');
      const time = this.node('time', new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      time.dateTime = new Date(event.at).toISOString(); row.append(time, this.node('span', event.text)); this.activity.append(row);
    }
  }
  profile(profile, parent) {
    const scope = this.alerts.preferences.key();
    if (!scope || !profile.id || profile.id === this.alerts.ui.currentUser?.id) return;
    const group = this.node('fieldset', '', 'alert-profile'); group.append(this.node('legend', '关注动态'));
    group.append(this.node('p', '仅提醒这个聊天室中的上线与下线。', 'alert-hint'));
    const follow = this.alerts.preferences.read().followed[profile.id];
    const controls = {};
    const status = this.node('p', '', 'alert-status'); status.setAttribute('role', 'status');
    for (const [kind, text] of [['online', '上线时提醒我'], ['offline', '下线时提醒我']]) {
      const input = this.toggle(group, text);
      input.checked = follow?.[kind] === true; input.dataset.follow = kind; controls[kind] = input;
      input.addEventListener('change', () => {
        if (scope !== this.alerts.preferences.key()) { group.disabled = true; return; }
        const saved = this.save(prefs => {
          if (!controls.online.checked && !controls.offline.checked) delete prefs.followed[profile.id];
          else prefs.followed[profile.id] = { name: profile.displayName, online: controls.online.checked, offline: controls.offline.checked };
        });
        status.textContent = saved ? '已保存关注设置。' : '无法保存，关注仅在当前页面保留。';
        if (this.alerts.preferences.read().presence === 'off') status.textContent += ' 当前已关闭成员动态，请在设置中开启。';
      });
    }
    group.append(this.node('p', '短暂掉线不会提醒。声音可在设置中调整。', 'alert-hint'), status); parent.append(group);
  }
  destroy() { window.removeEventListener('nightcord:settings-open', this.open); this.root?.remove(); }
}
