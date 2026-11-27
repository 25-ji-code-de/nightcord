/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** ChatMessageView: messageView component; ui supplies shared presentation context. */
class ChatMessageView {
  constructor(ui) { this.ui = ui; }

  renderRoleplayAvatar(element, message) {
    if (typeof RoleplayView === 'undefined' || this.ui.managedChat
        || this.ui.currentRoom !== Roleplay.ROOM_ID || message.profile || !message.sender) return;
    RoleplayView.renderAvatar(element, message.user);
  }

  /**
   * 添加聊天消息到聊天日志
   * @param {string} name - 发送者名称
   * @param {string} message - 消息内容
   * @param {string} [avatar] - 发送者头像
   * @param {string} [color='bg-default'] - 头像背景颜色
   */
  addChatMessage(user, message, timestamp, avatar, color, profile, sender) {
    if (user === '系统') {
      this.addSystemMessage(message, timestamp, avatar, color);
    } else {
      this.addUserMessage(user, message, timestamp, avatar, color, profile, sender);
    }
  }

  /**
   * 添加系统消息（不保存到本地存储）
   * @private
   */
  addSystemMessage(message, timestamp, avatar, color) {
    const messageData = this.createMessageData('系统', message, timestamp, avatar, color);
    this.ui.messages.push(messageData);
    this.ui.appendMessageToDOM(messageData);
  }

  /**
   * 添加用户消息（保存到本地存储）
   * @private
   */
  addUserMessage(user, message, timestamp, avatar, color, profile, sender) {
    const messageData = { ...this.createMessageData(user, message, timestamp, avatar, color), profile, sender };
    this.ui.messages.push(messageData);

    const msgObj = {
      user: messageData.user,
      text: message,
      timestamp: messageData.timestamp,
      profile,
      sender
    };

    this.saveMessageToStorage(msgObj);
    this.ui.lastMsgTimestamp = msgObj.timestamp;

    this.ui.appendMessageToDOM(messageData);
  }

  /**
   * 创建消息数据对象
   * @private
   */
  createMessageData(user, message, timestamp, avatar, color) {
    const { name, avatar: userAvatar, color: userColor } = this.ui.generateAvatar(user);
    return {
      user: name,
      avatar: avatar ?? userAvatar,
      color: color ?? userColor,
      text: message,
      timestamp: timestamp || Date.now()
    };
  }

  /**
   * 保存消息到本地存储
   * @private
   */
  saveMessageToStorage(msgObj) {
    if (this.ui.managedChat) return;
    try {
      const room = this.ui.currentRoom || 'nightcord-default';
      if (this.ui.storage?.appendMessage) {
        this.ui.storage.appendMessage(room, msgObj);
        return;
      }
      let localMsgs = this.ui.storage
        ? this.ui.storage.loadMessages(room)
        : (this.ui.loadLocalMessages(room) || []);

      localMsgs.push(msgObj);

      if (localMsgs.length > 2000) {
        localMsgs = localMsgs.slice(localMsgs.length - 2000);
      }

      if (this.ui.storage) {
        this.ui.storage.saveMessages(room, localMsgs);
        this.ui.storage.setLastMsgTimestamp(room, msgObj.timestamp);
      } else {
        this.ui.saveLocalMessages(room, localMsgs);
        this.ui.setLastMsgTimestamp(room, msgObj.timestamp);
      }
    } catch (e) {
      // 静默失败，存储错误不应影响消息显示
    }
  }

  /**
   * 渲染单条消息
   * @param {Object} msg - 消息对象
   * @returns {HTMLElement}
   */
  createMessageElement(msg) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message';
    if (msg.localNakoMessageId) msgDiv.dataset.localNakoMessageId = msg.localNakoMessageId;

    // 存储 timestamp 用于回复跳转 + v2 Reply 预览元数据
    if (msg.timestamp) {
      const meta = {
        user: msg.user,
        text: msg.text || ''
      };
      msgDiv.dataset.timestamp = msg.timestamp;
      this.ui.messageIndex.set(msg.timestamp, msgDiv);
      this.ui.messageIndex.set(Number(msg.timestamp), msgDiv);
      this.ui.messageMeta.set(msg.timestamp, meta);
      this.ui.messageMeta.set(Number(msg.timestamp), meta);
    }

    if (msg.seq) msgDiv.dataset.seq = msg.seq;
    if (msg.replyKey) {
      this.ui.messageIndex.set(msg.replyKey, msgDiv);
      this.ui.messageMeta.set(msg.replyKey, { user: msg.user, text: msg.text });
    }

    // 检查是否被提及
    if (this.ui.isMentioned(msg.text)) {
      msgDiv.classList.add('mentioned');
    }

    // Avatar
    const avatarSpan = document.createElement('span');
    avatarSpan.className = `avatar ${msg.color}`;
    avatarSpan.innerHTML = msg.avatar;
    this.ui.profileUI.avatar(avatarSpan, msg.profile);
    this.renderRoleplayAvatar(avatarSpan, msg);
    this.ui.profileUI.makeTrigger(avatarSpan, msg.profile, { fromMessage: true });

    // Content
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    // Header
    const headerDiv = document.createElement('div');
    headerDiv.className = 'message-header';
    const userSpan = document.createElement('span');
    userSpan.className = 'message-user';
    userSpan.textContent = msg.user;
    this.ui.profileUI.makeTrigger(userSpan, msg.profile, { fromMessage: true });
    const timeSpan = document.createElement('span');
    timeSpan.className = 'message-time';
    timeSpan.textContent = msg.timestamp ? this.formatDate(msg.timestamp) : '';
    headerDiv.appendChild(userSpan);
    const badge = this.ui.profileUI.badge(msg.profile);
    if (badge) headerDiv.appendChild(badge);
    if (msg.sender) {
      const sender = document.createElement('span');
      sender.className = 'identity-badge';
      sender.textContent = `由 ${msg.sender.displayName} 转发`;
      this.ui.profileUI.makeTrigger(sender, msg.sender, { fromMessage: true });
      headerDiv.appendChild(sender);
    }
    headerDiv.appendChild(timeSpan);
    contentDiv.appendChild(headerDiv);

    // Message text - 使用 SEKAI Renderer 或降级到 StickerService
    if (msg.text) {
      const p = document.createElement('p');
      p.className = 'message-text sekai-message__text';

      let frag;
      if (this.ui.sekaiRenderer) {
        // 使用 SEKAI Renderer（支持富文本）
        frag = this.ui.sekaiRenderer.render(msg.text);
      } else if (this.ui.stickerService) {
        // 降级到 StickerService（仅支持 stickers）
        frag = this.ui.stickerService.renderTextWithStickers(msg.text);
      } else {
        // 最终降级到纯文本
        frag = document.createTextNode(msg.text);
      }

      p.appendChild(frag);
      contentDiv.appendChild(p);
    }

    if (msg.sticker) {
      const image = document.createElement('img'); image.className = 'dm-sticker';
      image.alt = '贴纸'; image.referrerPolicy = 'no-referrer'; image.src = msg.sticker;
      contentDiv.appendChild(image);
    }
    if (msg.delivery) {
      const status = document.createElement('span'); status.className = 'message-time';
      status.textContent = msg.delivery; status.setAttribute('role', 'status'); contentDiv.appendChild(status);
      if (msg.retry) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'rooms-button';
        retry.textContent = '重试发送'; retry.addEventListener('click', msg.retry); contentDiv.appendChild(retry);
      }
    }
    msgDiv.appendChild(avatarSpan);
    msgDiv.appendChild(contentDiv);

    // 回复按钮（只给非系统消息添加）
    if (msg.user !== '系统' && msg.timestamp && !msg.delivery) {
      const replyBtn = this.ui.createReplyButton(msg);
      msgDiv.appendChild(replyBtn);
    }

    return msgDiv;
  }

  /**
   * Format a timestamp into a human-readable string with special handling for a "30-hour" night-shift display.

   *
   * Behavior summary:
   * - If `timestamp` is falsy, returns an empty string.
   * - Final returned formats:
   *   - Same day (diffDays === 0): "HH:MM:SS" (plus the 30-hour parenthetical if applicable)
   *   - Yesterday (diffDays === 1): "昨天 HH:MM:SS"
   *   - Within the last week but not yesterday (1 < diffDays < 7): "周X HH:MM:SS" where 周X is one of ["周日","周一",...,"周六"]
   *   - Older than a week (diffDays >= 7): "M月D日 HH:MM:SS"
   *
   * Notes:
   * - This function depends on UIManager.MILLISECONDS_PER_DAY to calculate full-day differences.
   * - The "30-hour" clock is a display convention: times from 00:00 to 05:59 are shown as 24:xx–29:xx in parentheses.
   *   The parenthetical carries no day label — the message's day is always the one implied by the main clock,
   *   so the two readings can never contradict each other.
   *
   * @param {number|string|Date|null|undefined} timestamp - Value accepted by `new Date(timestamp)`. If falsy, the function returns an empty string.
   * @returns {string} A formatted, localized time string with contextual day label and optional 30-hour parenthetical.
   *
   * @example
   * // Same day
   * formatDate(Date.now()) // => "14:23:05"
   *
   * @example
   * // Early morning (30-hour clock in parentheses, no day word inside)
   * formatDate(new Date("2025-11-13T01:05:00").getTime()) // => "01:05:00（25:05:00）"
   *
   * @example
   * // Yesterday
   * formatDate(* timestamp from yesterday *) // => "昨天 23:15:10"
   *
   * @example
   * // Within last week
   * formatDate(* timestamp from last Wednesday *) // => "周三 09:00:00"
   *
   * @example
   * // Older than a week
   * formatDate(* timestamp from months ago *) // => "11月5日 07:30:00"
   */
  formatDate(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    let timeString = date.toLocaleTimeString();

    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.floor((startToday - startDate) / UIManager.MILLISECONDS_PER_DAY);

    // 0–6 点的消息补一个 30 小时制读数（01:05 → 25:05）。括号内不写日期词：
    // 日期一律由主时钟的日标签决定，避免出现“01:05（昨天 25:05）”这种自相矛盾的显示。
    if (date.getHours() < 6) {
      const h = date.getHours() + 24;
      const m = String(date.getMinutes()).padStart(2, '0');
      const s = String(date.getSeconds()).padStart(2, '0');
      timeString += `（${h}:${m}:${s}）`;
    }

    if (diffDays === 0) return timeString;
    if (diffDays === 1) return `昨天 ${timeString}`;
    if (diffDays > 1 && diffDays < 7) {
      const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      return `${weekdays[date.getDay()]} ${timeString}`;
    }
    return `${date.getMonth() + 1}月${date.getDate()}日 ${timeString}`;
  }
}
