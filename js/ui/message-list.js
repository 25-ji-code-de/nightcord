/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** MessageListView: messageList component; ui supplies shared presentation context. */
class MessageListView {
  constructor(ui) { this.ui = ui; }

  /**
   * 请求重建消息列表；同一帧内的追加会一并从最新 messages 渲染。
   */
  renderMessages() {
    this.ui.messageRenderPending = true;
    this.ui.messageBuild = null;
    // 重建包含所有当前消息，也会淘汰切换房间前尚未提交的追加。
    this.ui.pendingMessageAppends = [];
    this.scheduleMessageRender();
  }

  /**
   * 全量重建与增量追加共用一个帧任务，避免两者重复绘制同一条消息。
   * @private
   */
  scheduleMessageRender(continueBuild = false) {
    if (this.ui.messageRenderFrame !== null) return;

    if (typeof PerformanceOptimizer !== 'undefined') {
      const flush = () => {
        this.ui.messageRenderFrame = null;
        this.flushMessageRender();
      };
      // Yield between history chunks so input can run, without waiting for a
      // whole display frame for every chunk. Live appends still share one RAF.
      if (continueBuild) {
        this.ui.messageRenderFrame = globalThis.scheduler?.postTask
          ? scheduler.postTask(flush, { priority: 'user-visible' })
          : setTimeout(flush, 0);
      } else {
        this.ui.messageRenderFrame = PerformanceOptimizer.raf(flush);
      }
    } else {
      this.flushMessageRender();
    }
  }

  /**
   * 提交本帧消息更新，并在全部写入完成后统一滚动。
   * @private
   */
  flushMessageRender() {
    const rebuild = this.ui.messageRenderPending;
    const messages = rebuild ? this.ui.messages : this.ui.pendingMessageAppends;
    this.ui.messageRenderPending = false;
    this.ui.pendingMessageAppends = [];

    const measureRender = rebuild && typeof PerformanceOptimizer !== 'undefined';
    if (measureRender) PerformanceOptimizer.mark('renderMessages-start');

    // Build larger histories off the live document in short frame budgets.
    // Keep the existing list in place until the replacement is complete, so
    // readers never see a half-built history and scroll position stays stable.
    if (rebuild && messages.length > 40 && typeof PerformanceOptimizer !== 'undefined') {
      this.ui.messageBuild = {
        messages: messages.slice(), cursor: 0, sourceLength: messages.length,
        fragment: document.createDocumentFragment(),
        index: new Map(), meta: new Map()
      };
    }
    if (this.ui.messageBuild) {
      const build = this.ui.messageBuild;
      // New arrivals during the build are appended in the same replacement.
      build.messages.push(...this.ui.messages.slice(build.sourceLength));
      build.sourceLength = this.ui.messages.length;
      const liveIndex = this.ui.messageIndex;
      const liveMeta = this.ui.messageMeta;
      this.ui.messageIndex = build.index;
      this.ui.messageMeta = build.meta;
      const deadline = performance.now() + 6;
      let created = 0;
      try {
        while (build.cursor < build.messages.length && created < 20) {
          build.fragment.appendChild(this.ui.createMessageElement(build.messages[build.cursor++]));
          if (++created >= 4 && performance.now() >= deadline) break;
        }
      } finally {
        this.ui.messageIndex = liveIndex;
        this.ui.messageMeta = liveMeta;
      }
      if (build.cursor < build.messages.length) {
        this.scheduleMessageRender(true);
        return;
      }
      // A new stream can start while the detached history is being built.
      const streams = [...this.ui.elements.chatlog.querySelectorAll('.streaming')];
      for (const [key, node] of liveIndex) {
        if (!node.classList.contains('streaming')) continue;
        build.index.set(key, node);
        if (liveMeta.has(key)) build.meta.set(key, liveMeta.get(key));
      }
      this.ui.messageIndex = build.index;
      this.ui.messageMeta = build.meta;
      this.ui.elements.chatlog.replaceChildren(build.fragment, ...streams);
      this.ui.messageBuild = null;
      if (this.shouldAutoScrollToBottom()) this.ui.elements.chatlog.scrollTop = this.ui.elements.chatlog.scrollHeight;
      PerformanceOptimizer.mark('renderMessages-end');
      PerformanceOptimizer.measure('renderMessages', 'renderMessages-start', 'renderMessages-end');
      return;
    }

    const { chatlog } = this.ui.elements;
    const shouldAutoScroll = this.shouldAutoScrollToBottom();
    if (rebuild) {
      this.ui.messageIndex.clear();
      this.ui.messageMeta.clear();
    }

    const fragment = document.createDocumentFragment();
    messages.forEach(msg => fragment.appendChild(this.ui.createMessageElement(msg)));

    if (rebuild) {
      chatlog.replaceChildren(fragment);
    } else {
      // 保留已有消息节点及其状态，新消息仍排在流式回复之前。
      chatlog.insertBefore(fragment, chatlog.querySelector('.streaming'));
    }

    // Read the final height once per batch so new messages are visible without
    // delaying the scroll until another frame.
    if (shouldAutoScroll) chatlog.scrollTop = chatlog.scrollHeight;

    if (measureRender) {
      PerformanceOptimizer.mark('renderMessages-end');
      PerformanceOptimizer.measure('renderMessages', 'renderMessages-start', 'renderMessages-end');
    }
  }

  /**
   * 判断是否应该自动滚动到底部
   * 条件：
   * 1. 用户当前在底部附近 (距离底部 < scrollThreshold 像素)
   * 2. 或者用户最近没有触摸/滚动操作（超过指定时间窗口）
   * @returns {boolean}
   */
  shouldAutoScrollToBottom() {
    const timeSinceLastTouch = Date.now() - this.ui.lastUserActivityTime;
    // 如果用户在底部附近，或者已经很久没有交互，就自动滚动
    return this.ui.isAtBottom || timeSinceLastTouch > this.ui.interactionTimeWindow;
  }

  /**
   * 更新用户活动时间
   */
  updateUserActivityTime() {
    this.ui.lastUserActivityTime = Date.now();
  }

  /**
   * 将单条消息追加到聊天日志（不重渲染整个列表）
   * @param {Object} messageData - 消息数据
   * @private
   */
  appendMessageToDOM(messageData) {
    // 调用方已将 messageData 写入 messages；待执行的全量重建会包含它。
    if (!this.ui.messageRenderPending) this.ui.pendingMessageAppends.push(messageData);
    this.scheduleMessageRender();
  }
}
