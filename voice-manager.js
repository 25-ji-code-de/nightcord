/* SPDX-License-Identifier: AGPL-3.0-only */

// One owner for captures, PeerConnections and asynchronous lifecycle generations.
class VoiceManager {
  constructor({ eventBus, chatRoom, fetch: fetcher = (...args) => fetch(...args), peerFactory = config => new RTCPeerConnection(config), mediaDevices = navigator.mediaDevices } = {}) {
    this.bus = eventBus;
    this.chat = chatRoom;
    this.fetch = fetcher;
    this.peerFactory = peerFactory;
    this.mediaDevices = mediaDevices;
    this.state = { available: false, loginRequired: true, joined: false, busy: false, microphone: false, message: '', members: [], speaking: [] };
    this.generation = 0;
    this.micGeneration = 0;
    this.ticketRequests = new Map();
    this.playbacks = new Map();
    this.volumes = new Map();
    this.unsubscribers = [
      this.bus.on('room:synced', () => { void this.discover(); }),
      this.bus.on('room:joining', () => { void this.leave(); this.state.available = false; this.emit(); }),
      this.bus.on('room:left', () => { void this.leave(); this.state.available = false; this.emit(); }),
      this.bus.on('auth:required', () => { void this.leave(); }),
      this.bus.on('session:updated', ({ user }) => {
        if (this.identity && this.identity !== user.id) void this.leave();
        else if (this.membership) { const membership = this.membership; void this.renew().catch(error => { if (this.membership === membership) this.handleError(error); }); }
      }),
      this.bus.on('voice:ticket', data => {
        const pending = this.ticketRequests.get(data.requestId);
        if (!pending) return;
        clearTimeout(pending.timer); this.ticketRequests.delete(data.requestId);
        if (data.ticket) pending.resolve(data.ticket); else pending.reject(this.error(data.code));
      }),
      this.bus.on('voice:state', ({ snapshot }) => this.applySnapshot(snapshot)),
    ];
    this.onPageHide = () => { void this.leave(); };
    globalThis.addEventListener?.('pagehide', this.onPageHide);
  }
  emit() { this.bus.emit('voice:changed', { ...this.state, memberId: this.membership?.memberId }); }
  error(code = 'voice_unavailable') { return Object.assign(new Error(code), { code }); }
  base(room = this.chat.roomname) { return `https://${this.chat.wsManager.hostname}/api/room/${encodeURIComponent(room)}/voice`; }
  async request(action, input = {}, membership = this.membership, options = {}) {
    if (!membership) throw this.error('membership_expired');
    const response = await this.fetch(`${membership.base}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${membership.token}` },
      body: JSON.stringify(input), cache: 'no-store', signal: AbortSignal.timeout(15000), ...options,
    });
    const value = await response.json();
    if (!response.ok) throw this.error(value.code);
    return value;
  }
  async discover() {
    const room = this.chat.roomname;
    try {
      const response = await this.fetch(`${this.base(room)}/config`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      const value = await response.json();
      if (this.chat.roomname !== room) return;
      this.state.available = response.ok && value.enabled === true && !!this.mediaDevices && typeof RTCPeerConnection !== 'undefined';
      this.state.loginRequired = value.loginRequired !== false;
    } catch { this.state.available = false; }
    this.emit();
  }
  ticket() {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.ticketRequests.delete(requestId); reject(this.error('ticket_timeout')); }, 10000);
      this.ticketRequests.set(requestId, { resolve, reject, timer });
      if (!this.chat.wsManager.send({ type: 'voice:ticket', requestId })) {
        clearTimeout(timer); this.ticketRequests.delete(requestId); reject(this.error('chat_unavailable'));
      }
    });
  }
  async join() {
    if (this.state.busy || this.membership) return;
    if (!this.chat.currentUser) { this.state.message = '请等待文字聊天连接就绪后再加入语音。'; this.emit(); return; }
    if (this.state.loginRequired && !this.chat.currentUser.authenticated) { this.state.message = '请先使用 SEKAI Pass 登录，再加入语音。'; this.emit(); return; }
    const generation = ++this.generation;
    const credential = { base: this.base(), token: Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join('') };
    this.identity = this.chat.currentUser.id;
    this.state.busy = true; this.state.message = '正在加入语音…'; this.emit();
    try {
      const ticket = await this.ticket();
      if (generation !== this.generation) return;
      const input = { ticket, clientId: crypto.randomUUID(), joinRequestId: crypto.randomUUID() };
      let result;
      // Retrying the same join uses the same browser capability and request ID.
      for (let attempt = 0; attempt < 2; attempt++) {
        try { result = await this.request('join', input, credential); break; }
        catch (error) { if (attempt || error.code) throw error; }
      }
      if (generation !== this.generation) { void this.request('leave', {}, credential).catch(() => {}); return; }
      this.membership = { ...credential, ...result };
      this.state.joined = true; this.state.message = '已加入 · 麦克风关闭';
      this.appliedRevision = -1; this.receiverSignature = ''; this.receiverFailures = 0;
      this.applySnapshot(result.snapshot);
      this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, 20000);
      this.statsTimer = setInterval(() => { void this.sampleActivity(); }, 1000);
    } catch (error) {
      // A lost join response may still have created membership; always attempt leave.
      void this.request('leave', {}, credential).catch(() => {});
      if (generation === this.generation) this.handleError(error);
    } finally { if (generation === this.generation) { this.state.busy = false; this.emit(); } }
  }
  async renew() {
    const membership = this.membership;
    if (!membership || this.renewing) return;
    this.renewing = true;
    try {
      const ticket = await this.ticket();
      if (this.membership !== membership) return;
      const value = await this.request('renew', { ticket }, membership);
      if (this.membership === membership) Object.assign(membership, { authUntil: value.authUntil, expiresAt: value.expiresAt });
    } finally { this.renewing = false; }
  }
  async heartbeat() {
    const membership = this.membership;
    if (!membership || this.heartbeating) return;
    this.heartbeating = true;
    try {
      const value = await this.request('heartbeat', {}, membership);
      if (this.membership !== membership) return;
      Object.assign(membership, { authUntil: value.authUntil, expiresAt: value.expiresAt });
      this.applySnapshot(value.snapshot);
      if (!this.state.microphone && this.state.message.startsWith('网络')) this.state.message = '已加入 · 麦克风关闭';
      this.emit();
    } catch (error) {
      if (this.membership !== membership) return;
      if (['membership_expired', 'voice_disabled', 'invalid_token', 'login_required'].includes(error.code) || Date.now() >= Math.min(membership.authUntil, membership.expiresAt)) {
        await this.leave(); this.handleError(error);
      } else { this.state.message = '网络暂时中断，正在恢复语音连接…'; this.emit(); }
    } finally { this.heartbeating = false; }
  }
  applySnapshot(snapshot) {
    if (!this.membership || !snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < this.appliedRevision || !Array.isArray(snapshot.members)) return;
    this.appliedRevision = snapshot.revision; this.state.members = snapshot.members;
    if (!snapshot.members.some(member => member.memberId === this.membership.memberId)) { void this.leave(); return; }
    this.emit(); void this.reconcile();
  }
  async ice(membership) {
    if (this.iceConfig && this.iceConfig.iceExpiresAt > Date.now() + 600000) return this.iceConfig;
    if (this.icePending?.membership === membership) return this.icePending.promise;
    const pending = { membership, promise: this.fetchIce(membership) };
    this.icePending = pending;
    try { return await pending.promise; }
    finally { if (this.icePending === pending) this.icePending = null; }
  }
  async fetchIce(membership) {
    const value = await this.request('ice', {}, membership);
    if (!Array.isArray(value.iceServers)) throw this.error('voice_unavailable');
    if (this.membership === membership) {
      this.iceConfig = value;
      this.publisher?.setConfiguration({ iceServers: value.iceServers });
      this.receiver?.setConfiguration({ iceServers: value.iceServers });
      clearTimeout(this.iceTimer);
      this.iceTimer = setTimeout(() => { if (this.membership === membership) void this.ice(membership).catch(error => { if (this.membership === membership) this.handleError(error); }); }, 3000000);
    }
    return value;
  }
  async gather(pc, timeoutMs = 8000) {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise((resolve, reject) => {
      // Some unreachable STUN/TURN alternatives keep gathering open. A complete
      // local description with candidates is still usable without trickle ICE.
      const timer = setTimeout(() => done(/^a=candidate:/m.test(pc.localDescription?.sdp || '') ? undefined : this.error('ice_timeout')), timeoutMs);
      const check = () => { if (pc.iceGatheringState === 'complete') done(); else if (pc.signalingState === 'closed') done(this.error('connection_closed')); };
      const done = error => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); pc.removeEventListener('signalingstatechange', check); error ? reject(error) : resolve(); };
      pc.addEventListener('icegatheringstatechange', check); pc.addEventListener('signalingstatechange', check); check();
    });
  }
  async connected(pc) {
    if (pc.connectionState === 'connected') return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(this.error('connection_timeout')), 10000);
      const check = () => { if (pc.connectionState === 'connected') done(); else if (['failed', 'closed'].includes(pc.connectionState)) done(this.error('connection_failed')); };
      const done = error => { clearTimeout(timer); pc.removeEventListener('connectionstatechange', check); error ? reject(error) : resolve(); };
      pc.addEventListener('connectionstatechange', check); check();
    });
  }
  desired() { return this.state.members.filter(member => member.memberId !== this.membership?.memberId && member.publishing); }
  async reconcile() {
    if (this.reconciling || !this.membership) return;
    this.reconciling = true;
    const membership = this.membership;
    try {
      while (this.membership === membership) {
        const peers = this.desired();
        const signature = peers.map(peer => `${peer.memberId}:${peer.publicationVersion}`).sort().join(',');
        if (signature === this.receiverSignature) break;
        this.closeReceiver();
        const ice = await this.ice(membership);
        if (this.membership !== membership) break;
        const result = await this.request('subscriptions', { memberIds: peers.map(peer => peer.memberId), mutationId: crypto.randomUUID() }, membership);
        if (this.membership !== membership) break;
        if (!result.empty) {
          const pc = this.peerFactory({ iceServers: ice.iceServers }); this.receiver = pc;
          const mapping = new Map(result.tracks.map(track => [track.mid, track.memberId]));
          pc.addEventListener('track', event => {
            if (this.receiver !== pc || this.membership !== membership) return;
            const memberId = mapping.get(event.transceiver.mid);
            if (!memberId) return;
            const audio = document.createElement('audio'); audio.autoplay = true;
            audio.volume = this.volumes.get(memberId) ?? 1;
            audio.srcObject = new MediaStream([event.track]);
            this.playbacks.get(memberId)?.audio.remove();
            this.playbacks.set(memberId, { audio, mid: event.transceiver.mid });
            document.querySelector('#voice-audio')?.append(audio);
            void audio.play().catch(() => { this.state.playbackBlocked = true; this.emit(); });
          });
          await pc.setRemoteDescription(result.sessionDescription);
          await pc.setLocalDescription(await pc.createAnswer()); await this.gather(pc);
          if (this.receiver !== pc || this.membership !== membership) break;
          await this.request('renegotiate', { operationId: result.operationId, generation: result.generation, sessionDescription: pc.localDescription, mutationId: crypto.randomUUID() }, membership);
          await this.connected(pc);
          pc.addEventListener('connectionstatechange', () => {
            if (this.receiver !== pc || this.membership !== membership) return;
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') this.retryReceiver();
          });
        }
        this.receiverSignature = signature; this.receiverFailures = 0; this.state.recoveryNeeded = false; this.emit();
      }
    } catch (error) {
      if (this.membership === membership) { this.handleError(error); this.retryReceiver(); }
    } finally { this.reconciling = false; if (this.membership && this.membership !== membership) void this.reconcile(); }
  }
  retryReceiver() {
    clearTimeout(this.receiverTimer);
    if (!this.membership) return;
    this.receiverSignature = null;
    if (++this.receiverFailures > 3) { this.state.message = '语音接收中断，请点击恢复连接。'; this.state.recoveryNeeded = true; this.emit(); return; }
    this.receiverTimer = setTimeout(() => { void this.reconcile(); }, 1000 * 2 ** (this.receiverFailures - 1) + Math.random() * 300);
  }
  recover() { this.receiverFailures = 0; this.state.recoveryNeeded = false; this.receiverSignature = null; void this.reconcile(); this.emit(); }
  async microphone(deviceId = '') {
    if (this.publisher || this.capturePending) { this.mute(); return; }
    const membership = this.membership;
    if (!membership) return;
    const generation = ++this.micGeneration;
    const attempt = { membership, operationId: crypto.randomUUID() };
    this.publisherAttempt = attempt;
    this.capturePending = true; this.state.message = '正在开启麦克风…'; this.emit();
    let stream, pc;
    try {
      // Keep the permission request inside the user's click, before network awaits.
      stream = await this.mediaDevices.getUserMedia({ video: false, audio: { channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) } });
      if (generation !== this.micGeneration || this.membership !== membership) { stream.getTracks().forEach(track => track.stop()); return; }
      this.capture = stream;
      const ice = await this.ice(membership);
      if (generation !== this.micGeneration || this.membership !== membership) return;
      pc = this.peerFactory({ iceServers: ice.iceServers }); this.publisher = pc;
      const transceiver = pc.addTransceiver(stream.getAudioTracks()[0], { direction: 'sendonly' });
      const opus = globalThis.RTCRtpSender?.getCapabilities?.('audio')?.codecs.filter(codec => codec.mimeType.toLowerCase() === 'audio/opus');
      if (opus?.length && transceiver.setCodecPreferences) transceiver.setCodecPreferences(opus);
      const params = transceiver.sender.getParameters();
      if (params.encodings?.length) { params.encodings[0].maxBitrate = 40000; await transceiver.sender.setParameters(params).catch(() => {}); }
      await pc.setLocalDescription(await pc.createOffer()); await this.gather(pc);
      if (generation !== this.micGeneration || this.membership !== membership) return;
      const result = await this.request('publisher/start', { sessionDescription: pc.localDescription, mid: transceiver.mid, mutationId: attempt.operationId }, membership);
      if (generation !== this.micGeneration || this.membership !== membership) { void this.stopPublisher(attempt); return; }
      await pc.setRemoteDescription(result.sessionDescription); await this.connected(pc);
      await this.request('publisher/ready', { operationId: result.operationId, generation: result.generation, mutationId: crypto.randomUUID() }, membership);
      if (generation !== this.micGeneration || this.membership !== membership) { void this.stopPublisher(attempt); return; }
      this.state.microphone = true; this.state.message = '麦克风已开启';
      stream.getAudioTracks()[0].addEventListener('ended', () => { if (this.capture === stream) { this.mute(); this.state.message = '麦克风已断开，请检查设备后重新开启。'; this.emit(); } });
      pc.addEventListener('connectionstatechange', () => { if (this.publisher === pc && ['failed', 'disconnected'].includes(pc.connectionState)) { this.mute(); this.state.message = '麦克风连接中断，请重新开启。'; this.emit(); } });
      const devices = await this.mediaDevices.enumerateDevices();
      if (generation === this.micGeneration && this.membership === membership) this.state.devices = devices.filter(device => device.kind === 'audioinput').map(device => ({ deviceId: device.deviceId, label: device.label }));
    } catch (error) {
      if (generation === this.micGeneration && this.membership === membership) { this.mute(); this.handleError(error); }
    } finally {
      if (generation !== this.micGeneration || this.membership !== membership) { stream?.getTracks().forEach(track => track.stop()); pc?.close(); }
      if (generation === this.micGeneration) this.capturePending = false;
      this.emit();
    }
  }
  async stopPublisher({ membership, operationId }) {
    const mutationId = crypto.randomUUID();
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await this.request('publisher/stop', { mutationId, operationId }, membership); return; }
      catch { if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 600 * (attempt + 1))); }
    }
  }
  mute() {
    ++this.micGeneration; this.capturePending = false;
    this.capture?.getTracks().forEach(track => { track.enabled = false; track.stop(); }); this.capture = null;
    this.publisher?.close(); this.publisher = null;
    this.state.microphone = false; this.state.message = '已加入 · 麦克风关闭'; this.emit();
    if (this.publisherAttempt) { void this.stopPublisher(this.publisherAttempt); this.publisherAttempt = null; }
  }
  setVolume(memberId, volume) { const value = Math.max(0, Math.min(1, volume)); this.volumes.set(memberId, value); const player = this.playbacks.get(memberId); if (player) player.audio.volume = value; }
  async enablePlayback() {
    try { await Promise.all([...this.playbacks.values()].map(({ audio }) => audio.play())); this.state.playbackBlocked = false; }
    catch { this.state.playbackBlocked = true; }
    this.emit();
  }
  async sampleActivity() {
    if (document.hidden || this.sampling) return;
    this.sampling = true;
    const generation = this.generation;
    try {
      const speaking = new Set();
      for (const [pc, own] of [[this.publisher, true], [this.receiver, false]]) {
        if (!pc || pc.connectionState !== 'connected') continue;
        const stats = await pc.getStats();
        for (const stat of stats.values()) if (stat.kind === 'audio' && stat.audioLevel > 0.02) {
          if (own && stat.type === 'media-source') speaking.add(this.membership?.memberId);
          if (!own && stat.type === 'inbound-rtp') for (const [memberId, player] of this.playbacks) if (player.mid === stat.mid) speaking.add(memberId);
        }
      }
      if (generation === this.generation) { this.state.speaking = [...speaking].filter(Boolean); this.bus.emit('voice:activity', this.state.speaking); }
    } catch { /* Closed connections and missing optional stats need no toast. */ }
    finally { this.sampling = false; }
  }
  closeReceiver() {
    this.receiver?.close(); this.receiver = null;
    for (const { audio } of this.playbacks.values()) { audio.pause(); audio.srcObject = null; audio.remove(); }
    this.playbacks.clear();
  }
  async leave() {
    const membership = this.membership; this.membership = null;
    ++this.generation; ++this.micGeneration;
    clearInterval(this.heartbeatTimer); clearInterval(this.statsTimer); clearTimeout(this.iceTimer); clearTimeout(this.receiverTimer);
    this.capture?.getTracks().forEach(track => track.stop()); this.capture = null;
    this.publisher?.close(); this.publisher = null; this.capturePending = false; this.publisherAttempt = null;
    this.closeReceiver(); this.iceConfig = null;
    this.volumes.clear();
    this.state = { ...this.state, joined: false, busy: false, microphone: false, message: '', members: [], speaking: [], recoveryNeeded: false, playbackBlocked: false };
    this.emit();
    if (membership) {
      try { await this.request('leave', {}, membership, { keepalive: true }); }
      catch { /* Server-side expiry and alarms remain responsible for abandoned tabs. */ }
    }
  }
  handleError(error) {
    const messages = {
      login_required: '请先使用 SEKAI Pass 登录。', voice_disabled: '此房间的语音尚未开放。', room_full: '语音房已满，最多 8 人。',
      voice_in_use: '你的账号已在此房间的另一窗口加入语音，请先退出。', membership_expired: '语音身份已过期，请重新加入。',
      rate_limited: '操作太快，请稍后再试。', chat_unavailable: '请等待文字聊天连接恢复后重试。',
      NotAllowedError: '未获得麦克风权限，你仍可以收听。', NotFoundError: '未找到麦克风，你仍可以收听。',
      NotReadableError: '麦克风被占用或暂时不可用，请检查设备。', cleanup_pending: '正在关闭旧连接，请稍后恢复连接。',
    };
    this.state.message = messages[error.code || error.name] || '语音连接未完成，请检查网络后重试。'; this.emit();
  }
  destroy() { void this.leave(); this.unsubscribers.forEach(unsubscribe => unsubscribe()); globalThis.removeEventListener?.('pagehide', this.onPageHide); }
}
