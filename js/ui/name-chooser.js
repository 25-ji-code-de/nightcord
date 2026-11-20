/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** NameChooserView: nameChooser component; ui supplies shared presentation context. */
class NameChooserView {
  constructor(ui) { this.ui = ui; }

  /**
   * 初始化/显示用户名选择器
   * @param {Object} options -配置选项
   * @param {string} [options.mode='init'] - 模式: 'init' | 'change'
   * @param {string} [options.currentName=''] - 当前用户名（修改模式下使用）
   * @param {Function} callback - 成功时的回调函数 (username) => void
   */
  showNameChooser(options, callback, sekaiPassCallback) {
    const { mode = 'init', currentName = '' } = options;
    const { nameInput } = this.ui.elements;
    const nameChooser = document.querySelector('#name-chooser');
    const nameSubmit = document.querySelector('#name-submit');
    const nameError = document.querySelector('#name-error');

    // Elements for dynamic text
    const titleEl = document.querySelector('#chooser-title');
    const subtitleEl = document.querySelector('#chooser-subtitle');
    const submitTextEl = document.querySelector('#chooser-submit-text');
    const closeBtn = document.querySelector('#chooser-close');

    if (!nameInput || !nameChooser) return;

    // Reset UI state
    nameInput.classList.remove('error');
    nameInput.setAttribute('aria-invalid', 'false');
    if (nameError) {
      nameError.classList.remove('visible');
      nameError.textContent = '';
    }

    // Configure UI based on mode
    if (mode === 'change') {
      titleEl.textContent = '修改昵称';
      subtitleEl.textContent = '想要换个新名字吗？';
      submitTextEl.textContent = '确认修改';
      closeBtn.classList.remove('hidden');
      nameInput.value = currentName;
    } else {
      titleEl.textContent = 'Nightcord';
      subtitleEl.textContent = '请输入你的昵称以加入';
      submitTextEl.textContent = '进入 Nightcord';
      closeBtn.classList.add('hidden');

      // Load saved username only in init mode
      try {
        const savedUsername = localStorage.getItem('nightcord-username');
        if (savedUsername) nameInput.value = savedUsername;
      } catch (e) {}
    }

    if (nameChooser.classList.contains('hidden')) {
      this.ui.nameChooserReturnFocus = document.activeElement;
      this.ui.nameChooserBackground = document.querySelector('.chat-root');
      this.ui.nameChooserBackgroundWasInert = this.ui.nameChooserBackground?.inert;
    }

    // Keep keyboard and screen-reader navigation inside the dialog.
    if (this.ui.nameChooserBackground) this.ui.nameChooserBackground.inert = true;
    nameChooser.classList.remove('hidden');
    // 移动设备上不自动聚焦，避免虚拟键盘自动弹出
    if (window.innerWidth > 768) {
      nameInput.focus();
    } else {
      nameChooser.focus({ preventScroll: true });
    }

    // Save callback for the event handler
    this.ui.pendingNameCallback = callback;
    this.ui.pendingSekaiPassCallback = sekaiPassCallback;
    this.ui.nameChooserMode = mode;

    // Bind events only once
    if (!this.ui.nameChooserEventsBound) {
      this.bindNameChooserEvents();
      this.ui.nameChooserEventsBound = true;
    }
  }

  bindNameChooserEvents() {
    const { nameInput } = this.ui.elements;
    const nameChooser = document.querySelector('#name-chooser');
    const nameSubmit = document.querySelector('#name-submit');
    const nameError = document.querySelector('#name-error');
    const closeBtn = document.querySelector('#chooser-close');
    const sekaiPassLoginBtn = document.querySelector('#sekai-pass-login');

    const closeDialog = () => {
      nameChooser.classList.add('hidden');
      if (this.ui.nameChooserBackground) this.ui.nameChooserBackground.inert = this.ui.nameChooserBackgroundWasInert;
      const target = this.ui.nameChooserReturnFocus;
      if (target?.isConnected && target !== document.body) target.focus({ preventScroll: true });
      else if (window.innerWidth > 768) this.ui.elements.chatInput?.focus({ preventScroll: true });
      else nameInput.blur();
    };

    const showInputError = (msg) => {
      if (nameError) {
        nameError.textContent = msg;
        nameError.classList.add('visible');
      }
      nameInput.classList.add('error');
      nameInput.setAttribute('aria-invalid', 'true');
      // Animation
      const content = document.querySelector('.name-chooser-content');
      if (content && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        content.animate([
          { transform: 'translateX(0)' }, { transform: 'translateX(-10px)' },
          { transform: 'translateX(10px)' }, { transform: 'translateX(-10px)' },
          { transform: 'translateX(10px)' }, { transform: 'translateX(0)' }
        ], { duration: 400, easing: 'ease-in-out' });
      }
    };

    const clearInputError = () => {
      if (nameError) {
        nameError.classList.remove('visible');
        nameError.textContent = '';
      }
      nameInput.classList.remove('error');
      nameInput.setAttribute('aria-invalid', 'false');
    };

    const submit = () => {
      const username = nameInput.value.trim();
      if (!username) {
        showInputError('请输入昵称');
        if (window.innerWidth > 768) nameInput.focus();
        return;
      }

      if (username.length > 32) {
        showInputError('昵称太长了，请控制在 32 个字符以内');
        if (window.innerWidth > 768) nameInput.focus();
        return;
      }

      // Save to localStorage
      try {
        localStorage.setItem('nightcord-username', username);
      } catch (e) {
        console.warn('Failed to save username to localStorage:', e);
      }

      closeDialog();

      if (this.ui.pendingNameCallback) {
        this.ui.pendingNameCallback(username);
      }
    };

    // Events
    nameInput.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else {
        clearInputError();
      }
    });

    nameInput.addEventListener('input', clearInputError);

    nameChooser.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape' && this.ui.nameChooserMode === 'change') {
        e.preventDefault();
        closeDialog();
      } else if (e.key === 'Tab') {
        const controls = [...nameChooser.querySelectorAll('input, button')]
          .filter(el => !el.disabled && el.getClientRects().length);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === nameChooser)) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === nameChooser)) {
          e.preventDefault();
          first?.focus();
        }
      }
    });

    if (nameSubmit) {
      nameSubmit.addEventListener('click', (e) => {
        e.preventDefault();
        submit();
      });
    }

    // SEKAI Pass 登录按钮
    if (sekaiPassLoginBtn) {
      sekaiPassLoginBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (this.ui.pendingSekaiPassCallback) {
          this.ui.pendingSekaiPassCallback();
        }
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        closeDialog();
      });
    }

    // Click outside to close (only in change mode)
    nameChooser.addEventListener('click', (e) => {
      if (this.ui.nameChooserMode === 'change' && e.target === nameChooser) {
        closeDialog();
      }
    });
  }

  /**
   * 设置用户名选择器 (兼容旧接口，用于初始化)
   * @param {Function} callback - 用户名选择回调函数
   */
  setupNameChooser(callback, sekaiPassCallback) {
    // 持久保存 SEKAI Pass 回调，改昵称时也能用
    this.ui.sekaiPassLoginCallback = sekaiPassCallback;
    this.showNameChooser({ mode: 'init' }, callback, sekaiPassCallback);
  }
}
