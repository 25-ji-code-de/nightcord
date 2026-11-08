/* SPDX-License-Identifier: AGPL-3.0-only */
class VoiceUI {
  constructor(manager, eventBus) {
    this.manager = manager;
    this.root = document.querySelector('#voice-panel');
    if (!this.root) return;
    this.toolbar = document.querySelector('[data-voice-toolbar]');
    this.toggle = this.toolbar.querySelector('[data-voice-toggle]');
    this.label = this.toolbar.querySelector('[data-voice-label]');
    this.count = this.toolbar.querySelector('[data-voice-count]');
    this.quickMic = this.toolbar.querySelector('[data-voice-quick-mic]');
    this.status = this.root.querySelector('[data-voice-status]');
    this.menuStatus = this.root.querySelector('[data-voice-menu-status]');
    this.roomHeading = this.root.querySelector('[data-voice-room-title]');
    this.menuHeading = this.root.querySelector('[data-voice-screen-title]');
    this.callScreen = this.root.querySelector('[data-voice-layer="call"]');
    this.menuScreen = this.root.querySelector('[data-voice-layer="menu"]');
    this.title = this.roomHeading;
    this.memberCount = this.root.querySelector('[data-voice-member-count]');
    this.members = this.root.querySelector('[data-voice-members]');
    this.idle = this.root.querySelector('[data-voice-idle]');
    this.join = this.root.querySelector('[data-voice-join]');
    this.mic = this.root.querySelector('[data-voice-mic]');
    this.leave = this.root.querySelector('[data-voice-leave]');
    this.device = this.root.querySelector('[data-voice-device]');
    this.settings = this.root.querySelector('[data-voice-settings]');
    this.back = this.root.querySelector('[data-voice-back]');
    this.volume = this.root.querySelector('[data-voice-volume]');
    this.volumeOutput = this.root.querySelector('[data-voice-volume-output]');
    this.play = this.root.querySelector('[data-voice-play]');
    this.recover = this.root.querySelector('[data-voice-recover]');
    this.pages = [...this.root.querySelectorAll('[data-voice-view]')];
    this.view = 'call';
    this.menuView = 'device';
    this.controller = new AbortController();
    const options = { signal: this.controller.signal };
    this.join.addEventListener('click', () => { void manager.join(); }, options);
    for (const button of [this.mic, this.quickMic]) {
      button.addEventListener('click', () => { void manager.microphone(this.device.value); }, options);
    }
    this.leave.addEventListener('click', () => { void manager.leave(); }, options);
    this.device.addEventListener('change', () => {
      if (manager.state.microphone || manager.capturePending) manager.mute();
    }, options);
    this.play.addEventListener('click', () => { void manager.enablePlayback(); }, options);
    this.recover.addEventListener('click', () => manager.recover(), options);
    // Pointer navigation focuses the display heading; keyboard navigation starts at its control.
    this.settings.addEventListener('click', event => {
      this.showView('device');
      (event.detail === 0 ? this.device : this.title).focus({ preventScroll: true });
    }, options);
    this.back.addEventListener('click', event => this.returnToCall(event.detail === 0), options);
    this.members.addEventListener('click', event => {
      const button = event.target.closest('[data-voice-member]');
      if (!button) return;
      this.selectedMember = button.dataset.voiceMember;
      this.showView('member');
      (event.detail === 0 ? this.volume : this.title).focus({ preventScroll: true });
    }, options);
    this.volume.addEventListener('input', () => {
      if (!this.selectedMember) return;
      manager.setVolume(this.selectedMember, Number(this.volume.value));
      this.renderVolume();
    }, options);
    this.root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.view !== 'call') {
        event.preventDefault(); event.stopPropagation(); this.returnToCall();
      }
    }, options);
    this.root.addEventListener('beforetoggle', event => {
      if (event.newState === 'open') { this.positionPanel(); this.showView('call'); }
    }, options);
    this.root.addEventListener('toggle', () => {
      const open = this.root.matches(':popover-open');
      this.toggle.setAttribute('aria-expanded', String(open));
      if (!open) { this.selectedMember = null; this.showView('call'); }
    }, options);
    window.addEventListener('resize', () => {
      if (this.root.matches(':popover-open')) this.positionPanel();
    }, options);
    document.addEventListener('focusin', event => {
      if (!this.toolbar.contains(event.target)) this.closePanel();
    }, options);
    this.unsubscribe = eventBus.on('voice:changed', state => this.render(state));
    this.activityUnsubscribe = eventBus.on('voice:activity', ids => this.renderActivity(ids));
    this.render(manager.state);
  }
  positionPanel() {
    const anchor = this.toggle.getBoundingClientRect();
    const width = parseFloat(getComputedStyle(this.root).width);
    const top = anchor.bottom + 8;
    this.root.style.setProperty('--voice-panel-top', `${top}px`);
    this.root.style.setProperty('--voice-panel-left', `${Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12))}px`);
    this.root.style.setProperty('--voice-panel-height', `${Math.max(0, window.innerHeight - top - 12)}px`);
  }
  closePanel() {
    if (!this.root.matches(':popover-open')) return;
    const restoreFocus = this.root.contains(document.activeElement);
    this.root.hidePopover();
    if (restoreFocus && !this.toolbar.hidden) this.toggle.focus({ preventScroll: true });
  }
  roomTitle() {
    const room = this.manager.chat?.roomname;
    if (room === 'nightcord-test') return '测试房间';
    if (!room || room === 'nightcord-default') return '聊天';
    return room.length === 64 ? '私人房间' : room;
  }
  showView(view) {
    const member = this.state?.members.find(item => item.memberId === this.selectedMember);
    this.view = view === 'member' && !member ? 'call' : view;
    const inMenu = this.view !== 'call';
    if (inMenu) this.menuView = this.view;
    this.menuStatus.parentElement.hidden = this.menuView === 'device';
    this.root.dataset.voiceScreen = this.view;
    // Keep the covered page and outgoing menu painted throughout the slide.
    for (const page of this.pages) page.hidden = !['call', this.menuView].includes(page.dataset.voiceView);
    this.callScreen.inert = inMenu; this.callScreen.setAttribute('aria-hidden', String(inMenu));
    this.menuScreen.inert = !inMenu; this.menuScreen.setAttribute('aria-hidden', String(!inMenu));
    this.memberCount.hidden = !this.state?.joined;
    this.roomHeading.textContent = this.roomTitle(); this.roomHeading.title = this.roomHeading.textContent;
    if (inMenu) {
      this.menuHeading.textContent = this.view === 'member' ? member.user.displayName : '输入设备';
      this.menuHeading.title = this.menuHeading.textContent;
    }
    this.title = inMenu ? this.menuHeading : this.roomHeading;
    if (this.view === 'member') {
      this.volume.value = String(this.manager.volumes.get(this.selectedMember) ?? 1);
      this.volume.setAttribute('aria-label', `${member.user.displayName} 的收听音量`);
      this.renderVolume();
    }
  }
  returnToCall(focusTrigger = true) {
    const previousMember = this.selectedMember;
    this.showView('call'); this.selectedMember = null;
    const trigger = [...this.members.querySelectorAll('[data-voice-member]')].find(node => node.dataset.voiceMember === previousMember);
    (focusTrigger ? trigger || this.settings : this.title).focus({ preventScroll: true });
  }
  renderVolume() {
    const value = `${Math.round(Number(this.volume.value) * 100)}%`;
    this.volume.style.setProperty('--voice-volume-level', value);
    this.volume.setAttribute('aria-valuetext', value);
    this.volumeOutput.textContent = value;
  }
  renderActivity(ids = []) {
    for (const row of this.members.children) {
      const speaking = ids.includes(row.dataset.memberId);
      row.classList.toggle('is-speaking', speaking);
      row.querySelector('[data-speaking]').textContent = speaking ? '正在说话' : row.dataset.state;
    }
  }
  memberAvatar(user) {
    const avatar = document.createElement('span');
    avatar.className = 'voice-member-avatar'; avatar.setAttribute('aria-hidden', 'true');
    const initial = Array.from(user.displayName)[0]?.toUpperCase() || '?';
    avatar.textContent = initial;
    let hash = 2166136261;
    for (const character of user.id || user.displayName) hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
    const tint = (hash >>> 0) % 8 + 1;
    avatar.style.setProperty('--voice-avatar-tint', `var(--sekai-identity-${tint})`);
    avatar.style.setProperty('--voice-avatar-ink', `var(--sekai-identity-${tint}-ink)`);
    try {
      const url = new URL(user.avatarUrl);
      if (url.protocol === 'https:' && !url.username && !url.password) {
        const image = document.createElement('img');
        image.alt = ''; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => { if (image.parentNode === avatar) avatar.textContent = initial; }, { once: true });
        image.src = url.href; avatar.replaceChildren(image);
      }
    } catch { /* Keep the identity label when no usable avatar is available. */ }
    return avatar;
  }
  renderMembers(state) {
    const signature = JSON.stringify([state.memberId, state.microphone, state.members]);
    if (signature === this.signature) return;
    this.signature = signature;
    const focusedMember = this.members.contains(document.activeElement) ? document.activeElement.dataset.voiceMember : null;
    const scroll = this.members.scrollTop;
    this.members.replaceChildren();
    for (const member of state.members) {
      const self = member.memberId === state.memberId;
      const row = document.createElement('li'); row.dataset.memberId = member.memberId; row.className = 'voice-member';
      const line = document.createElement(self ? 'div' : 'button'); line.className = 'voice-member-line';
      const info = document.createElement('span'); info.className = 'voice-member-info';
      const name = document.createElement('span'); name.className = 'voice-member-name'; name.textContent = member.user.displayName + (self ? '（您）' : ''); name.title = name.textContent;
      const status = document.createElement('small'); status.dataset.speaking = ''; row.dataset.state = (self ? state.microphone : member.microphone ?? member.publishing) ? '麦克风已开启' : '仅收听模式'; status.textContent = row.dataset.state;
      info.append(name, status); line.append(this.memberAvatar(member.user), info);
      if (!self) {
        line.type = 'button'; line.dataset.voiceMember = member.memberId;
        line.setAttribute('aria-label', `${member.user.displayName}，调整收听音量`);
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '1.75'); icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round'); icon.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'm9 6 6 6-6 6'); icon.append(path); line.append(icon);
      }
      row.append(line); this.members.append(row);
    }
    this.members.scrollTop = scroll;
    if (focusedMember) {
      const replacement = [...this.members.querySelectorAll('[data-voice-member]')].find(node => node.dataset.voiceMember === focusedMember);
      (replacement || this.settings).focus({ preventScroll: true });
    }
  }
  render(state) {
    this.state = state;
    const focusConnectingControl = state.busy && !state.joined && this.join === document.activeElement;
    const focusJoinedControl = state.joined && !this.wasJoined && [this.join, this.leave].includes(document.activeElement);
    const visible = state.available || state.joined || state.busy;
    if (!visible) this.closePanel();
    this.toolbar.hidden = !visible;
    const normalMessages = ['', '已加入 · 麦克风已关闭', '麦克风已开启', '正在启用麦克风……', '正在加入语音会话……'];
    const messageNeedsAttention = state.message && !normalMessages.includes(state.message);
    const attention = !!(state.playbackBlocked || state.recoveryNeeded || messageNeedsAttention);
    this.toolbar.classList.toggle('is-joined', state.joined);
    this.toolbar.classList.toggle('needs-attention', attention);
    this.label.textContent = attention ? '需要操作' : state.busy ? '接通中' : state.joined ? state.microphone ? '语音会话中' : '仅收听模式' : '语音';
    this.count.hidden = !state.joined; this.count.textContent = state.members.length;
    this.toggle.setAttribute('aria-label', attention ? '语音功能需要您的关注；请打开语音面板' : state.joined ? `房间语音，${state.members.length} 人，${state.microphone ? '麦克风已开启' : '仅收听模式'}；请打开语音面板` : '打开房间语音面板');
    this.status.textContent = messageNeedsAttention ? state.message : state.playbackBlocked ? '尚未启用音频' : state.busy ? '正在接通……' : this.manager.capturePending ? '正在启用麦克风……' : state.joined ? state.microphone ? '已接通 · 麦克风已开启' : '已接通 · 麦克风已静音' : '等待接入';
    this.menuStatus.textContent = this.status.textContent;
    this.join.hidden = state.joined || state.busy;
    this.mic.disabled = !state.joined; this.quickMic.hidden = !state.joined;
    this.leave.hidden = !state.joined && !state.busy;
    const leaveLabel = state.busy && !state.joined ? '取消接入' : '结束通话';
    this.leave.querySelector('[data-voice-leave-label]').textContent = leaveLabel;
    this.leave.setAttribute('aria-label', leaveLabel); this.leave.title = leaveLabel;
    const micLabel = this.manager.capturePending ? '取消启用麦克风' : state.microphone ? '静音麦克风' : '取消静音麦克风';
    for (const button of [this.mic, this.quickMic]) {
      button.setAttribute('aria-pressed', String(state.microphone));
      button.setAttribute('aria-label', micLabel); button.title = micLabel;
    }
    this.play.hidden = !state.playbackBlocked; this.recover.hidden = !state.recoveryNeeded;
    this.root.querySelector('[data-voice-notices]').hidden = !state.playbackBlocked && !state.recoveryNeeded;
    this.idle.hidden = state.joined; this.members.hidden = !state.joined;
    this.memberCount.textContent = `${state.members.length} 人`;
    const menuLostMember = this.view === 'member' && !state.members.some(member => member.memberId === this.selectedMember);
    this.renderMembers(state); this.renderActivity(state.speaking);
    if (menuLostMember) {
      const restoreFocus = this.volume === document.activeElement;
      this.selectedMember = null; this.showView('call');
      if (restoreFocus) this.settings.focus({ preventScroll: true });
    } else this.showView(this.view);
    const devices = JSON.stringify(state.devices || []);
    if (devices !== this.devices) {
      this.devices = devices;
      const value = this.device.value;
      this.device.replaceChildren(new Option('系统默认麦克风', ''));
      for (const item of state.devices || []) this.device.add(new Option(item.label || '麦克风', item.deviceId));
      if ([...this.device.options].some(option => option.value === value)) this.device.value = value;
    }
    if (this.root.matches(':popover-open')) {
      if (focusConnectingControl) this.leave.focus({ preventScroll: true });
      if (focusJoinedControl) this.mic.focus({ preventScroll: true });
    }
    if (!state.joined && this.wasJoined && this.root.matches(':popover-open')) {
      this.selectedMember = null; this.showView('call'); this.join.focus({ preventScroll: true });
    }
    this.wasJoined = state.joined;
  }
  destroy() {
    this.closePanel(); this.controller?.abort();
    this.unsubscribe?.(); this.activityUnsubscribe?.();
  }
}
