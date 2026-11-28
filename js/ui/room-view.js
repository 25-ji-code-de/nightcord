/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** ChatRoomView: roomView component; ui supplies shared presentation context. */
class ChatRoomView {
  constructor(ui) { this.ui = ui; }

  updateHeading() {
    const roomname = this.ui.currentRoom;
    if (!roomname) return;
    const displayName = this.ui.managedChat?.manager.room?.name || this.ui.officialRooms?.find(room => room.id === roomname)?.name
      || (roomname === 'nightcord-default' ? '作业' : roomname === 'nightcord-test' ? '测试' : roomname);
    this.ui.elements.roomName.textContent = displayName;
    const heading = document.querySelector('#current-channel-name');
    if (heading) heading.textContent = displayName;
  }

  setCurrentRoom(roomname) {
    this.ui.readingPosition?.leave();
    this.ui.isAtBottom = true;
    // 下方会从缓存重建模型，未确认预览不跨房间/重新加载保留。
    this.ui.localNakoMessages.clear();
    this.ui.currentRoom = roomname;
    this.updateHeading();
    // 切换到新房间时，尝试从本地存储加载消息并渲染（若随后有 room:ready 会被覆盖为合并后的消息）
    try {
      const local = (this.ui.storage ? this.ui.storage.loadMessages(this.ui.currentRoom || 'nightcord-default') : this.ui.loadLocalMessages(this.ui.currentRoom || 'nightcord-default'));
      // transform similar to room:ready: ensure fields for rendering
      this.ui.messages = (Array.isArray(local) ? local : []).map(m => {
        const { user, text, timestamp } = m;
        const { name, avatar, color } = this.ui.generateAvatar(user);
        return {
          user: name,
          avatar,
          color,
          text,
          timestamp,
          profile: m.profile,
          sender: m.sender
        };
      });
      this.ui.lastMsgTimestamp = this.ui.storage ? this.ui.storage.getLastMsgTimestamp(this.ui.currentRoom || 'nightcord-default') : this.ui.getLastMsgTimestamp(this.ui.currentRoom || 'nightcord-default');
      this.ui.renderMessages();
    } catch (e) {
      // ignore
    }
    this.ui.eventBus.emit('room:changed', { roomname });
  }

  setSessionUnavailable() {
    this.ui.currentUser = null;
    this.ui.eventBus.emit('session:unavailable');
    this.ui.updateNavigationProfile();
  }

  setConnectionStatus(message) {
    const status = document.querySelector('#connection-status');
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
  }

  /**
   * 显示欢迎消息
   * @param {Object} data - 欢迎消息数据
   */
  showWelcomeMessages(data) {
    // 添加到消息数组，由 renderMessages 统一渲染，不写入本地历史。
    const messages = [
      { text: '警告: 此聊天室的参与者是互联网上的随机用户。用户名未经认证，任何人都可以冒充任何人。聊天记录将被保存。', color: 'bg-red-600' },
      { text: '提示: 点击头像或成员可查看其身份和个性签名；点击左侧在线用户列表中你的昵称可管理登录和资料。', color: 'bg-default' },
      { text: `欢迎来到聊天室: ${data.roomname}`, color: 'bg-default' }
    ];

    messages.forEach(({ text, color }) => {
      this.ui.messages.push(this.ui.createMessageData('系统', text, null, this.ui.systemIcon, color));
    });
  }
}
