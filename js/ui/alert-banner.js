/* SPDX-License-Identifier: AGPL-3.0-only */
/** A single, grouped heads-up card. It never moves keyboard focus on arrival. */
class AlertBanner {
  constructor(alerts) { this.alerts = alerts; this.ui = alerts.ui; }
  element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  preview(message) {
    const text = message?.text || '';
    // Don't reveal spoilers, encoded payloads, attachment URLs or HTML in a preview.
    const parts = this.ui.mentions?.parts(text) || [{ type: 'text', content: text }];
    const content = parts.map(part => {
      if (part.type === 'text') return part.content.replace(/\|\|[\s\S]*?(?:\|\||$)/g, '[隐藏内容]');
      if (part.desc?.spoiler && !['false', '0'].includes(String(part.desc.spoiler).toLowerCase())) return '[隐藏内容]';
      if (this.ui.mentions?.isMention(part)) return `@${this.ui.mentions.display(part)}`;
      if (['reply', 're'].includes(part.sekaiType)) return '';
      if (['image', 'img'].includes(part.sekaiType)) return '[图片]';
      if (['stamp', 'sticker'].includes(part.sekaiType)) return '[贴纸]';
      if (['audio', 'music'].includes(part.sekaiType)) return '[音频]';
      if (part.sekaiType === 'file') return '[文件]';
      if (part.sekaiType === 'code') return '[代码]';
      return this.ui.extractPlainTextForReply?.(part.raw || '') || '[消息]';
    }).join(' ').replace(/<[^>]*>/g, '').replace(/https?:\/\/\S+/g, '[链接]').replace(/\s+/g, ' ').trim();
    return (content || '发来了一条消息').slice(0, 150);
  }
  mount() {
    this.node = this.element('section', 'chat-alert');
    this.returnFocus = document.activeElement;
    this.node.setAttribute('aria-label', '新提醒');
    const open = this.element('button', 'chat-alert-open'); open.type = 'button';
    this.avatar = this.element('span', 'chat-alert-avatar'); this.avatar.setAttribute('aria-hidden', 'true');
    const body = this.element('span', 'chat-alert-body');
    this.meta = this.element('span', 'chat-alert-meta');
    this.context = this.element('span', 'chat-alert-context');
    this.kind = this.element('span', 'chat-alert-kind');
    this.meta.append(this.context, this.kind);
    this.title = this.element('strong', 'chat-alert-title');
    this.summary = this.element('span', 'chat-alert-summary');
    this.footer = this.element('span', 'chat-alert-footer');
    body.append(this.meta, this.title, this.summary, this.footer);
    open.append(this.avatar, body);
    open.addEventListener('click', () => {
      const message = this.message;
      this.dismiss();
      if (message) this.alerts.jump(message);
    });
    const close = this.element('button', 'chat-alert-close', '×'); close.type = 'button';
    close.setAttribute('aria-label', '关闭提醒'); close.addEventListener('click', () => this.dismiss());
    this.live = this.element('span', 'chat-alert-live'); this.live.setAttribute('role', 'status'); this.live.setAttribute('aria-atomic', 'true');
    this.node.append(open, close, this.live);
    const pause = () => this.pause();
    this.node.addEventListener('pointerenter', () => { this.hover = true; pause(); });
    this.node.addEventListener('pointerleave', () => { this.hover = false; this.arm(); });
    this.node.addEventListener('focusin', pause);
    this.node.addEventListener('focusout', () => { clearTimeout(this.focusTimer); this.focusTimer = setTimeout(() => this.arm(), 0); });
    // Swipe is a convenience; the visible close button remains keyboard accessible.
    let swipe = null, suppressClick = false;
    this.node.addEventListener('pointerdown', event => {
      if (event.pointerType === 'touch') swipe = { x: event.clientX, y: event.clientY };
    });
    this.node.addEventListener('pointerup', event => {
      if (swipe && Math.abs(event.clientX - swipe.x) > 70 && Math.abs(event.clientY - swipe.y) < 45) {
        suppressClick = true; this.dismiss();
      }
      swipe = null;
    });
    this.node.addEventListener('click', event => {
      if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; }
    }, true);
    this.node.addEventListener('pointercancel', () => { swipe = null; });
    this.node.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); this.dismiss(); }
    });
    document.body.append(this.node);
  }
  show(text, message, kind = 'message') {
    if (this.ui.notifications?.mentionNotice?.isConnected) return;
    const priority = ['mention', 'reply'].includes(kind) ? 2 : message ? 1 : 0;
    // A normal arrival must not erase a reply/@ card while it is being read.
    if (this.node?.isConnected && priority < this.priority) return;
    const grouped = this.node?.isConnected && !!message && !!this.message;
    if (!this.node?.isConnected) { this.dismiss(); this.mount(); }
    this.priority = priority; this.message = message; this.kindName = kind;
    this.count = grouped ? this.count + 1 : 1;
    this.node.dataset.kind = kind;
    const room = this.ui.elements.roomName?.textContent || this.ui.currentRoom || 'Nightcord';
    this.context.textContent = `Nightcord · ${room}`;
    const labels = { message: '新消息', mention: '提到了你', reply: '回复了你', everyone: '全体提及', online: '上线动态', offline: '下线动态' };
    this.kind.textContent = labels[kind] || '动态';
    this.title.textContent = message?.user || text;
    this.summary.textContent = message ? this.preview(message) : '关注成员的新动态';
    this.footer.textContent = this.count > 1 ? `${this.count} 条新提醒 · 查看最新一条` : message ? '现在 · 点按查看' : '现在';
    this.avatar.textContent = message?.user?.slice(0, 1) || 'N';
    if (message?.profile) this.ui.profileUI?.avatar(this.avatar, message.profile, this.avatar.textContent);
    const announcement = `${this.title.textContent}，${this.kind.textContent}，${this.summary.textContent}${this.count > 1 ? `，共 ${this.count} 条` : ''}`;
    clearTimeout(this.liveTimer); this.liveTimer = setTimeout(() => { if (this.live) this.live.textContent = announcement; }, 150);
    this.pause(); this.remaining = 6500; this.arm();
  }
  pause() {
    if (this.timer == null) return;
    clearTimeout(this.timer); this.timer = null;
    this.remaining = Math.max(0, this.remaining - (Date.now() - this.startedAt));
  }
  arm() {
    this.pause();
    if (!this.node?.isConnected || this.hover || this.node.contains(document.activeElement)) return;
    this.startedAt = Date.now();
    this.timer = setTimeout(() => this.dismiss(), this.remaining);
  }
  dismiss() {
    clearTimeout(this.timer); clearTimeout(this.liveTimer); clearTimeout(this.focusTimer);
    this.timer = null;
    const focused = this.node?.contains(document.activeElement);
    this.node?.remove();
    this.node = null; this.live = null; this.message = null; this.hover = false; this.count = 0;
    if (focused) {
      const target = this.returnFocus?.isConnected && this.returnFocus.getClientRects().length && !this.returnFocus.closest('[inert]')
        ? this.returnFocus : this.ui.elements.chatInput;
      target?.focus({ preventScroll: true });
    }
  }
}
