/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** ChatNotifications: notifications component; ui supplies shared presentation context. */
class ChatNotifications {
  constructor(ui) { this.ui = ui; }

  /**
   * 显示错误消息
   * @param {string} message - 错误消息内容
   */
  showError(message) {
    this.ui.addChatMessage('系统', `错误: ${message}`, null, this.ui.systemIcon, 'bg-red-600');
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
