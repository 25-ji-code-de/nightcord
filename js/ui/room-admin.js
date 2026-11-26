/* SPDX-License-Identifier: AGPL-3.0-only */
/** Shared page structure and interaction lifetime for room administration. */
class RoomAdminView {
  constructor(view) { this.view = view; this.pending = 0; this.loads = new WeakMap(); }
  current() {
    const v = this.view, revision = v.viewRevision, generation = v.manager.roomGeneration, account = v.manager.generation;
    return () => revision === v.viewRevision && generation === v.manager.roomGeneration && account === v.manager.generation && !v.panel.hidden;
  }
  reset() {
    this.dirty = null; this.pending = 0; this.dialog?.close();
    this.view.settings.generatedInvite = null;
  }
  guard(action) {
    if (this.pending) { this.feedback.textContent = '正在处理，请稍候。'; return; }
    if (!this.dirty?.()) { action(); return; }
    this.confirm({ title: '放弃未保存的修改？', description: '离开后，本次修改将不会保存。', label: '放弃修改',
      action: () => { this.dirty = null; this.pending = 0; action(); } });
  }
  page(key, title, description) {
    const v = this.view;
    v.open(); v.showingRoom = false; v.setPage(key, title);
    v.panel.classList.add('rooms-admin');
    const parent = key === 'details' ? '返回聊天' : key === 'create' ? '返回大厅' : '房间信息';
    v.back.replaceChildren(v.icon('back'), document.createTextNode(parent)); v.back.hidden = false;
    v.backAction = () => this.guard(() => key === 'details' ? v.renderRoom() : key === 'create' ? void v.lobby(v.mine) : v.details());
    v.official.hidden = true;
    v.context.textContent = key === 'create' ? '' : v.manager.room?.name || '';
    const root = v.element('div', 'room-admin-page');
    const heading = v.element('header', 'room-page-heading');
    if (!['details', 'create'].includes(key)) heading.append(v.element('p', 'room-page-context', v.manager.room?.name));
    heading.append(v.element('h2', '', title));
    if (description) heading.append(v.element('p', '', description));
    this.feedback = v.element('p', 'room-feedback'); this.feedback.setAttribute('role', 'status'); this.feedback.setAttribute('aria-live', 'polite');
    root.append(heading, this.feedback); v.content.replaceChildren(root);
    v.body.scrollTop = 0;
    this.root = root; this.heading = heading;
    return root;
  }
  section(parent, title, description) {
    const v = this.view, section = v.element('section', 'room-section');
    section.setAttribute('aria-label', title);
    const heading = v.element('div', 'room-section-heading'); heading.append(v.element('h3', '', title));
    if (description) heading.append(v.element('p', '', description));
    section.append(heading); parent.append(section); return section;
  }
  async run(button, action, success = '', feedback = this.feedback) {
    const current = this.current(), label = button?.textContent;
    if (button?.disabled) return;
    this.pending++; if (feedback) { feedback.textContent = ''; feedback.setAttribute('role', 'status'); }
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    try {
      const result = await action(current);
      if (current() && feedback && success) feedback.textContent = success;
      return result;
    } catch (error) {
      if (current() && feedback && error.name !== 'AbortError') { feedback.setAttribute('role', 'alert'); feedback.textContent = error.message || '操作未完成，请稍后重试。'; }
    } finally {
      if (current()) this.pending = Math.max(0, this.pending - 1);
      if (button?.isConnected) { button.disabled = false; button.removeAttribute('aria-busy'); if (button.textContent !== label) button.textContent = label; }
    }
  }
  async load(container, action, render) {
    const v = this.view, pageCurrent = this.current(), request = {};
    this.loads.set(container, request);
    const current = () => pageCurrent() && this.loads.get(container) === request;
    container.setAttribute('aria-busy', 'true');
    const state = v.element('p', 'room-loading', '正在加载…'); state.setAttribute('role', 'status'); container.replaceChildren(state);
    try { const result = await action(); if (current()) render(result); }
    catch (error) {
      if (!current() || error.name === 'AbortError') return;
      const message = v.element('p', '', error.message || '加载失败，请稍后重试。'); message.setAttribute('role', 'alert');
      container.replaceChildren(message, v.button('重新加载', () => void this.load(container, action, render)));
    } finally { if (current()) container.setAttribute('aria-busy', 'false'); }
  }
  link(parent, value, label = '房间链接') {
    const v = this.view, row = v.element('div', 'room-share');
    const input = v.element('input'); input.readOnly = true; input.value = value; input.setAttribute('aria-label', label);
    const feedback = v.element('p', 'room-feedback'); feedback.setAttribute('role', 'status');
    const copy = v.button('复制链接', () => void this.run(copy, async () => {
      try { await navigator.clipboard.writeText(value); }
      catch { input.focus(); input.select(); throw new Error('无法自动复制，请选中链接后手动复制。'); }
    }, '链接已复制。', feedback));
    row.append(input, copy); parent.append(row, feedback); return input;
  }
  confirm({ title, description, label, action, danger = false }) {
    const v = this.view, current = this.current(), active = document.activeElement;
    const focus = active?.closest('details')?.querySelector('summary') || active;
    this.dialog?.close();
    const dialog = v.element('dialog', 'room-confirm'); this.dialog = dialog;
    const heading = v.element('h2', '', title); heading.id = 'room-confirm-title';
    const copy = v.element('p', '', description); copy.id = 'room-confirm-description';
    dialog.setAttribute('aria-labelledby', heading.id); dialog.setAttribute('aria-describedby', copy.id);
    const feedback = v.element('p', 'room-feedback'); feedback.setAttribute('role', 'alert');
    const buttons = v.element('div', 'room-confirm-actions');
    let busy = false;
    const cancel = v.button('取消', () => dialog.close());
    const submit = v.button(label, () => {
      if (busy || !current()) return;
      busy = true; cancel.disabled = true;
      void this.run(submit, async () => {
        await action(current); dialog.close();
      }, '', feedback).finally(() => { busy = false; cancel.disabled = false; });
    }, 'rooms-button ' + (danger ? 'rooms-danger' : 'rooms-primary'));
    buttons.append(cancel, submit); dialog.append(heading, copy, feedback, buttons); document.body.append(dialog);
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      if (this.dialog === dialog) this.dialog = null;
      dialog.remove(); if (current() && focus?.isConnected) focus.focus({ preventScroll: true });
    }, { once: true });
    dialog.showModal(); cancel.focus();
  }
}
