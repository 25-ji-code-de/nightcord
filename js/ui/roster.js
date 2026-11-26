/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** RosterView: rosterView component; ui supplies shared presentation context. */
class RosterView {
  constructor(ui) { this.ui = ui; }

  updateNavigationProfile() {
    const button = this.ui.elements?.navigationProfile;
    const avatar = this.ui.elements?.navigationAvatar;
    if (!button || !avatar) return;
    button.disabled = !this.ui.currentUser;
    if (this.ui.elements.navigationProfileInfo) this.ui.elements.navigationProfileInfo.disabled = !this.ui.currentUser;
    if (!this.ui.currentUser) {
      avatar.className = 'navigation-avatar avatar bg-default';
      avatar.textContent = 'N';
      if (this.ui.elements.navigationName) {
        this.ui.elements.navigationName.textContent = '未连接';
        this.ui.elements.navigationName.removeAttribute('title');
      }
      return;
    }
    const current = this.ui.roster.find(member => member.profile?.id === this.ui.currentUser.id)?.profile || this.ui.currentUser;
    const fallback = this.ui.generateAvatar(current.displayName);
    if (this.ui.elements.navigationName) {
      this.ui.elements.navigationName.textContent = current.displayName;
      this.ui.elements.navigationName.title = current.displayName;
    }
    avatar.className = `navigation-avatar avatar ${fallback.color}`;
    this.ui.profileUI.avatar(avatar, current, fallback.avatar);
  }

  /**
   * 按在线、语音和离线分组渲染房间成员，移动已有节点以保留头像和资料入口。
   */
  renderVoiceUsers() {
    const { roster: onlineElement, voiceRoster, offlineRoster } = this.ui.elements;
    if (!onlineElement || !voiceRoster || !offlineRoster) return;
    const onlineIds = new Set(this.ui.roster.map(user => user.profile?.id));
    const voiceUsers = [...this.ui.voiceMembers.values()].map(member => {
      const online = this.ui.roster.find(user => user.profile?.id === member.user.id);
      const profile = online?.profile || this.ui.roomMembers.get(member.user.id) || member.user;
      return { ...this.ui.generateAvatar(profile.displayName), profile, voice: member, group: 'voice' };
    });
    const users = [
      ...this.ui.roster.filter(user => !this.ui.voiceMembers.has(user.profile?.id)).map(user => ({ ...user, group: 'online' })),
      ...voiceUsers,
      ...[...this.ui.roomMembers.values()].filter(profile => !onlineIds.has(profile.id) && !this.ui.voiceMembers.has(profile.id))
        .map(profile => ({ ...this.ui.generateAvatar(profile.displayName), profile, group: 'offline' }))
    ];
    const keyFor = user => user.profile?.id ? `id:${user.profile.id}` : `name:${user.name}`;
    const activeKeys = new Set(users.map(keyFor));
    for (const [key, element] of this.ui.rosterElements) {
      if (!activeKeys.has(key)) {
        element.remove();
        this.ui.rosterElements.delete(key);
      }
    }
    const groups = new Map([onlineElement, voiceRoster, offlineRoster].map(element => [element, []]));
    // 获取当前用户名
    let currentName = null;
    try {
      currentName = localStorage.getItem('nightcord-username');
    } catch (e) {}
    users.forEach(user => {
      const rosterElement = user.group === 'voice' ? voiceRoster : user.group === 'offline' ? offlineRoster : onlineElement;
      const key = keyFor(user);
      let div = this.ui.rosterElements.get(key);
      if (!div) {
        div = document.createElement('div');
        div.className = 'voice-user';
        this.ui.rosterElements.set(key, div);
        /*
         * user.name 来自别的用户 —— SEKAI Pass 的 name / preferred_username
         * claim，那边只校验长度（≤ 50 字符）。不转义的话，
         * `"><img src=x onerror=alert(1)>` 这样的昵称会在每个看到成员列表的
         * 人的浏览器里执行。
         *
         * color 与 avatar 本来是由 generateAvatar 生成的（固定色板 + 名字首字符），
         * 但它们跟名字来自同一个对象，一并转义，省得以后有人改了来源还要重新论证。
         */
        div.innerHTML = `
          <div class="voice-user-info">
            <span class="member-avatar">
              <span class="avatar ${escapeHtml(user.color)}">${escapeHtml(user.avatar)}</span>
              <span class="member-presence" role="img"></span>
            </span>
            <span class="voice-user-name">${escapeHtml(user.name)}</span>
          </div>
          <span class="member-video" aria-hidden="true" title="摄像头未开启"><svg width="18" height="16" viewBox="0 0 28 24" fill="currentColor" aria-hidden="true" focusable="false" data-navigation-icon="camera"><path fill-rule="evenodd" d="M3.7 16.3V6.6C3.7 5.1 4.3 4.65 5.8 4.65H15.95Q16.35 4.65 16.65 4.36L17.6 3.41Q18.2 2.78 17.4 2.63C17 2.5 16.9 2.5 16.1 2.5H5.7C3.6 2.5 1.65 3.98 1.65 6V17.9Q1.65 18.95 2.4 18.35L3.3 17.45Q3.7 17.05 3.7 16.3ZM24.3 7.1Q24.3 6.7 24.6 6.39L25.65 5.36Q26.35 4.85 26.35 6.45V16.45C26.35 18.7 25.75 19.65 24.55 19.55C23.75 19.55 23.3 19.07 22.3 18.6L21.3 18Q20.65 17.6 20.43 18.35C19.8 20.7 18.2 21.47 16.1 21.47H10.4Q9.55 21.47 10.1 20.8L11.23 19.65Q11.52 19.37 12.2 19.37H16.15C17.65 19.37 18.48 18.9 18.48 17.2V12.7Q18.48 12.1 18.9 11.69L20.17 10.43Q20.57 10.05 20.57 10.75V14.25Q20.57 15.2 21.3 15.65L23.7 17.05Q24.3 17.4 24.3 16.45Z"/><path d="M4 22 24 2" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/></svg></span>
          <span class="member-microphone" aria-hidden="true" hidden></span>
        `;
      }
      const info = div.querySelector('.voice-user-info');
      const avatar = info.querySelector('.avatar');
      avatar.setAttribute('aria-hidden', 'true');
      avatar.className = `avatar ${user.color}`;
      info.querySelector('.voice-user-name').textContent = user.name;
      this.ui.profileUI.avatar(avatar, user.profile, user.avatar);
      div.dataset.userId = user.profile?.id || '';
      div.classList.toggle('is-offline', user.group === 'offline');
      if (user.voice) div.dataset.memberId = user.voice.memberId;
      else { delete div.dataset.memberId; div.classList.remove('is-speaking'); }
      const presence = info.querySelector('.member-presence');
      const isMobile = user.profile?.isMobile === true;
      const presenceState = user.group === 'offline' ? '离线' : isMobile ? '移动端在线' : '在线';
      const presenceKind = user.group === 'offline' ? 'offline' : isMobile ? 'mobile' : 'online';
      presence.hidden = presenceKind === 'offline';
      if (presence.dataset.presence !== presenceKind) {
        presence.dataset.presence = presenceKind;
        presence.innerHTML = presenceKind === 'mobile' ? '<svg viewBox="0 0 12 19" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true" focusable="false"><rect x="1" y="1" width="10" height="17" rx=".8"/><path d="M4.5 2h3"/></svg>' : '';
      }
      presence.title = presenceState;
      presence.setAttribute('aria-label', presenceState);
      const mic = div.querySelector('.member-microphone');
      mic.hidden = user.group !== 'voice';
      div.querySelector('.member-video').hidden = user.group !== 'voice';
      const microphone = !!(user.voice && (user.voice.memberId === this.ui.localVoice?.memberId ? this.ui.localVoice.microphone : user.voice.microphone ?? user.voice.publishing));
      const micState = user.voice ? microphone ? '麦克风已开启' : '麦克风已关闭' : '未加入语音';
      if (mic.dataset.microphone !== String(microphone)) {
        mic.dataset.microphone = String(microphone);
        mic.innerHTML = microphone
          ? '<svg width="14" height="16" viewBox="0 0 16 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" data-navigation-icon="mic"><rect class="microphone-capsule-on" x="4.8" y="1" width="6.4" height="12.7" rx="3.2" fill="currentColor" stroke="none"/><path class="microphone-support-on" d="M2 9.5v3a6 6 0 0 0 12 0v-3M8 18.5V22M2 22h12"/></svg>'
          : '<svg width="14" height="16" viewBox="0 0 16 24" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" data-navigation-icon="mic-off"><path class="microphone-capsule-off" d="M4.9 10.65V4.1a3.1 3.1 0 0 1 6.2 0v.6Z" fill="currentColor" stroke="none"/><path class="microphone-support-off" d="M2 9v4.5a6 6 0 0 0 .9 3.2M6 19.15a6 6 0 0 0 8-5.65V9M8 19.5V23M2 23h12"/><path class="microphone-slash" d="M1 21 15 3"/></svg>';
      }
      mic.title = micState;
      div.title = `${user.name} · ${presenceState}${user.voice ? ` · ${micState}` : ''}`;
      const existingBadge = info.querySelector('.identity-badge');
      if (user.profile?.authenticated && !existingBadge) {
        info.appendChild(this.ui.profileUI.badge(user.profile));
      } else if (!user.profile?.authenticated && existingBadge) {
        existingBadge.remove();
      }
      if (user.profile) {
        this.ui.profileUI.makeTrigger(div, user.profile);
        // Include the visible avatar initial in the spoken label too, so voice
        // control can match the complete text shown on the member button.
        div.setAttribute('aria-label', `${user.avatar} ${user.name}，${presenceState}${user.voice ? `，${micState}` : ''}，查看资料`);
      } else if (user.name === currentName && !div.dataset.nameChooserBound) {
        div.dataset.nameChooserBound = 'true';
        div.style.cursor = 'pointer';
        div.title = '点击修改你的昵称';
        div.addEventListener('click', () => {
          this.ui.showNameChooser({ mode: 'change', currentName: user.name }, (newName) => {
            if (newName && newName !== user.name) {
              // localStorage set is handled in showNameChooser/submit
              // 通知业务逻辑层
              if (this.ui.onSetUser) {
                this.ui.onSetUser(newName);
              }
            }
          }, this.ui.sekaiPassLoginCallback);
        });
      }
      // Leave unchanged members connected so in-flight avatar loads survive
      // the burst of individual presence events during room initialization.
      groups.get(rosterElement).push(div);
    });
    for (const [container, rows] of groups) {
      let nextElement = container.firstElementChild;
      for (const row of rows) {
        if (row !== nextElement) container.insertBefore(row, nextElement);
        nextElement = row.nextElementSibling;
      }
    }
  }

  /**
   * 添加用户到在线用户列表
   * @param {string} username - 用户名
   */
  addUserToRoster(username, profile) {
    if (!this.ui.managedChat) this.ui.storage?.rememberProfile(profile);
    if (profile?.authenticated && profile.id?.startsWith('sekai:')) this.ui.roomMembers.set(profile.id, profile);
    // Avoid adding duplicate entries for the same username. Server may emit
    // a user:joined after we have locally renamed the user, so skip if
    // username already exists in the roster.
    const index = this.ui.roster.findIndex(u => profile ? u.profile?.id === profile.id : !u.profile && u.name === username);
    const entry = { ...this.ui.generateAvatar(username), profile };
    if (index !== -1) this.ui.roster[index] = entry;
    else this.ui.roster.push(entry);
    if (profile?.id && profile.id === this.ui.currentUser?.id) this.updateNavigationProfile();
    this.ui.renderVoiceUsers();
  }

  /**
   * 平滑处理用户名变更：只替换指定用户的显示，而不清空整个列表
   * @param {string} oldUsername
   * @param {string} newUsername
   */
  handleUserRename(oldUsername, newUsername) {
    if (!oldUsername || !newUsername) return;
    const idx = this.ui.roster.findIndex(u => u.name === oldUsername);
    if (idx !== -1) {
      this.ui.roster[idx] = this.ui.generateAvatar(newUsername);
      this.ui.renderVoiceUsers();
    } else {
      // If not present, just add the new username
      this.addUserToRoster(newUsername);
    }
  }

  /**
   * 从在线用户列表移除用户
   * @param {string} username - 用户名
   */
  removeUserFromRoster(username, userId) {
    // Remove all matching users with the provided username to guard against
    // duplicates and then re-render only if something changed.
    const newRoster = this.ui.roster.filter(user => userId ? user.profile?.id !== userId : user.name !== username);
    if (newRoster.length !== this.ui.roster.length) {
      this.ui.roster = newRoster;
      this.ui.renderVoiceUsers();
    }
  }

  /**
   * 清空在线用户列表
   */
  clearRoster() {
    this.ui.roster = [];
    this.ui.roomMembers.clear();
    this.ui.voiceMembers.clear();
    this.ui.voiceRevision = -1;
    this.ui.localVoice = null;
    this.ui.renderVoiceUsers();
  }

  /**
   * 获取所有已知用户（在线 + 历史消息中的用户）
   * @returns {Array<{name: string, status: 'online'|'offline'}>}
   */
  getAllUsers() {
    const allUsers = new Map();

    // 1. 添加在线用户
    this.ui.roster.forEach(u => {
      allUsers.set(u.profile?.id || `name:${u.name}`, { ...u, status: 'online' });
    });

    if (this.ui.managedChat) {
      for (const profile of this.ui.roomMembers.values()) {
        if (!allUsers.has(profile.id)) allUsers.set(profile.id, { ...this.ui.generateAvatar(profile.displayName), profile, status: 'offline' });
      }
      // Managed membership is authoritative. Old messages must not reinsert
      // hidden or removed members into the mention picker's member lists.
      return Array.from(allUsers.values());
    }

    // Historical names alone cannot identify a recipient. They also include AI
    // speakers and aliases from before identity IDs were stored with messages.
    [...this.ui.messages].reverse().forEach(msg => {
      const key = msg.profile?.id;
      if (!key) return;
      if (msg.user && msg.user !== '系统' && !allUsers.has(key)) {
        const profile = this.ui.storage?.getKnownProfile(msg.profile?.id) || msg.profile;
        const name = profile?.displayName || msg.user;
        const { avatar, color } = this.ui.generateAvatar(name);
        allUsers.set(key, { name, profile, status: 'offline', avatar, color });
      }
    });

    return Array.from(allUsers.values());
  }
}
