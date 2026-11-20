/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** MentionPickerView: mentionPicker component; ui supplies shared presentation context. */
class MentionPickerView {
  constructor(ui) { this.ui = ui; }

  /**
   * 检查消息是否提及了当前用户
   * @param {string} text - 消息内容
   * @returns {boolean}
   */
  isMentioned(text) {
    let user = this.ui.currentUser;
    if (!user) {
      try { user = { displayName: localStorage.getItem('nightcord-username') }; } catch { /* Storage disabled. */ }
    }
    return this.ui.mentions?.isMentioned(text, user) || false;
  }

  bindMentionAction(element, mention) {
    if (mention.type === 'user' && mention.id) {
      const profile = this.ui.roster.find(user => user.profile?.id === mention.id)?.profile
        || this.ui.storage?.getKnownProfile(mention.id)
        || { id: mention.id, displayName: mention.name };
      this.ui.profileUI.makeTrigger(element, profile, { fromMessage: true });
    } else if (mention.type === 'ai' && window.AIConfig.getAIConfig(mention.id)) {
      element.setAttribute('role', 'button');
      element.tabIndex = 0;
      element.setAttribute('aria-label', `向 ${window.AIConfig.getDisplayName(mention.id)} 提问`);
      const activate = () => this.ui.autocomplete?.insertMention(mention);
      element.addEventListener('click', activate);
      element.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
      });
    }
  }

  showMentionNotice(data) {
    this.ui.mentionNotice?.remove();
    const notice = document.createElement('div');
    notice.className = 'mention-notice';
    notice.setAttribute('role', 'status');
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = `${data.name} 提到了你 · 查看消息`;
    open.addEventListener('click', () => {
      const message = this.ui.messageIndex.get(Number(data.timestamp));
      if (message) {
        this.ui.sidebarFeatures?.close(false);
        message.scrollIntoView({ block: 'center' });
        message.tabIndex = -1;
        message.focus({ preventScroll: true });
        notice.remove();
      }
    });
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = '×';
    dismiss.setAttribute('aria-label', '关闭提及提醒');
    dismiss.addEventListener('click', () => notice.remove());
    notice.append(open, dismiss);
    document.body.appendChild(notice);
    this.ui.mentionNotice = notice;
  }

  /**
   * 侧栏提及选择器：点击导航栏的 @ 时展开，选择成员后把 SEKAI Mention
   * 插入输入框当前光标处，而不是先输入一个 “@”。
   */
  setupMentionPicker() {
    const { mentionPicker, mentionPickerList: list, mentionPickerQuery: query } = this.ui.elements;
    if (!mentionPicker || !list) return;

    query?.addEventListener('input', () => this.renderMentionPicker());
    query?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      const first = list.querySelector('.mention-picker-item');
      if (!first) return;
      event.preventDefault();
      first.click();
    });
    mentionPicker.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.closeMentionPicker();
        return;
      }
      const items = [...list.querySelectorAll('.mention-picker-item')];
      if (items.length === 0) return;
      if (event.key === 'Home' || event.key === 'End') {
        // Let the search field keep caret movement while it has focus.
        if (document.activeElement === query) return;
        event.preventDefault();
        items[event.key === 'Home' ? 0 : items.length - 1].focus({ preventScroll: false });
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement);
      const next = current === -1
        ? (event.key === 'ArrowDown' ? 0 : items.length - 1)
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus({ preventScroll: false });
    });
    mentionPicker.querySelector('.mention-picker-close')?.addEventListener('click', () => this.closeMentionPicker());
    document.addEventListener('click', (event) => {
      if (!this.ui.mentionPickerOpen) return;
      if (event.target.closest?.('#mention-picker, #navigation-mentions, dialog')) return;
      this.closeMentionPicker({ restoreFocus: false });
    });
  }

  openMentionPicker() {
    const { mentionPicker, mentionPickerQuery: query } = this.ui.elements;
    const button = document.querySelector('#navigation-mentions');
    if (!mentionPicker || !this.ui.autocomplete) return;

    this.ui.mentionPickerOpen = true;
    this.ui.autocomplete.hideList();
    this.ui.revealNavigation?.();
    if (query) query.value = '';
    this.renderMentionPicker();
    document.querySelector('.sidebar')?.classList.add('mention-picker-open');
    button?.classList.add('is-active');
    button?.setAttribute('aria-expanded', 'true');
    query?.focus({ preventScroll: true });
  }

  closeMentionPicker({ restoreFocus = true } = {}) {
    if (!this.ui.mentionPickerOpen) return;
    this.ui.mentionPickerOpen = false;
    document.querySelector('.sidebar')?.classList.remove('mention-picker-open');
    const button = document.querySelector('#navigation-mentions');
    button?.classList.remove('is-active');
    button?.setAttribute('aria-expanded', 'false');
    this.ui.syncNavigation?.();
    if (restoreFocus) button?.focus({ preventScroll: true });
  }

  renderMentionPicker() {
    const { mentionPickerList: list, mentionPickerQuery: query } = this.ui.elements;
    if (!list) return;

    const needle = (query?.value || '').trim().toLocaleLowerCase();
    const groups = this.ui.autocomplete?.mentionGroups(candidate => candidate.name.toLocaleLowerCase().includes(needle)) || [];
    if (!groups.length) {
      list.innerHTML = `
        <div class="mention-picker-empty" role="status">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5M8 10.5h5"/></svg>
          <span>没有找到匹配的成员</span>
        </div>`;
      return;
    }

    list.replaceChildren(...groups.map(({ label, members }, index) => {
      const section = document.createElement('div');
      section.className = 'mention-picker-group';
      section.setAttribute('role', 'group');
      const labelId = `mention-picker-group-${index}`;
      section.setAttribute('aria-labelledby', labelId);
      const heading = document.createElement('p');
      heading.className = 'mention-picker-group-label'; heading.id = labelId; heading.textContent = label;
      section.append(heading, ...members.map(candidate => this.mentionPickerItem(candidate)));
      return section;
    }));
  }

  mentionPickerItem(candidate) {
    const item = document.createElement('button');
    item.type = 'button'; item.className = 'mention-picker-item'; item.dataset.type = candidate.type;
    item.title = candidate.detailTitle || candidate.detail || candidate.label || '';
    item.innerHTML = `
      <span class="avatar ${this.ui.escapeHtml(candidate.color || '')}" aria-hidden="true">${this.ui.escapeHtml(candidate.avatar || '')}</span>
      <span class="mention-picker-identity">
        <span class="mention-picker-name">${this.ui.escapeHtml(candidate.name)}</span>
        <span class="mention-picker-detail">${this.ui.escapeHtml(candidate.label || candidate.detail || '')}</span>
      </span>
      ${candidate.type === 'user' ? `<span class="mention-picker-status" data-status="${candidate.status === 'online' ? 'online' : 'offline'}" aria-hidden="true"></span>` : ''}`;
    this.ui.autocomplete.renderMentionAvatar(item.querySelector('.avatar'), candidate);
    item.addEventListener('click', () => this.insertPickerMention(candidate));
    return item;
  }

  insertPickerMention(mention) {
    if (!this.ui.autocomplete) return;
    this.closeMentionPicker({ restoreFocus: false });
    this.ui.closeNavigationDrawer?.();
    this.ui.autocomplete.insertMention(mention);
  }
}
