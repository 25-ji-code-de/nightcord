/* SPDX-License-Identifier: AGPL-3.0-only */
(function (global) {
  'use strict';

  function safeAvatar(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }

  function actionIcon(name) {
    const paths = {
      close: 'M18 6 6 18M6 6l12 12',
      edit: 'm16 3 5 5M3 21l5-1L20 8a3.54 3.54 0 0 0-5-5L3 15v6Z',
      refresh: 'M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.55-2.4L20 7M4 17l2.35 2.4A7 7 0 0 0 17.9 17',
      logout: 'M9 5H5v14h4M13 8l4 4-4 4M9 12h12',
      login: 'M15 5h4v14h-4M8 8l4 4-4 4M3 12h9',
      chevron: 'm8 10 4 4 4-4',
    };
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.75');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', paths[name]);
    icon.appendChild(path);
    return icon;
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
      const own = this.ui.currentUser && this.ui.currentUser.id === profile.id;
      const dialog = document.createElement('dialog');
      this.dialog = dialog;
      dialog.className = 'sekai-modal user-profile-dialog';
      dialog.setAttribute('aria-labelledby', 'profile-title');
      let closing;
      const dismiss = () => {
        if (closing) return closing;
        if (global.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          dialog.close();
          return Promise.resolve();
        }
        closing = new Promise(resolve => {
          dialog.classList.add('is-closing');
          let fallbackTimer;
          const finish = () => {
            clearTimeout(fallbackTimer);
            dialog.removeEventListener('animationend', onAnimationEnd);
            dialog.close();
            resolve();
          };
          const onAnimationEnd = event => {
            if (event.target === dialog && event.animationName === 'profile-dialog-out') finish();
          };
          dialog.addEventListener('animationend', onAnimationEnd);
          fallbackTimer = setTimeout(finish, 220);
        });
        return closing;
      };
      const close = document.createElement('button');
      close.type = 'button'; close.className = 'profile-close';
      close.setAttribute('aria-label', '关闭资料');
      close.title = '关闭';
      close.appendChild(actionIcon('close'));
      close.addEventListener('click', dismiss);
      dialog.appendChild(close);

      const header = document.createElement('header'); header.className = 'profile-header';
      const eyebrow = document.createElement('p'); eyebrow.className = 'profile-eyebrow';
      eyebrow.textContent = own ? '我的资料' : '成员资料';
      const summary = document.createElement('div'); summary.className = 'profile-summary';
      const avatar = document.createElement('span');
      const fallback = this.ui.generateAvatar(profile.displayName || '访客');
      avatar.className = `avatar profile-avatar ${fallback.color}`;
      avatar.textContent = fallback.avatar;
      this.avatar(avatar, profile);
      const heading = document.createElement('div'); heading.className = 'profile-heading';
      const title = document.createElement('h2');
      title.id = 'profile-title';
      const name = document.createElement('span'); name.textContent = profile.displayName || '访客';
      title.appendChild(name);
      const badge = this.badge(profile);
      if (badge) title.appendChild(badge);
      heading.appendChild(title);
      if (profile.username) {
        const handle = document.createElement('p');
        handle.className = 'profile-handle'; handle.textContent = `@${profile.username}`;
        heading.appendChild(handle);
      }
      summary.append(avatar, heading);
      header.append(eyebrow, summary);
      dialog.appendChild(header);

      const body = document.createElement('div'); body.className = 'profile-body';
      const bioLabel = document.createElement('h3'); bioLabel.className = 'profile-section-label'; bioLabel.textContent = '个性签名';
      const description = document.createElement('p');
      description.className = 'profile-bio'; description.textContent = profile.bio || (profile.authenticated ? '还没有填写个性签名。' : '您的访客资料存储在此浏览器中；清除 Cookie 或切换浏览器后，资料将会更改。登录 SEKAI Pass 即可在不同设备上使用同一账号并显示您的头像和签名。');
      if (!profile.bio) description.classList.add('profile-bio--empty');
      body.append(bioLabel, description);

      const details = document.createElement('details'); details.className = 'profile-identity';
      const disclosure = document.createElement('summary');
      const disclosureLabel = document.createElement('span'); disclosureLabel.textContent = profile.authenticated ? '账号信息' : '访客身份';
      disclosure.append(disclosureLabel, actionIcon('chevron'));
      const identityContent = document.createElement('div'); identityContent.className = 'profile-identity-content';
      const label = document.createElement('p'); label.className = 'profile-id-label'; label.textContent = profile.authenticated ? '唯一账号 ID' : '访客 ID';
      const identity = document.createElement('code'); identity.className = 'profile-id'; identity.textContent = profile.id || '未连接';
      identityContent.append(label, identity);
      details.append(disclosure, identityContent);
      body.appendChild(details);
      dialog.appendChild(body);

      const actions = document.createElement('div'); actions.className = 'profile-actions';
      const action = (text, icon, callback, className = '') => {
        const button = document.createElement('button'); button.type = 'button';
        button.className = `profile-action ${className}`;
        const label = document.createElement('span'); label.textContent = text;
        button.append(actionIcon(icon), label);
        button.addEventListener('click', async () => {
          if (button.disabled) return;
          button.disabled = true;
          try {
            await dismiss();
            await callback();
          } catch { this.ui.showError('操作未完成，请重试。'); }
        });
        return button;
      };
      if (own && profile.authenticated) {
        const settings = document.createElement('a'); settings.className = 'name-submit profile-action profile-action--primary';
        const settingsLabel = document.createElement('span'); settingsLabel.textContent = '编辑 SEKAI Pass 资料';
        settings.append(actionIcon('edit'), settingsLabel);
        settings.href = 'https://id.nightcord.de5.net/settings'; settings.target = '_blank'; settings.rel = 'noopener noreferrer';
        actions.appendChild(settings);
        const secondary = document.createElement('div'); secondary.className = 'profile-secondary-actions';
        secondary.append(
          action('同步资料', 'refresh', () => this.ui.onRefreshProfile?.()),
          action('退出登录', 'logout', () => this.ui.onLogout?.(), 'profile-action--quiet'),
        );
        actions.appendChild(secondary);
      } else if (own && !profile.authenticated) {
        actions.append(
          action('使用 SEKAI Pass 登录', 'login', () => this.ui.sekaiPassLoginCallback?.(), 'name-submit profile-action--primary'),
          action('修改访客昵称', 'edit', () => {
            this.ui.showNameChooser({ mode: 'change', currentName: profile.displayName }, (name) => this.ui.onSetUser?.(name), this.ui.sekaiPassLoginCallback);
          }, 'profile-action--quiet'),
        );
      }
      if (actions.childElementCount) dialog.appendChild(actions);
      dialog.addEventListener('cancel', event => { event.preventDefault(); void dismiss(); });
      let backdropDown = false;
      dialog.addEventListener('pointerdown', event => {
        const rect = dialog.getBoundingClientRect();
        backdropDown = event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
      });
      dialog.addEventListener('click', event => {
        if (backdropDown && event.target === dialog) void dismiss();
        backdropDown = false;
      });
      dialog.addEventListener('close', () => {
        dialog.remove();
        if (this.dialog === dialog) {
          this.dialog = null;
          if (previousFocus && previousFocus.isConnected) previousFocus.focus();
        }
      }, { once: true });
      document.body.appendChild(dialog);
      dialog.showModal();
    }
  }

  global.NightcordProfileUI = NightcordProfileUI;
})(window);
