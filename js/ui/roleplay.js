/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** 语C发言身份：当前身份常驻输入框上方，选择与管理在同一个面板完成。 */
class RoleplayView {
  static renderAvatar(element, name) {
    const source = Roleplay.avatarUrl(name);
    if (!source) return;
    const fallback = element.textContent;
    const image = document.createElement('img');
    image.alt = ''; // 相邻文字已包含角色名。
    image.width = 128; image.height = 128;
    image.loading = 'lazy'; image.decoding = 'async';
    image.addEventListener('error', () => {
      if (image.parentNode !== element) return;
      element.textContent = fallback;
      element.classList.remove('roleplay-portrait');
    }, { once: true });
    image.src = source;
    element.classList.add('roleplay-portrait');
    element.replaceChildren(image);
  }

  constructor(ui, roleplay) {
    this.ui = ui; this.roleplay = roleplay;
    this.make = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    };
    const { make } = this;
    this.bar = make('div', 'roleplay-bar');
    this.bar.hidden = true;
    this.trigger = this.button('roleplay-trigger', '', () => this.setOpen(this.panel.hidden));
    this.trigger.setAttribute('aria-haspopup', 'dialog');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.setAttribute('aria-controls', 'roleplay-picker');
    this.currentAvatar = make('span', 'avatar roleplay-avatar');
    this.currentName = make('span', 'roleplay-current-name');
    this.trigger.append(this.currentAvatar, this.currentName, this.icon('chevron'));
    this.bar.append(make('span', 'roleplay-label', '发言身份'), this.trigger);

    this.panel = make('section', 'roleplay-panel');
    this.panel.id = 'roleplay-picker'; this.panel.hidden = true;
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-labelledby', 'roleplay-picker-title');
    const header = make('div', 'roleplay-head');
    const title = make('h2', '', '切换发言身份'); title.id = 'roleplay-picker-title';
    const close = this.button('roleplay-icon-button', '', () => this.setOpen(false, this.trigger));
    close.setAttribute('aria-label', '关闭角色选择'); close.append(this.icon('close'));
    header.append(title, close);
    this.choices = make('div', 'roleplay-choices');
    this.choices.setAttribute('role', 'group'); this.choices.setAttribute('aria-label', '发言身份');
    this.customHeading = make('div', 'roleplay-section-heading');
    this.customHeading.append(make('span', '', '自定义角色'));
    this.customCount = make('span', 'roleplay-count'); this.customHeading.append(this.customCount);
    this.customList = make('div', 'roleplay-custom-list');
    this.customSection = make('div', 'roleplay-custom');
    this.customSection.append(this.customHeading, this.customList);
    this.addButton = this.button('roleplay-add', '', () => this.toggleAdd(true));
    this.addLabel = make('span', '', '添加角色');
    this.addButton.append(this.icon('plus'), this.addLabel);
    this.addButton.setAttribute('aria-expanded', 'false');
    this.addButton.setAttribute('aria-controls', 'roleplay-add-form');
    this.form = make('form', 'roleplay-form'); this.form.id = 'roleplay-add-form'; this.form.hidden = true;
    const label = make('label', '', '角色名称'); label.htmlFor = 'roleplay-name';
    this.input = make('input', 'roleplay-input'); this.input.id = 'roleplay-name';
    this.input.type = 'text'; this.input.maxLength = 32; this.input.autocomplete = 'off';
    this.input.placeholder = '输入角色名';
    this.input.setAttribute('aria-describedby', 'roleplay-name-hint roleplay-error');
    const hint = make('span', 'roleplay-hint', '最多 16 个字符，仅保存在此浏览器'); hint.id = 'roleplay-name-hint';
    this.status = make('p', 'roleplay-error'); this.status.id = 'roleplay-error'; this.status.hidden = true;
    this.status.setAttribute('role', 'status');
    const actions = make('div', 'roleplay-form-actions');
    const cancel = this.button('roleplay-cancel', '取消', () => this.toggleAdd(false, true));
    const submit = make('button', 'roleplay-submit', '添加并使用'); submit.type = 'submit';
    actions.append(cancel, submit); this.form.append(label, this.input, hint, this.status, actions);
    this.form.addEventListener('submit', event => { event.preventDefault(); this.add(); });
    this.input.addEventListener('input', () => this.showError(''));
    this.footer = make('div', 'roleplay-footer'); this.footer.append(this.addButton, this.form);
    this.panel.append(header, this.choices, this.customSection, this.footer);
    this.bar.append(this.panel);
    ui.elements.chatInput.closest('.input-area')?.querySelector('.input-box')?.before(this.bar);
    this.basePlaceholder = ui.elements.chatInput.placeholder;
    this.bar.addEventListener('keydown', event => this.keydown(event));
    this.dismissOutside = event => {
      if (!this.panel.hidden && !this.bar.contains(event.target)) this.setOpen(false);
    };
    document.addEventListener('pointerdown', this.dismissOutside, true);
    document.addEventListener('focusin', this.dismissOutside);
    this.resize = () => this.positionPanel();
    window.addEventListener('resize', this.resize);
    window.visualViewport?.addEventListener('resize', this.resize);
    window.visualViewport?.addEventListener('scroll', this.resize);
    this.layoutObserver = new ResizeObserver(this.resize);
    this.layoutObserver.observe(this.bar);
    this.layoutObserver.observe(ui.elements.chatInput.closest('.input-area'));
    this.off = [
      ui.eventBus.on('room:joining', () => { this.left = false; this.setOpen(false); this.refresh(); }),
      ui.eventBus.on('room:changed', () => { this.setOpen(false); this.refresh(); }),
      ui.eventBus.on('room:left', () => { this.left = true; this.refresh(); })
    ];
    this.refresh();
  }

  icon(name) {
    const paths = { chevron: 'm6 9 6 6 6-6', close: 'm6 6 12 12M6 18 18 6', plus: 'M12 5v14M5 12h14',
      check: 'm5 12 4 4L19 6', person: 'M20 21v-2a7 7 0 0 0-14 0v2M15 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
      trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7' };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[name]);
    svg.append(path); return svg;
  }

  button(className, label, action) {
    const button = this.make('button', className, label);
    button.type = 'button'; button.addEventListener('click', action); return button;
  }

  avatar(element, role) {
    element.classList.remove('roleplay-portrait'); element.replaceChildren();
    element.setAttribute('aria-hidden', 'true');
    if (role === null) element.append(this.icon('person'));
    else { element.textContent = [...role][0]; RoleplayView.renderAvatar(element, role); }
  }

  visible() { return !this.left && !this.ui.managedChat && this.roleplay.inRoom(); }

  refresh() {
    this.bar.hidden = !this.visible();
    if (this.bar.hidden) this.setOpen(false);
    this.renderRoles();
  }

  renderRoles() {
    const { make, roleplay } = this;
    const label = roleplay.active || '本人';
    this.currentName.textContent = label;
    this.trigger.setAttribute('aria-label', `发言身份：${label}，切换角色`);
    this.trigger.dataset.roleplayActive = String(!!roleplay.active);
    this.avatar(this.currentAvatar, roleplay.active);
    const defaults = make('div', 'roleplay-defaults');
    for (const role of Roleplay.DEFAULT_ROLES) defaults.append(this.option(role, 'roleplay-option--default'));
    this.choices.replaceChildren(this.option(null, 'roleplay-option--self'), defaults);
    this.customCount.textContent = `${roleplay.custom.length} / ${Roleplay.MAX_CUSTOM}`;
    this.customSection.hidden = !roleplay.custom.length;
    this.customList.replaceChildren(...roleplay.custom.map(role => {
      const row = make('div', 'roleplay-custom-row');
      const remove = this.button('roleplay-icon-button roleplay-remove', '', () => this.remove(role));
      remove.setAttribute('aria-label', `删除角色 ${role}`); remove.title = `删除角色 ${role}`;
      remove.append(this.icon('trash')); row.append(this.option(role), remove); return row;
    }));
    this.addButton.disabled = roleplay.custom.length >= Roleplay.MAX_CUSTOM;
    this.addLabel.textContent = this.addButton.disabled ? '自定义角色已达上限' : '添加角色';
    const input = this.ui.elements.chatInput;
    if (!this.bar.hidden && roleplay.active) {
      input.dataset.roleplayPlaceholder = '1'; input.placeholder = `以 ${roleplay.active} 的身份发言`;
    } else if (input.dataset.roleplayPlaceholder) {
      delete input.dataset.roleplayPlaceholder; input.placeholder = this.basePlaceholder;
    }
  }

  option(role, className = '') {
    const name = role || '本人';
    const button = this.button(`roleplay-option ${className}`, '', () => this.select(role));
    button.dataset.role = role ?? ''; button.setAttribute('aria-pressed', String(this.roleplay.active === role));
    const avatar = this.make('span', 'avatar roleplay-avatar'); this.avatar(avatar, role);
    const label = this.make('span', 'roleplay-option-name', name);
    button.append(avatar, label);
    if (role === null) button.append(this.make('span', 'roleplay-option-hint', '使用自己的身份'));
    const check = this.make('span', 'roleplay-check'); check.append(this.icon('check')); button.append(check);
    return button;
  }

  select(role) {
    this.roleplay.select(role); this.renderRoles();
    this.setOpen(false, this.trigger);
  }

  setOpen(open, focus) {
    if (open && !this.visible()) return;
    this.panel.hidden = !open; this.trigger.setAttribute('aria-expanded', String(open));
    if (open) {
      this.ui.autocomplete?.hideList(); this.ui.setFileUploadMenuOpen?.(false);
      this.renderRoles();
      this.positionPanel();
      this.panel.querySelector('.roleplay-option[aria-pressed="true"]')?.focus({ preventScroll: true });
    } else this.toggleAdd(false);
    focus?.focus({ preventScroll: true });
  }

  positionPanel() {
    if (this.panel.hidden) return;
    const top = this.bar.getBoundingClientRect().top - (window.visualViewport?.offsetTop || 0);
    this.panel.style.setProperty('--roleplay-available-height', `${Math.max(80, top - 12)}px`);
  }

  keydown(event) {
    if (event.isComposing || event.defaultPrevented) return;
    if (event.key === 'Escape' && !this.panel.hidden) {
      event.preventDefault(); event.stopPropagation();
      if (!this.form.hidden) this.toggleAdd(false, true);
      else this.setOpen(false, this.trigger);
      return;
    }
    if (event.target === this.trigger && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); this.setOpen(true); return;
    }
    if (!event.target.matches('.roleplay-option')) return;
    const options = [...this.panel.querySelectorAll('.roleplay-option')];
    const index = options.indexOf(event.target);
    const next = ({ ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1,
      Home: 0, End: options.length - 1 })[event.key];
    if (next === undefined) return;
    event.preventDefault(); options[(next + options.length) % options.length].focus();
  }

  toggleAdd(open, restoreFocus = false) {
    this.form.hidden = !open; this.addButton.hidden = open;
    this.addButton.setAttribute('aria-expanded', String(open)); this.showError('');
    if (open) this.input.focus();
    else { this.input.value = ''; if (restoreFocus) this.addButton.focus({ preventScroll: true }); }
  }

  showError(message) {
    this.status.textContent = message; this.status.hidden = !message;
    this.input.setAttribute('aria-invalid', String(!!message));
  }

  add() {
    const result = this.roleplay.add(this.input.value);
    if (!result.ok) { this.showError(result.error); this.input.focus(); return; }
    this.select(result.name);
  }

  remove(role) {
    const index = this.roleplay.custom.indexOf(role);
    this.roleplay.remove(role); this.renderRoles();
    const next = this.customList.querySelectorAll('.roleplay-option');
    (next[Math.min(index, next.length - 1)] || this.addButton).focus({ preventScroll: true });
  }

  destroy() {
    for (const off of this.off) off();
    document.removeEventListener('pointerdown', this.dismissOutside, true);
    document.removeEventListener('focusin', this.dismissOutside);
    window.removeEventListener('resize', this.resize);
    window.visualViewport?.removeEventListener('resize', this.resize);
    window.visualViewport?.removeEventListener('scroll', this.resize);
    this.layoutObserver.disconnect();
    this.bar.remove();
  }
}
