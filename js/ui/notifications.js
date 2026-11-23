/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** ChatNotifications: notifications component; ui supplies shared presentation context. */
class ChatNotifications {
  /** 回复提醒自行退场的时长；悬停或聚焦时暂停。 */
  static REPLY_NOTICE_TTL = 8000;

  /** 预览文字上限，超出截断。 */
  static PREVIEW_LIMIT = 80;

  constructor(ui) {
    this.ui = ui;
    // 当前挂着的提醒与回复胶囊的让位观察器
    this.mentionNotice = null;
    this.replyNotice = null;
    this.replyLift = null;
    this.replyTimerCleanup = null;
  }

  /**
   * 被 @ 的站内提醒：右上角卡片，不自动消失。
   *
   * @param {{ name: string, message: string, timestamp: number, user?: Object, sender?: Object }} data
   */
  showMentionNotice(data) {
    const focusAction = this.mentionNotice?.contains(document.activeElement)
      ? document.activeElement.className : null;
    this._dismiss('mention', false);
    const notice = this._buildNotice({ kind: 'mention', data });
    if (!notice) return;
    document.body.appendChild(notice);
    this.mentionNotice = notice;
    this.ui.mentionNotice = notice;
    if (focusAction) notice.querySelector(`.${focusAction}`)?.focus({ preventScroll: true });
  }

  /**
   * 有人回复了我的消息：底部胶囊，读完即走。
   *
   * 与 @ 提醒分开是因为重量不同 —— 回复只是「有人接了你一句」，
   * 不需要一直占着屏幕，所以 8 秒后自行退场，悬停/聚焦时暂停。
   *
   * @param {{ name: string, message: string, timestamp: number, user?: Object, sender?: Object }} data
   */
  showReplyNotice(data) {
    const focusAction = this.replyNotice?.contains(document.activeElement)
      ? document.activeElement.className : null;
    this._dismiss('reply', false);
    const notice = this._buildNotice({ kind: 'reply', data });
    if (!notice) return;
    document.body.appendChild(notice);
    this.replyNotice = notice;
    this.ui.replyNotice = notice;
    this._watchReplyLift(notice);
    this._armReplyTimer(notice);
    if (focusAction) notice.querySelector(`.${focusAction}`)?.focus({ preventScroll: true });
  }

  /** 离开房间、清空花名册时收起全部提醒。 */
  clearNotices() {
    this._dismiss('mention');
    this._dismiss('reply');
  }

  /**
   * 组装一条提醒。两种提醒共用同一套结构，只是 CSS 把它们摆成卡片和胶囊。
   * @private
   */
  _buildNotice({ kind, data }) {
    if (!data || typeof data !== 'object') return null;
    const name = String(data.name || '').trim();
    if (!name) return null;

    const profile = data.user || data.sender || null;
    const notice = document.createElement('div');
    notice.className = `sekai-notice ${kind === 'mention' ? 'mention-notice' : 'reply-notice'}`;
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    // 备注：role="status" 本身隐含 aria-live="polite"，这里写明是为了不被外层覆盖。
    notice.dataset.notice = kind;
    notice.returnFocus = document.activeElement;

    const label = kind === 'mention' ? '提及' : '回复';
    const verb = kind === 'mention' ? '提到了你' : '回复了你';
    const clock = this._clock(data.timestamp);

    const body = document.createElement('div');
    body.className = 'sekai-notice__body';

    const meta = document.createElement('p');
    meta.className = 'sekai-notice__meta';
    meta.textContent = clock ? `${label} · ${clock}` : label;

    const title = document.createElement('p');
    title.className = 'sekai-notice__title';
    const who = document.createElement('b');
    who.textContent = name;
    title.append(who, document.createTextNode(` ${verb}`));

    body.append(meta, title);

    const preview = this._preview(data.message);
    if (preview) {
      const line = document.createElement('p');
      line.className = 'sekai-notice__preview';
      line.textContent = preview;
      body.append(line);
    }

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'sekai-notice__open';
    open.textContent = '查看';
    open.setAttribute('aria-label', `查看 ${name} 的${kind === 'mention' ? '提及' : '回复'}消息`);
    open.addEventListener('click', () => {
      this._jumpTo(data.timestamp);
      this._dismiss(kind);
    });

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'sekai-notice__close';
    close.textContent = '×';
    close.setAttribute('aria-label', kind === 'mention' ? '关闭提及提醒' : '关闭回复提醒');
    close.addEventListener('click', () => this._dismiss(kind));
    notice.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      this._dismiss(kind);
    });

    notice.append(this._avatar(name, profile), body, open, close);

    if (kind === 'reply') {
      // 倒计时发丝线：让「会自己走掉」这件事有形状。
      const bar = document.createElement('span');
      bar.className = 'sekai-notice__bar';
      const fill = document.createElement('i');
      fill.style.animationDuration = `${ChatNotifications.REPLY_NOTICE_TTL}ms`;
      bar.appendChild(fill);
      bar.setAttribute('aria-hidden', 'true');
      notice.append(bar);
    }

    return notice;
  }

  /**
   * Keep replies within the chat column and above the composer or completion list.
   * @private
   */
  _watchReplyLift(notice) {
    const list = document.getElementById('mention-list');
    const main = this.ui.elements.main;
    const composer = document.querySelector('.input-area');
    const update = () => {
      if (this.replyNotice !== notice) return;
      const rect = main?.getBoundingClientRect();
      if (rect?.width) {
        notice.style.setProperty('--reply-notice-center', `${rect.left + rect.width / 2}px`);
        notice.style.setProperty('--reply-notice-width', `${Math.max(0, rect.width - 24)}px`);
      }
      const tops = [composer, list].filter(node => node?.getClientRects().length)
        .map(node => node.getBoundingClientRect().top);
      if (tops.length) notice.style.setProperty('--reply-notice-bottom', `${Math.round(window.innerHeight - Math.min(...tops) + 12)}px`);
      else notice.style.removeProperty('--reply-notice-bottom');
    };
    const observer = new MutationObserver(update);
    if (list) observer.observe(list, { attributes: true, attributeFilter: ['class'], childList: true });
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    for (const node of [main, composer, list]) if (node) resize?.observe(node);
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    this.replyLift = { observer, resize, update };
    update();
  }

  /** @private */
  _releaseReplyLift() {
    if (!this.replyLift) return;
    this.replyLift.observer.disconnect();
    this.replyLift.resize?.disconnect();
    window.removeEventListener('resize', this.replyLift.update);
    window.visualViewport?.removeEventListener('resize', this.replyLift.update);
    this.replyLift = null;
  }

  /**
   * 回复提醒的 8 秒计时；指针悬停或键盘聚焦时暂停，离开后按剩余时间继续。
   * @private
   */
  _armReplyTimer(notice) {
    const fill = notice.querySelector('.sekai-notice__bar i');
    const ttl = ChatNotifications.REPLY_NOTICE_TTL;
    if (fill) fill.style.animationPlayState = 'paused';
    let remaining = ttl;
    let startedAt = 0;
    let timer = null;
    let hovered = notice.matches(':hover');

    const dismiss = () => {
      clearTimeout(timer);
      timer = null;
      // 期间已经被新提醒替换过：旧计时器不许摘掉别人的条子。
      if (this.replyNotice !== notice) return;
      this._dismiss('reply');
    };
    const start = () => {
      if (this.replyNotice !== notice || timer !== null || hovered || notice.contains(document.activeElement)) return;
      startedAt = Date.now();
      timer = setTimeout(dismiss, remaining);
      if (fill) fill.style.animationPlayState = 'running';
    };
    const pause = () => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      remaining = Math.max(0, remaining - (Date.now() - startedAt));
      if (fill) fill.style.animationPlayState = 'paused';
    };

    notice.addEventListener('pointerenter', () => { hovered = true; pause(); });
    notice.addEventListener('pointerleave', () => { hovered = false; start(); });
    notice.addEventListener('focusin', pause);
    notice.addEventListener('focusout', event => {
      if (!notice.contains(event.relatedTarget)) queueMicrotask(start);
    });
    this.replyTimerCleanup = () => { clearTimeout(timer); timer = null; };
    start();
  }

  /** @private */
  _dismiss(kind, restoreFocus = true) {
    const current = kind === 'mention' ? this.mentionNotice : this.replyNotice;
    const hadFocus = current?.contains(document.activeElement);
    if (kind === 'mention') {
      this.mentionNotice = null;
      this.ui.mentionNotice = null;
    } else {
      this._releaseReplyLift();
      this.replyTimerCleanup?.();
      this.replyTimerCleanup = null;
      this.replyNotice = null;
      this.ui.replyNotice = null;
    }
    // 同步摘掉：点「查看」后消息焦点要立刻接上，退场动画会把这段时间拉长。
    current?.remove();
    if (restoreFocus && hadFocus) {
      const target = current.returnFocus;
      const visible = target?.isConnected && target.getClientRects().length && !target.closest('[inert]');
      (visible ? target : this.ui.elements.chatInput)?.focus({ preventScroll: true });
    }
  }

  /**
   * 跳到提醒指向的那条消息。
   * @private
   * @returns {boolean} 消息还在 DOM 里时返回 true
   */
  _jumpTo(timestamp) {
    const url = Number(timestamp);
    const message = this.ui.messageIndex?.get(Number.isNaN(url) ? timestamp : url)
      || this.ui.messageIndex?.get(timestamp);
    if (!message?.scrollIntoView) return false;
    this.ui.sidebarFeatures?.close(false);
    message.scrollIntoView({ block: 'center' });
    message.classList.remove('message-highlighted');
    void message.offsetWidth;
    message.classList.add('message-highlighted');
    setTimeout(() => message.classList.remove('message-highlighted'), 2000);
    message.tabIndex = -1;
    message.focus({ preventScroll: true });
    return true;
  }

  /** @private */
  _avatar(name, profile) {
    const generated = this.ui.generateAvatar(name);
    const avatar = document.createElement('span');
    avatar.className = `sekai-notice__avatar avatar ${generated.color}`;
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = generated.avatar || '?';
    this.ui.profileUI?.avatar(avatar, profile);
    return avatar;
  }

  /**
   * 预览用纯文本：剥掉 SEKAI token 与格式化标记，避免提醒里出现原始语法。
   * @private
   */
  _preview(message) {
    if (!message) return '';
    const parts = this.ui.mentions?.parts(String(message));
    const source = (parts ? parts.map(part => {
      if (part.type === 'sekai' && this.ui.sekaiRenderer?._descBool(part.desc || {}, 'spoiler', false)) return '[剧透内容]';
      return part.raw || part.content || '';
    }).join('') : String(message)).replace(/\|\|(.*?)\|\|/g, '[剧透内容]');
    let text = '';
    try {
      text = this.ui.extractPlainTextForReply(source);
    } catch {
      text = source;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const limit = ChatNotifications.PREVIEW_LIMIT;
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }

  /** @private */
  _clock(timestamp) {
    const date = new Date(Number(timestamp) || Date.now());
    if (Number.isNaN(date.getTime())) return '';
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  /**
   * 显示错误消息
   * @param {string} message - 错误消息内容
   */
  showError(message) {
    this.ui.addChatMessage('系统', `错误: ${message}`, null, this.ui.systemIcon, 'bg-red-600');
  }

  /** A persistent choice, including when the phone resumes after its session expired. */
  showAuthExpired({ onRetry, onContinue, notice }) {
    const overlay = document.createElement('dialog');
    overlay.id = 'auth-expired-overlay';
    overlay.className = 'auth-error-overlay auth-expired-overlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-labelledby', 'auth-expired-title');
    overlay.setAttribute('aria-describedby', 'auth-expired-description');
    overlay.innerHTML = `
      <div class="auth-error-dialog">
        <img class="auth-expired-mark" src="/icons/sekai-pass.svg" width="48" height="48" alt="" aria-hidden="true">
        <h2 id="auth-expired-title" class="auth-error-title">SEKAI Pass 登录已过期。</h2>
        <p id="auth-expired-description" class="auth-error-desc">您可以重新登录 SEKAI Pass，也可以暂时以访客身份继续聊天。需要登录才能使用的功能（例如语音聊天），在您重新登录后即可恢复使用。</p>
        <p class="auth-error-desc" data-auth-error role="alert" hidden></p>
        <div class="auth-error-actions">
          <button type="button" class="auth-error-btn auth-error-btn--primary" data-action="retry">重新登录</button>
          <button type="button" class="auth-error-btn" data-action="continue">暂不登录，继续使用</button>
        </div>
      </div>
    `;
    if (notice) {
      const errorMessage = overlay.querySelector('[data-auth-error]');
      errorMessage.textContent = notice;
      errorMessage.hidden = false;
    }
    const buttons = [...overlay.querySelectorAll('button')];
    let busy = false;
    const dismiss = () => {
      if (overlay.open) overlay.close();
      overlay.remove();
    };
    const choose = async (retry) => {
      if (busy) return;
      busy = true;
      buttons.forEach(button => { button.disabled = true; });
      const button = buttons[retry ? 0 : 1];
      const label = button.textContent;
      button.textContent = retry ? '正在打开登录…' : '正在继续…';
      const errorMessage = overlay.querySelector('[data-auth-error]');
      errorMessage.hidden = true;
      try {
        await (retry ? onRetry() : onContinue());
        if (retry) {
          // Keep the choice usable if mobile Back restores this page from the page cache.
          busy = false;
          buttons.forEach(control => { control.disabled = false; });
          button.textContent = label;
        } else dismiss();
      } catch {
        errorMessage.textContent = retry ? '目前无法打开登录页面；请重试，或选择继续使用。' : '目前无法恢复访客身份；请重试。';
        errorMessage.hidden = false;
        busy = false;
        buttons.forEach(control => { control.disabled = false; });
        button.textContent = label;
        button.focus();
      }
    };
    buttons[0].addEventListener('click', () => { void choose(true); });
    buttons[1].addEventListener('click', () => { void choose(false); });
    overlay.addEventListener('cancel', event => {
      event.preventDefault();
      void choose(false);
    });
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') event.stopPropagation();
      if (event.key !== 'Tab') return;
      if (event.shiftKey && document.activeElement === buttons[0]) {
        event.preventDefault(); buttons[1].focus();
      } else if (!event.shiftKey && document.activeElement === buttons[1]) {
        event.preventDefault(); buttons[0].focus();
      }
    });
    document.body.appendChild(overlay);
    overlay.showModal();
    buttons[0].focus();
    return dismiss;
  }

  /**
   * 显示结构化的认证错误弹层。
   *
   * 入参是 `window.describeAuthError(error)` 的返回值：带错误码、中文标题、
   * 原因说明、解决方案，以及供调试用的 sourceCode / originalMessage。
   *
   * 与聊天流内的 {@link showError} 不同，登录失败发生在进入聊天室之前，
   * 此时没有消息流可写，所以用一个独立的模态弹层承载。
   *
   * @param {{code: string, title: string, description: string, solution: string, sourceCode: (string|null), originalMessage: string}} descriptor
   * @param {{onRetry?: () => void}} [options] 提供 onRetry 时显示「重新登录」按钮
   */
  showAuthError(descriptor, options = {}) {
    const esc = window.escapeHtml || ((v) => String(v == null ? '' : v));
    const d = descriptor || {};
    const code = esc(d.code || 'ERR_AUTH_UNKNOWN');
    const title = esc(d.title || '登录失败');
    const description = esc(d.description || '');
    const solution = esc(d.solution || '');
    // 调试细节：优先展示原始英文 message，附带 SDK 的 sourceCode
    const debugParts = [];
    if (d.sourceCode) debugParts.push(`code=${d.sourceCode}`);
    if (d.originalMessage) debugParts.push(d.originalMessage);
    const debug = esc(debugParts.join(' · '));

    // 移除可能残留的旧弹层，避免叠加
    const existing = document.getElementById('auth-error-overlay');
    if (existing) {
      existing.close();
      existing.remove();
    }

    const overlay = document.createElement('dialog');
    overlay.id = 'auth-error-overlay';
    overlay.className = 'auth-error-overlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'auth-error-title');

    const retryButton = typeof options.onRetry === 'function'
      ? '<button type="button" class="auth-error-btn auth-error-btn--primary" data-action="retry">重新登录</button>'
      : '';

    overlay.innerHTML = `
      <div class="auth-error-dialog">
        <div class="auth-error-icon" aria-hidden="true">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
        </div>
        <div class="auth-error-code">${code}</div>
        <h2 id="auth-error-title" class="auth-error-title">${title}</h2>
        ${description ? `<p class="auth-error-desc">${description}</p>` : ''}
        ${solution ? `<div class="auth-error-solution"><span class="auth-error-solution__label">解决方案</span><span>${solution}</span></div>` : ''}
        ${debug ? `<div class="auth-error-debug">${debug}</div>` : ''}
        <div class="auth-error-actions">
          ${retryButton}
          <button type="button" class="auth-error-btn" data-action="close">关闭</button>
        </div>
      </div>
    `;

    const close = () => overlay.close();
    overlay.addEventListener('close', () => {
      overlay.remove();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('[data-action="close"]').addEventListener('click', close);
    const retryEl = overlay.querySelector('[data-action="retry"]');
    if (retryEl) {
      retryEl.addEventListener('click', () => {
        close();
        options.onRetry();
      });
    }
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === 'Tab') {
        const buttons = overlay.querySelectorAll('button');
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });

    document.body.appendChild(overlay);
    overlay.showModal();
    // 聚焦首个按钮，便于键盘操作
    const firstBtn = overlay.querySelector('.auth-error-btn');
    if (firstBtn) firstBtn.focus();
  }
}
