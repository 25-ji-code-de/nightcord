/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** ChatComposerView: composer component; ui supplies shared presentation context. */
class ChatComposerView {
  constructor(ui) { this.ui = ui; }

  /**
   * 设置聊天室界面
   * @param {Function} onSendMessage - 发送消息时的回调函数 (message) => void
   * @param {Function} onSetUser - 设置用户名时的回调函数 (username) => void
   */
  setupChatRoom(onSendMessage, onSetUser) {
    const { chatInput, chatlog } = this.ui.elements;

    // 保存回调函数
    if (onSendMessage) {
      this.ui.onSendMessage = onSendMessage;
    }
    if (onSetUser) {
      this.ui.onSetUser = onSetUser;
    }

    if (this.ui.chatRoomListenersBound) return;
    this.ui.chatRoomListenersBound = true;

    // 监听滚动事件，检测用户是否接近底部
    chatlog.addEventListener("scroll", UIManager.throttle(() => {
      const distanceFromBottom = chatlog.scrollHeight - chatlog.scrollTop - chatlog.clientHeight;
      // 如果距离底部小于阈值，认为用户在底部附近
      this.ui.isAtBottom = distanceFromBottom < this.ui.scrollThreshold;
      this.ui.updateUserActivityTime();
    }, 100).bind(this));

    // 监听触摸事件（移动端）
    chatlog.addEventListener("touchmove", UIManager.throttle(() => {
      this.ui.updateUserActivityTime();
    }, 100).bind(this));

    // 监听鼠标滚轮事件（桌面端）
    chatlog.addEventListener("wheel", UIManager.throttle(() => {
      this.ui.updateUserActivityTime();
    }, 100).bind(this));

    // Submit message
    chatInput.addEventListener("keydown", async (event) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      // 如果提及/贴纸列表正在显示，按 Enter 时不发送消息（交给自动补全处理）
      if (event.key === "Enter" && this.ui.autocomplete && this.ui.autocomplete.isOpen()) {
        return;
      }

      // Shift+Enter 换行逻辑
      if (event.key === "Enter" && event.shiftKey) {
        // 允许默认行为（textarea 自动插入换行符）
        // 触发自适应高度调整
        setTimeout(() => {
          chatInput.dispatchEvent(new Event('input', { bubbles: true }));
        }, 0);
        return; // 不执行发送逻辑
      }

      if (event.key === "Enter" && !event.shiftKey && chatInput.value.trim() !== "") {
        event.preventDefault(); // 阻止 textarea 默认换行行为
        if (this.ui.onSendMessage?.(chatInput.value.trim()) !== false) {
          this.ui.isAtBottom = true;
          this.ui.updateUserActivityTime();
        }
      }
    });

    // Limit message length — must match server-side cap (currently 256)
    // Do not raise client-side alone: users would compose messages the server rejects/truncates.
    const MAX_MESSAGE_LENGTH = 256;
    chatInput.addEventListener("input", (event) => {
      const input = event.currentTarget;

      // 1. 字符限制（与服务端一致）
      if (input.value.length > MAX_MESSAGE_LENGTH) {
        input.value = input.value.slice(0, MAX_MESSAGE_LENGTH);
        if (!input.dataset.lengthToast) {
          input.dataset.lengthToast = '1';
          this.ui.addChatMessage('系统', `消息过长，已截断至 ${MAX_MESSAGE_LENGTH} 字符（服务端限制）`, Date.now(), this.ui.systemIcon, 'bg-red-600');
          setTimeout(() => { delete input.dataset.lengthToast; }, 2000);
        }
      }

      // 2. 自适应高度调整
      input.style.height = 'auto'; // 重置高度以获取正确的 scrollHeight
      const newHeight = Math.min(Math.max(input.scrollHeight, 22), 140);
      input.style.height = `${newHeight}px`;

      // 3. 超过最大高度时显示滚动条
      if (input.scrollHeight > 140) {
        input.style.overflowY = 'auto';
      } else {
        input.style.overflowY = 'hidden';
      }
    });

    /**
     * Handles bracket insertion with auto-pairing for both keyboard and emoji button inputs.
     * - If there is a selection, wraps the selected text with [ and ] and places the caret after the closing bracket.
     * - If the next character is ']', skips over it instead of inserting a duplicate.
     * - Otherwise, inserts paired [] and places the caret between them.
     *
     * @param {HTMLInputElement|HTMLTextAreaElement} input - The input element to modify.
     * @param {boolean} fromButton - Track a new empty pair while browsing stickers.
     */
    const handleLeftBracket = (input, fromButton = false) => {
      const val = input.value || '';
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? start;

      if (start === end && val.charAt(start) === ']') {
        input.setSelectionRange(start + 1, start + 1);
        if (window.innerWidth > 768) input.focus();
        return;
      }

      if (fromButton && val.length + 2 > MAX_MESSAGE_LENGTH) {
        this.ui.showError('消息剩余空间不足，无法插入表情括号。');
        return;
      }

      if (start !== end) {
        // wrap selection with [ ... ] and place caret after the closing bracket
        const newVal = val.slice(0, start) + '[' + val.slice(start, end) + ']' + val.slice(end);
        input.value = newVal;
        const caretPos = end + 2; // after the closing ]
        input.setSelectionRange(caretPos, caretPos);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        if (window.innerWidth > 768) input.focus();
        return;
      }

      // insert paired [] and put caret between
      const newVal = val.slice(0, start) + '[]' + val.slice(end);
      input.value = newVal;
      const caretPos = start + 1;
      input.setSelectionRange(caretPos, caretPos);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (fromButton && this.ui.autocomplete?.isOpen('sticker')) {
        this.ui.autocomplete.pendingStickerPair = { start, value: newVal };
      }
      if (window.innerWidth > 768) input.focus();
    };

    // Bracket auto-pairing and overwrite behavior for keyboard input
    chatInput.addEventListener('keydown', (event) => {
      try {
        const val = chatInput.value || '';
        const start = chatInput.selectionStart ?? 0;
        const end = chatInput.selectionEnd ?? start;

        // '[': use shared handler
        if (event.key === '[') {
          event.preventDefault();
          handleLeftBracket(chatInput);
          return;
        }

        // ']': if next is ']', skip over instead of inserting duplicate
        if (event.key === ']') {
          if (start === end && val.charAt(start) === ']') {
            event.preventDefault();
            chatInput.setSelectionRange(start + 1, start + 1);
            return;
          }
          // otherwise allow default insertion
        }

        // Backspace: if caret is between an empty pair [] then delete both
        if (event.key === 'Backspace') {
          if (start === end && start > 0 && val.charAt(start - 1) === '[' && val.charAt(start) === ']') {
            event.preventDefault();
            const newVal = val.slice(0, start - 1) + val.slice(start + 1);
            const caretPos = start - 1;
            chatInput.value = newVal;
            chatInput.setSelectionRange(caretPos, caretPos);
            chatInput.dispatchEvent(new Event('input', { bubbles: true }));
            return;
          }
        }
      } catch (e) {
        // don't block typing on unexpected errors
        console.warn('Error in keydown handler (bracket auto-pairing and backspace) for key:', event.key, {
          value: chatInput.value,
          selectionStart: chatInput.selectionStart,
          selectionEnd: chatInput.selectionEnd
        }, e);
      }
    });

    // Focus chat input on click
    this.ui.elements.main.addEventListener("click", (e) => {
      // Keep controls and overlays in charge of their own focus, including native popovers.
      if (e.target.closest('.mention-list, .mention-item, .profile-trigger, button, a, input, select, textarea, label, summary, [contenteditable], [popover], dialog, [role="dialog"]')) return;

      if (window.getSelection().toString() == "") {
        if (window.innerWidth > 768) chatInput.focus();
      }
    });

    // 移动设备上不自动聚焦聊天输入框
    if (window.innerWidth > 768) {
      chatInput.focus();
    }

    this.ui.elements.stickerButton?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.ui.autocomplete?.isOpen('sticker')) {
        this.ui.autocomplete.hideList();
        if (window.innerWidth > 768) chatInput.focus();
        return;
      }
      handleLeftBracket(chatInput, true);
    });

    window.bindComposerFormat?.(this.ui, MAX_MESSAGE_LENGTH);

    // 附件按钮：显示/隐藏文件上传菜单
    this.ui.setupFileUpload();
  }

  /**
   * 清空聊天输入框
   */
  clearChatInput() {
    this.ui.elements.chatInput.value = "";
    this.ui.elements.chatInput.style.height = 'auto'; // 重置为单行高度
  }
}
