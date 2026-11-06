/* SPDX-License-Identifier: AGPL-3.0-only */
(function (global) {
  'use strict';

  function safeAvatar(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }

  class NightcordProfileUI {
    constructor(ui) { this.ui = ui; this.dialog = null; }

    avatar(element, profile) {
      const source = safeAvatar(profile && profile.avatarUrl);
      if (!source) return;
      const fallback = element.textContent;
      const image = document.createElement('img');
      image.src = source;
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => { element.textContent = fallback; }, { once: true });
      element.replaceChildren(image);
    }

    badge(profile) {
      if (profile?.authenticated !== true) return null;
      const badge = document.createElement('span');
      badge.className = 'identity-badge identity-badge--verified';
      badge.title = '身份已由 SEKAI Pass 验证';
      badge.setAttribute('role', 'img');
      badge.setAttribute('aria-label', badge.title);
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('aria-hidden', 'true');
      icon.setAttribute('focusable', 'false');
      const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      shape.setAttribute('fill', 'currentColor');
      shape.setAttribute('fill-rule', 'evenodd');
      shape.setAttribute('d', 'M23 12l-2.44-2.79.34-3.69-3.61-.82L15.4 1.5 12 2.96 8.6 1.5 6.71 4.7 3.1 5.51l.34 3.7L1 12l2.44 2.79-.34 3.7 3.61.82L8.6 22.5l3.4-1.47 3.4 1.46 1.89-3.19 3.61-.82-.34-3.69L23 12zm-12.91 4.72L5.86 12.48l1.41-1.41 2.82 2.83 6.83-6.85 1.41 1.41-8.24 8.26z');
      icon.appendChild(shape);
      badge.appendChild(icon);
      return badge;
    }

    makeTrigger(element, profile) {
      if (!profile) return;
      element.classList.add('profile-trigger');
      element.tabIndex = 0;
      element.setAttribute('role', 'button');
      element.setAttribute('aria-label', `查看 ${profile.displayName} 的资料`);
      element.addEventListener('click', () => this.open(profile));
      element.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.open(profile); }
      });
    }

    open(profile) {
      if (this.dialog) this.dialog.close();
      const previousFocus = document.activeElement;
      const dialog = document.createElement('dialog');
      this.dialog = dialog;
      dialog.className = 'user-profile-dialog';
      dialog.setAttribute('aria-labelledby', 'profile-title');
      const close = document.createElement('button');
      close.type = 'button'; close.className = 'profile-close'; close.textContent = '关闭';
      close.addEventListener('click', () => dialog.close());
      dialog.appendChild(close);

      const avatar = document.createElement('span');
      const fallback = this.ui.generateAvatar(profile.displayName || '访客');
      avatar.className = `avatar profile-avatar ${fallback.color}`;
      avatar.textContent = fallback.avatar;
      this.avatar(avatar, profile);
      dialog.appendChild(avatar);
      const title = document.createElement('h2');
      title.id = 'profile-title'; title.textContent = profile.displayName || '访客';
      dialog.appendChild(title);
      const badge = this.badge(profile);
      if (badge) dialog.appendChild(badge);
      if (profile.username) {
        const handle = document.createElement('p');
        handle.className = 'profile-handle'; handle.textContent = `@${profile.username}`;
        dialog.appendChild(handle);
      }
      const description = document.createElement('p');
      description.className = 'profile-bio'; description.textContent = profile.bio || (profile.authenticated ? '还没有填写个性签名。' : '访客身份仅在当前会话期间有效；登录后即可显示您的头像和个人签名。');
      dialog.appendChild(description);
      const label = document.createElement('p'); label.className = 'profile-id-label'; label.textContent = profile.authenticated ? '唯一账号 ID' : '本次访客 ID';
      const identity = document.createElement('code'); identity.className = 'profile-id'; identity.textContent = profile.id || '未连接';
      dialog.append(label, identity);

      const actions = document.createElement('div'); actions.className = 'profile-actions';
      const action = (text, callback) => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
        button.addEventListener('click', callback); actions.appendChild(button); return button;
      };
      const own = this.ui.currentUser && this.ui.currentUser.id === profile.id;
      if (own && profile.authenticated) {
        const settings = document.createElement('a'); settings.textContent = '编辑 SEKAI Pass 资料';
        settings.href = 'https://id.nightcord.de5.net/settings'; settings.target = '_blank'; settings.rel = 'noopener noreferrer';
        actions.appendChild(settings);
        action('同步资料', () => { void this.ui.onRefreshProfile?.(); dialog.close(); });
        action('退出登录', () => { dialog.close(); void this.ui.onLogout?.(); });
      } else if (own && !profile.authenticated) {
        action('使用 SEKAI Pass 登录', () => { void this.ui.sekaiPassLoginCallback?.(); });
        action('修改访客昵称', () => {
          dialog.close();
          this.ui.showNameChooser({ mode: 'change', currentName: profile.displayName }, (name) => this.ui.onSetUser?.(name), this.ui.sekaiPassLoginCallback);
        });
      }
      dialog.appendChild(actions);
      dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
      dialog.addEventListener('close', () => {
        dialog.remove();
        if (this.dialog === dialog) this.dialog = null;
        if (previousFocus && previousFocus.isConnected) previousFocus.focus();
      }, { once: true });
      document.body.appendChild(dialog);
      dialog.showModal();
    }
  }

  global.NightcordProfileUI = NightcordProfileUI;
})(window);
