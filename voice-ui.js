/* SPDX-License-Identifier: AGPL-3.0-only */
class VoiceUI {
  constructor(manager, eventBus) {
    this.manager = manager;
    this.root = document.querySelector('#voice-panel');
    if (!this.root) return;
    this.status = this.root.querySelector('[data-voice-status]');
    this.members = this.root.querySelector('[data-voice-members]');
    this.join = this.root.querySelector('[data-voice-join]');
    this.mic = this.root.querySelector('[data-voice-mic]');
    this.leave = this.root.querySelector('[data-voice-leave]');
    this.device = this.root.querySelector('[data-voice-device]');
    this.play = this.root.querySelector('[data-voice-play]');
    this.recover = this.root.querySelector('[data-voice-recover]');
    this.join.addEventListener('click', () => { void manager.join(); });
    this.mic.addEventListener('click', () => { void manager.microphone(this.device.value); });
    this.leave.addEventListener('click', () => { void manager.leave(); });
    this.device.addEventListener('change', () => { if (manager.state.microphone) manager.mute(); });
    this.play.addEventListener('click', () => { void manager.enablePlayback(); });
    this.recover.addEventListener('click', () => manager.recover());
    this.unsubscribe = eventBus.on('voice:changed', state => this.render(state));
    this.activityUnsubscribe = eventBus.on('voice:activity', ids => {
      for (const row of this.members.children) {
        const speaking = ids.includes(row.dataset.memberId);
        row.classList.toggle('is-speaking', speaking);
        row.querySelector('[data-speaking]').textContent = speaking ? '正在说话' : row.dataset.state;
      }
    });
  }
  render(state) {
    this.root.hidden = !state.available && !state.joined;
    this.status.textContent = state.message || '语音 · 加入后默认只听';
    this.join.hidden = state.joined; this.join.disabled = state.busy;
    this.join.textContent = state.busy ? '正在加入…' : '加入语音';
    this.mic.hidden = !state.joined; this.leave.hidden = !state.joined && !state.busy;
    this.mic.textContent = this.manager.capturePending ? '取消开启' : state.microphone ? '关闭麦克风' : '开启麦克风';
    this.mic.setAttribute('aria-pressed', String(state.microphone));
    this.play.hidden = !state.playbackBlocked; this.recover.hidden = !state.recoveryNeeded;
    this.root.querySelector('details').hidden = !state.joined;
    this.root.querySelector('summary').textContent = `语音成员 ${state.members.length} / 8`;
    const signature = JSON.stringify(state.members);
    if (signature !== this.signature) {
      this.signature = signature;
      this.members.replaceChildren();
      for (const member of state.members) {
        const row = document.createElement('li'); row.dataset.memberId = member.memberId; row.className = 'voice-member';
        const name = document.createElement('span'); name.className = 'voice-member-name'; name.textContent = member.user.displayName + (member.memberId === state.memberId ? '（你）' : '');
        const status = document.createElement('small'); status.dataset.speaking = ''; row.dataset.state = member.publishing ? '麦克风已开启' : '只听'; status.textContent = row.dataset.state;
        row.append(name, status);
        if (member.memberId !== state.memberId) {
          const label = document.createElement('label'); label.className = 'voice-volume'; label.textContent = '音量';
          const input = document.createElement('input'); input.type = 'range'; input.min = '0'; input.max = '1'; input.step = '.05'; input.value = String(this.manager.volumes.get(member.memberId) ?? 1); input.setAttribute('aria-label', `${member.user.displayName} 的音量`);
          input.addEventListener('input', () => this.manager.setVolume(member.memberId, Number(input.value))); label.append(input); row.append(label);
        }
        this.members.append(row);
      }
    }
    const devices = JSON.stringify(state.devices || []);
    if (devices !== this.devices) {
      this.devices = devices;
      const value = this.device.value;
      this.device.replaceChildren(new Option('系统默认麦克风', ''));
      for (const item of state.devices || []) this.device.add(new Option(item.label || '麦克风', item.deviceId));
      if ([...this.device.options].some(option => option.value === value)) this.device.value = value;
    }
  }
  destroy() { this.unsubscribe?.(); this.activityUnsubscribe?.(); }
}
