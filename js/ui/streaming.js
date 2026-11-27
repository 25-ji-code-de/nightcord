/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** StreamingMessageView: streamingView component; ui supplies shared presentation context. */
class StreamingMessageView {
  constructor(ui) {
    this.ui = ui;
    this.streams = new Map();
    this.contents = new WeakMap();
    this.pending = new Set();
    this.frame = null;
    for (const event of ['room:changed', 'chat:cleared']) ui.eventBus.on(event, () => {
      for (const id of this.streams.keys()) this.cancelStreamingMessage(id);
    });
  }

  /**
   * 开始流式消息
   * @param {string} messageId - 消息 ID
   * @param {string} user - 用户名
   */
  startStreamingMessage(messageId, user) {
    const messageData = this.ui.createMessageData(user, '', Date.now());
    messageData.id = messageId;
    messageData.isStreaming = true;

    // 创建消息元素
    const msgDiv = this.ui.createMessageElement(messageData);
    msgDiv.dataset.messageId = messageId;
    msgDiv.classList.add('streaming');
    this.streams.set(messageId, msgDiv);
    this.contents.set(msgDiv, '');

    // 添加到 DOM
    this.ui.elements.chatlog.appendChild(msgDiv);

    // 智能滚动
    if (this.ui.shouldAutoScrollToBottom()) {
      this.ui.elements.chatlog.scrollTop = this.ui.elements.chatlog.scrollHeight;
    }

    return msgDiv;
  }

  /**
   * 追加流式内容
   * @param {string} messageId - 消息 ID
   * @param {string} chunk - 文本片段
   */
  appendStreamingContent(messageId, chunk) {
    // Resolve in O(1), even with thousands of messages preceding the preview.
    const msgDiv = this.streams.get(messageId);
    if (!msgDiv) return;

    // Keep the source separate from rendered text (Markdown/SEKAI tokens can
    // disappear from textContent). Coalesce all chunks received before a frame.
    this.contents.set(msgDiv, (this.contents.get(msgDiv) || '') + chunk);
    this.pending.add(msgDiv);
    if (this.frame !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      this.frame = requestAnimationFrame(() => this.flushStreamingContent());
    } else {
      this.flushStreamingContent();
    }
  }

  forgetStream(messageId) {
    const msgDiv = this.streams.get(messageId);
    this.streams.delete(messageId);
    this.pending.delete(msgDiv);
    if (msgDiv) this.contents.delete(msgDiv);
    if (!this.pending.size && this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    return msgDiv;
  }

  cancelStreamingMessage(messageId) {
    this.forgetStream(messageId)?.remove();
  }

  renderStreamingContent(msgDiv, content) {
    let textElement = msgDiv.querySelector('.message-text');
    if (!textElement) {
      textElement = document.createElement('p');
      textElement.className = 'message-text sekai-message__text';
      msgDiv.querySelector('.message-content')?.appendChild(textElement);
    }
    if (this.ui.sekaiRenderer) {
      textElement.replaceChildren(this.ui.sekaiRenderer.render(content));
    } else if (this.ui.stickerService) {
      textElement.replaceChildren(this.ui.stickerService.renderTextWithStickers(content));
    } else {
      textElement.textContent = content;
    }
  }

  flushStreamingContent() {
    this.frame = null;
    let changed = false;
    for (const msgDiv of this.pending) {
      // Cancellation or a room change can detach the preview before this frame.
      if (!this.ui.elements.chatlog.contains(msgDiv) || !msgDiv.classList.contains('streaming')) {
        this.forgetStream(msgDiv.dataset.messageId);
        continue;
      }
      this.renderStreamingContent(msgDiv, this.contents.get(msgDiv) || '');
      changed = true;
    }
    this.pending.clear();
    if (changed && this.ui.shouldAutoScrollToBottom()) {
      this.ui.elements.chatlog.scrollTop = this.ui.elements.chatlog.scrollHeight;
    }
  }

  /**
   * 完成流式消息
   * @param {string} messageId - 消息 ID
   * @param {string} user - 用户名
   * @param {string} fullContent - 完整内容
   * @param {string} reasoning - 思考过程
   */
  finishStreamingMessage(messageId, user, fullContent, reasoning = '') {
    // 移除流式标记，但保留消息元素
    const msgDiv = this.forgetStream(messageId);
    if (msgDiv) {
      delete msgDiv.dataset.messageId;
      msgDiv.classList.remove('streaming');

      // 确认回传时精确定位预览，不依赖渲染后的 textContent。
      msgDiv.dataset.localNakoMessageId = messageId;

      // 更新消息内容（去掉开头和结尾的空白）
      this.renderStreamingContent(msgDiv, fullContent.trim());

      // 如果有思考过程，在昵称旁边添加思考图标（仅桌面端显示）
      if (reasoning && reasoning.trim()) {
        const headerDiv = msgDiv.querySelector('.message-header');
        if (headerDiv) {
          const thinkingIcon = document.createElement('span');
          thinkingIcon.className = 'nako-thinking-icon';
          thinkingIcon.textContent = '💭';
          thinkingIcon.title = reasoning.trim();
          headerDiv.appendChild(thinkingIcon);
        }
      }
      if (this.ui.shouldAutoScrollToBottom()) {
        this.ui.elements.chatlog.scrollTop = this.ui.elements.chatlog.scrollHeight;
      }
    }

    // 预览只留在内存中；服务器确认后才保存，避免刷新回放出两条历史。
    const cleanContent = fullContent.trim();
    const messageData = this.ui.createMessageData(user, cleanContent, Date.now());
    messageData.localNakoMessageId = messageId;
    this.ui.messages.push(messageData);
    this.ui.localNakoMessages.set(messageId, {
      message: messageData,
      senderId: this.ui.currentUser?.id,
      room: this.ui.currentRoom
    });
  }

  /** 将自己的 AI 回传合并到原预览，保留其他用户和其他人设的同内容消息。 */
  confirmLocalNakoMessage(data) {
    if (!data.sender?.id) return false;

    for (const [messageId, local] of this.ui.localNakoMessages) {
      const message = local.message;
      if (local.room !== this.ui.currentRoom || !this.ui.messages.includes(message)) {
        this.ui.localNakoMessages.delete(messageId);
        continue;
      }
      if (local.senderId !== data.sender.id || message.user !== data.name || message.text !== data.message) continue;

      this.ui.localNakoMessages.delete(messageId);
      const preview = this.ui.elements.chatlog.querySelector(`[data-local-nako-message-id="${messageId}"]`);
      const thinkingIcon = preview?.querySelector('.nako-thinking-icon');
      if (preview) {
        const oldTimestamp = preview.dataset.timestamp;
        for (const key of [oldTimestamp, Number(oldTimestamp)]) {
          if (this.ui.messageIndex.get(key) === preview) {
            this.ui.messageIndex.delete(key);
            this.ui.messageMeta.delete(key);
          }
        }
      }
      message.timestamp = data.timestamp;
      message.sender = data.sender;
      delete message.localNakoMessageId;
      this.ui.saveMessageToStorage({ user: message.user, text: message.text, timestamp: message.timestamp, sender: message.sender });

      if (this.ui.messageBuild) {
        // A detached row may still contain the provisional timestamp/sender.
        // Restart the pending replacement from the now-confirmed model.
        this.ui.renderMessages();
        return true;
      }

      if (preview) {
        const confirmed = this.ui.createMessageElement(message);
        if (thinkingIcon) confirmed.querySelector('.message-header').appendChild(thinkingIcon);
        preview.replaceWith(confirmed);
      } else {
        this.ui.appendMessageToDOM(message);
      }
      return true;
    }
    return false;
  }
}
