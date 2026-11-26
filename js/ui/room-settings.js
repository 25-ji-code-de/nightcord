/* SPDX-License-Identifier: AGPL-3.0-only */
class RoomSettingsView {
  constructor(view) { this.view = view; this.admin = new RoomAdminView(view); }
  mode(room) { return room.discoverability === 'listed' ? 'listed' : room.joinPolicy === 'open' ? 'link' : 'invite'; }
  modes() { return [
    ['invite', '仅限邀请', '不在大厅展示，受邀成员使用有效邀请链接加入。'],
    ['link', '链接加入', '不在大厅展示，已登录用户可通过房间链接加入。'],
    ['listed', '公开展示', '展示在大厅公开列表中，已登录用户可直接加入。']
  ]; }
  details() {
    const v = this.view, m = v.manager, room = m.room, a = this.admin;
    if (!room || !m.role) return;
    const root = a.page('details', '房间信息', '查看房间资料、成员和加入方式。');
    const summary = v.element('section', 'room-summary'); summary.setAttribute('aria-label', '房间资料');
    const emblem = v.element('span', 'room-emblem'); emblem.append(v.icon('channel'));
    const copy = v.element('div', 'room-summary-copy'), badges = v.element('div', 'room-badges');
    badges.append(v.element('span', 'rooms-badge', '已加入'));
    if (room.status === 'archived') badges.append(v.element('span', 'rooms-badge', '已归档'));
    copy.append(badges, v.element('h3', '', room.name), v.element('p', '', room.description || '暂无房间简介。'));
    summary.append(emblem, copy); root.append(summary);
    const mode = this.modes().find(item => item[0] === this.mode(room)), facts = v.element('dl', 'room-facts');
    for (const [label, value] of [['加入方式', mode[1]], ['当前身份', m.role === 'owner' ? '房主' : '成员'], ['房间状态', room.status === 'archived' ? '已归档 · 仅可阅读' : '正常']]) {
      const row = v.element('div'); row.append(v.element('dt', '', label), v.element('dd', '', value)); facts.append(row);
    }
    root.append(facts);
    if (room.status === 'active') {
      const share = a.section(root, '分享房间', room.joinPolicy === 'invite' ? '房间链接仅供已有成员访问。邀请新成员需由房主生成邀请链接。' : '已登录用户可通过此链接加入房间。');
      a.link(share, location.origin + '/?room=' + room.id);
    }
    const actions = a.section(root, m.role === 'owner' ? '房间管理' : '房间成员'), links = v.element('div', 'room-links'); actions.append(links);
    const link = (title, description, icon, action) => {
      const button = v.button('', () => a.guard(action), 'room-link'); button.setAttribute('aria-label', title);
      const text = v.element('span', 'room-link-copy'); text.append(v.element('strong', '', title), v.element('span', '', description));
      button.append(v.icon(icon), text, v.icon('arrow')); links.append(button);
    };
    link(m.role === 'owner' ? '成员管理' : '查看成员', m.role === 'owner' ? '查看成员资料、管理加入权限与房主身份' : '查看成员资料，提及成员或发送私信', 'members', () => this.members());
    if (m.role === 'owner') {
      link('邀请管理', room.status === 'archived' ? '房间已归档，全部邀请已失效' : '生成邀请链接，查看使用情况或撤销邀请', 'invite', () => this.invites());
      link('房间设置', '编辑房间资料、调整加入方式与归档房间', 'settings', () => this.form());
    } else {
      const leave = a.section(root, '退出房间', '退出后将无法查看消息，重新加入需满足房间的加入条件。');
      leave.append(v.button('退出房间', () => a.confirm({ title: '退出「' + room.name + '」？', description: '您将失去此房间的访问权限。', label: '退出房间', danger: true,
        action: async () => { const result = await m.action('/leave'); if (result && !m.room) await v.lobby(true); } }), 'rooms-button rooms-danger'));
    }
  }
  form(create = false) {
    const v = this.view, m = v.manager, a = this.admin, room = create ? {} : m.room;
    if (!create && (!room || m.role !== 'owner')) { this.details(); return; }
    const root = a.page(create ? 'create' : 'settings', create ? '创建房间' : '房间设置', create ? '填写房间资料，并选择成员加入的方式。' : '修改房间资料与加入方式，保存后生效。');
    const form = v.element('form', 'rooms-form room-settings-form'); root.append(form);
    const fields = v.element('fieldset', 'room-fields'); form.append(fields); fields.disabled = m.mode !== 'on';
    const basic = a.section(fields, '基本信息');
    const field = (parent, title, tag, value, max, help) => {
      const label = v.element('label', 'room-field'), input = v.element(tag);
      input.value = value || ''; input.maxLength = max; input.setAttribute('aria-label', title);
      label.append(v.element('span', '', title), input); parent.append(label);
      const hint = v.element('span', 'room-field-hint', help); hint.id = 'room-field-' + (tag === 'textarea' ? 'description' : 'name');
      label.append(hint); input.setAttribute('aria-describedby', hint.id); return input;
    };
    const name = field(basic, '房间名称', 'input', room.name, 60, '必填，最多 60 个字符。'); name.required = true; name.autocomplete = 'off';
    const description = field(basic, '简介', 'textarea', room.description, 280, '选填，最多 280 个字符。向成员说明房间的用途。');
    const policies = v.element('fieldset', 'room-policy'); policies.append(v.element('legend', '', '加入方式')); fields.append(policies);
    const options = [];
    for (const [value, title, detail] of this.modes()) {
      const label = v.element('label', 'room-policy-option'), input = v.element('input'); input.type = 'radio'; input.name = 'room-policy'; input.value = value;
      input.checked = value === (create ? 'invite' : this.mode(room)); input.setAttribute('aria-label', title); options.push(input);
      const text = v.element('span'); text.append(v.element('strong', '', title), v.element('span', '', detail)); label.append(input, text); policies.append(label);
    }
    const values = () => ({ name: name.value.trim(), description: description.value, mode: options.find(input => input.checked).value });
    let saved = JSON.stringify(values()), attempted;
    const requestId = crypto.randomUUID(); a.dirty = () => JSON.stringify(values()) !== saved;
    const footer = v.element('div', 'room-savebar'), note = v.element('span', 'room-save-note', create ? '创建后可邀请成员加入。' : '尚未修改');
    const save = v.button(create ? '创建房间' : '保存设置', () => {}, 'rooms-button rooms-primary'); save.type = 'submit'; save.disabled = !create || m.mode !== 'on';
    const cancel = v.button('取消', () => a.guard(() => create ? void v.lobby(v.mine) : this.details()));
    const feedback = v.element('p', 'room-feedback'); feedback.setAttribute('role', 'status');
    footer.append(feedback, note, cancel, save); form.append(footer);
    form.addEventListener('input', () => {
      name.setCustomValidity(name.value.trim() ? '' : '请输入房间名称。');
      save.disabled = m.mode !== 'on' || (!create && !a.dirty?.()) || a.pending > 0;
      note.textContent = create ? '创建后可邀请成员加入。' : a.dirty?.() ? '有未保存的修改' : '尚未修改'; feedback.textContent = '';
    });
    form.addEventListener('submit', event => {
      event.preventDefault(); name.setCustomValidity(name.value.trim() ? '' : '请输入房间名称。');
      if (!form.reportValidity() || save.disabled) return;
      void a.run(save, async current => {
        fields.disabled = true; cancel.disabled = true;
        const value = values(), payload = { name: value.name, description: value.description, discoverability: value.mode === 'listed' ? 'listed' : 'unlisted', joinPolicy: value.mode === 'invite' ? 'invite' : 'open' };
        try {
          if (create) {
            attempted ||= { ...payload, requestId };
            const result = await m.call('/rooms', attempted); m.cache.clear();
            if (current() && result.room) { a.dirty = null; await v.enter(result.room.id); }
          } else {
            await m.action('', payload, 'PATCH');
            if (current()) {
              saved = JSON.stringify(values()); note.textContent = '所有修改已保存'; feedback.textContent = m.status || '房间设置已保存。';
              v.context.textContent = m.room.name; a.heading.querySelector('.room-page-context').textContent = m.room.name;
            }
          }
        } catch (error) {
          if (create && current()) note.textContent = '创建尚未确认，请重试。成功后可修改房间资料。';
          throw error;
        } finally { if (current()) { fields.disabled = m.mode !== 'on' || (create && !!attempted); cancel.disabled = false; } }
      }, '', feedback).finally(() => {
        if (save.isConnected) { save.disabled = m.mode !== 'on' || (!create && !a.dirty?.()); if (create && attempted) save.textContent = '重试创建'; }
      });
    });
    if (m.mode !== 'on') a.feedback.textContent = '当前为只读模式，暂时无法修改设置。';
    if (!create) {
      const danger = a.section(root, '归档房间', room.status === 'archived' ? '此房间已归档。现有成员可继续查看历史消息，无法发送消息或邀请新成员。' : '归档后停止加入和发送消息，现有成员仍可阅读历史。此操作无法撤销。'); danger.classList.add('room-danger-zone');
      const archive = v.button('归档房间', () => a.guard(() => a.confirm({ title: '归档「' + room.name + '」？',
        description: '所有邀请链接将失效，成员无法继续加入或发送消息。历史消息会保留，归档后无法恢复。', label: '归档房间', danger: true,
        action: async current => { await m.action('/archive'); if (current()) { this.form(); this.admin.feedback.textContent = '房间已归档。'; } } })), 'rooms-button rooms-danger');
      archive.disabled = room.status === 'archived' || m.mode !== 'on'; danger.append(archive);
    }
  }
  members() {
    const v = this.view, m = v.manager, a = this.admin;
    if (!m.room || !m.role) return;
    const root = a.page('members', m.role === 'owner' ? '成员管理' : '房间成员', m.role === 'owner' ? '查看成员资料，或通过成员操作管理加入权限。' : '查看成员资料，提及成员或发送私信。');
    const toolbar = v.element('div', 'room-member-toolbar'), search = v.element('input'); search.type = 'search'; search.placeholder = '搜索昵称或账号'; search.setAttribute('aria-label', '搜索成员');
    const filters = v.element('div', 'rooms-filters'); filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', '成员范围');
    const active = v.button('当前成员', () => select(false), 'rooms-button rooms-filter'), banned = v.button('禁止加入', () => select(true), 'rooms-button rooms-filter');
    filters.append(active); if (m.role === 'owner') filters.append(banned); toolbar.append(filters, search); root.append(toolbar);
    const count = v.element('p', 'room-list-count'); count.setAttribute('role', 'status');
    const list = v.element('div', 'room-member-list'); list.setAttribute('aria-label', '成员列表');
    const more = v.button('加载更多成员', () => void a.run(more, async current => {
      const result = await m.call('/rooms/' + m.room.id + '/members?cursor=' + encodeURIComponent(cursor));
      if (current()) { people.push(...result.members); cursor = result.cursor; render(); }
    })); more.hidden = true; root.append(count, list, more);
    let people = [], cursor, showBanned = false;
    const render = () => {
      const query = search.value.trim().toLocaleLowerCase();
      const matches = people.filter(user => (user.status === 'banned') === showBanned && [user.displayName, user.username, user.id].some(value => value?.toLocaleLowerCase().includes(query)));
      active.setAttribute('aria-pressed', String(!showBanned)); banned.setAttribute('aria-pressed', String(showBanned));
      count.textContent = (cursor ? '已加载 ' : '共 ') + matches.length + ' 位' + (showBanned ? '禁止加入的用户' : '成员');
      list.replaceChildren(...matches.map(user => this.member(user)));
      if (!matches.length) list.append(v.element('p', 'room-list-empty', query ? '没有找到匹配的成员。' : showBanned ? '暂无禁止加入的用户。' : '暂无成员。'));
      more.hidden = !cursor;
    };
    const select = value => { showBanned = value; render(); }; search.addEventListener('input', render); render();
    return a.load(list, () => m.call('/rooms/' + m.room.id + '/members'), result => { people = result.members; cursor = result.cursor; render(); });
  }
  member(user) {
    const v = this.view, m = v.manager, a = this.admin, row = v.element('article', 'room-member'); row.dataset.accountId = user.id;
    const identity = v.button('', () => v.ui.profileUI.open(user), 'room-member-identity'); identity.setAttribute('aria-label', '查看 ' + user.displayName + ' 的资料');
    const fallback = v.ui.generateAvatar(user.displayName), avatar = v.element('span', 'avatar ' + fallback.color); v.ui.profileUI.avatar(avatar, user, fallback.avatar);
    const copy = v.element('span', 'room-member-copy'); copy.append(v.element('strong', '', user.displayName), v.element('span', '', user.username ? '@' + user.username : user.id)); identity.append(avatar, copy);
    const state = v.element('span', 'room-member-state', user.status === 'banned' ? '已禁止加入' : (user.id === m.room.ownerId ? '房主' : '成员') + (m.online?.includes(user.id) ? ' · 在线' : ' · 离线')); row.append(identity, state);
    if (user.id === m.user.id) { row.append(v.element('span', 'room-member-self', '我')); return row; }
    const menu = v.element('details', 'room-member-menu'), summary = v.element('summary'); summary.setAttribute('aria-label', user.displayName + ' 的成员操作'); summary.append(v.icon('more'));
    const actions = v.element('div', 'room-member-actions');
    const option = (label, action, danger = false) => actions.append(v.button(label, () => { menu.open = false; action(); }, 'rooms-button' + (danger ? ' rooms-danger' : '')));
    if (user.status === 'active') {
      if (m.room.status === 'active' && m.mode === 'on') option('提及', () => { v.renderRoom(); v.ui.elements.chatInput.value += v.ui.mentions.format({ type: 'user', id: user.id, name: user.displayName }) + ' '; v.ui.elements.chatInput.dispatchEvent(new Event('input')); v.ui.elements.chatInput.focus(); });
      option('发私信', () => { v.renderRoom(); void v.ui.directMessageView.start(user); });
    }
    if (m.role === 'owner' && m.mode === 'on') {
      if (user.status === 'banned') option('解除禁止', () => this.memberAction(user, 'unban'));
      else {
        option('移出房间', () => this.memberAction(user, 'remove'), true);
        option('禁止加入', () => this.memberAction(user, 'ban'), true);
        if (m.room.status === 'active' && m.mode === 'on') option('转让房主', () => this.memberAction(user, 'transfer'));
      }
    }
    menu.append(summary, actions); row.append(menu);
    menu.addEventListener('toggle', () => {
      if (!menu.open) return;
      for (const other of a.root.querySelectorAll('details[open]')) if (other !== menu) other.open = false;
      const bounds = v.body.getBoundingClientRect(), anchor = summary.getBoundingClientRect();
      const below = bounds.bottom - anchor.bottom - 12, above = anchor.top - bounds.top - 12;
      const upwards = below < actions.scrollHeight && above > below;
      actions.style.top = upwards ? 'auto' : 'calc(100% + 4px)'; actions.style.bottom = upwards ? 'calc(100% + 4px)' : 'auto';
      actions.style.maxHeight = Math.max(88, upwards ? above : below) + 'px';
    });
    return row;
  }
  memberAction(user, action) {
    const v = this.view, m = v.manager, a = this.admin;
    const [label, description, success] = {
      remove: ['移出房间', '移出后，对方将无法访问房间，但仍可按房间的加入条件重新加入。', '已移出成员。'],
      ban: ['禁止加入', '对方将被移出房间，且无法通过房间链接或邀请重新加入。', '已禁止该用户加入。'],
      unban: ['解除禁止', '解除后，对方可按房间的加入条件重新加入，不会自动恢复成员身份。', '已解除禁止。'],
      transfer: ['转让房主', '您将成为普通成员，失去房间管理权限；现有邀请链接将全部失效。', '房主已转让。']
    }[action];
    a.confirm({ title: label + '：' + user.displayName, description, label, danger: action !== 'unban', action: async current => {
      await m.action(action === 'transfer' ? '/transfer' : '/members/' + encodeURIComponent(user.id) + '/' + action, action === 'transfer' ? { accountId: user.id } : {});
      if (!current()) return;
      const loaded = this.members(), refreshed = a.current();
      await loaded; if (refreshed()) { a.feedback.textContent = success; v.title.focus({ preventScroll: true }); }
    } });
  }
  invites() {
    const v = this.view, m = v.manager, a = this.admin;
    if (!m.room || m.role !== 'owner') { this.details(); return; }
    const root = a.page('invites', '邀请管理', '创建邀请链接，并管理有效期和可加入人数。');
    const create = a.section(root, '生成邀请', '邀请链接可转发给其他人。请根据需要设置有效期和使用次数。');
    const form = v.element('form', 'room-invite-form'), fields = v.element('fieldset', 'room-invite-fields'); form.append(fields); create.append(form);
    fields.disabled = m.room.status === 'archived' || m.mode !== 'on';
    const number = (label, value, max, hint) => {
      const node = v.element('label', 'room-field'), input = v.element('input'); input.type = 'number'; input.min = 1; input.max = max; input.step = 1; input.required = true; input.value = value; input.setAttribute('aria-label', label);
      node.append(v.element('span', '', label), input, v.element('span', 'room-field-hint', hint)); fields.append(node); return input;
    };
    const hours = number('有效期（小时）', 24, 168, '1–168 小时，最长 7 天。'), uses = number('使用次数', 1, 50, '1–50 次，每位成员加入使用 1 次。');
    const generate = v.button('生成邀请', () => {}, 'rooms-button rooms-primary'); generate.type = 'submit'; fields.append(generate);
    const resultArea = v.element('div', 'room-invite-result'); resultArea.hidden = true; create.append(resultArea);
    const feedback = v.element('p', 'room-feedback'); feedback.setAttribute('role', 'status'); create.append(feedback);
    const currentInvites = a.section(root, '邀请记录', '展示尚未到期且未撤销的邀请。撤销不会移出已加入的成员。');
    const list = v.element('div', 'room-invite-list'); currentInvites.append(list);
    const render = result => {
      list.replaceChildren();
      for (const invite of result.invites) {
        const row = v.element('article', 'room-invite-row'); row.dataset.inviteId = invite.id;
        const copy = v.element('div', 'room-invite-copy');
        copy.append(v.element('strong', '', invite.uses >= invite.max_uses ? '次数已用尽' : '可使用'), v.element('span', '', '已使用 ' + invite.uses + ' / ' + invite.max_uses + ' 次'),
          v.element('span', '', new Date(invite.expires_at).toLocaleString() + ' 到期'));
        const revoke = v.button('撤销邀请', () => a.confirm({ title: '撤销此邀请？', description: '此链接将立即失效。已经加入的成员不受影响。', label: '撤销邀请', danger: true,
          action: async current => { await m.action('/invites/' + invite.id + '/revoke');
            if (!current()) return;
            if (this.generatedInvite === invite.id) { this.generatedInvite = null; resultArea.replaceChildren(); resultArea.hidden = true; }
            await load(); if (current()) { a.feedback.textContent = '邀请已撤销。'; v.title.focus({ preventScroll: true }); }
          } }), 'rooms-button rooms-danger'); row.append(copy, revoke); list.append(row);
      }
      if (!result.invites.length) list.append(v.element('p', 'room-list-empty', '暂无有效邀请。生成链接后，可在这里查看使用情况。'));
    };
    const load = () => a.load(list, () => m.call('/rooms/' + m.room.id + '/invites'), render);
    form.addEventListener('submit', event => {
      event.preventDefault(); if (!form.reportValidity() || fields.disabled) return;
      void a.run(generate, async current => {
        fields.disabled = true;
        try {
          const result = await m.action('/invites', { expiresIn: Number(hours.value) * 3600, maxUses: Number(uses.value) });
          if (!current() || !result) return;
          this.generatedInvite = result.inviteId; resultArea.hidden = false;
          resultArea.replaceChildren(v.element('h4', '', '邀请已生成'), v.element('p', '', '请复制并妥善保存此链接。离开页面后无法再次查看完整链接。'));
          const link = a.link(resultArea, location.origin + '/?room=' + m.room.id + '#invite=' + result.secret, '邀请链接'); link.focus(); link.select(); link.scrollLeft = 0; await load();
        } finally { if (current()) fields.disabled = m.room.status === 'archived' || m.mode !== 'on'; }
      }, '', feedback);
    });
    if (fields.disabled) a.feedback.textContent = m.room.status === 'archived' ? '房间已归档，无法生成新的邀请。' : '当前为只读模式，暂时无法生成邀请。';
    return load();
  }
}
