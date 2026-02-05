/**
 * WebRTCManager - WebRTC 单个对等连接管理器
 * 负责管理单个 RTCPeerConnection 实例的生命周期
 *
 * @example
 * const rtcManager = new WebRTCManager({
 *   remoteUsername: 'K',
 *   localStream: audioStream,
 *   onIceCandidate: (candidate) => sendToSignaling(candidate),
 *   onTrack: (stream) => playAudio(stream),
 *   onConnectionStateChange: (state) => updateUI(state)
 * });
 *
 * const offer = await rtcManager.createOffer();
 * await rtcManager.handleAnswer(answer);
 * rtcManager.addIceCandidate(candidate);
 * rtcManager.close();
 */
class WebRTCManager {
  /**
   * 创建 WebRTC 管理器实例
   * @param {Object} config - 配置对象
   * @param {string} config.remoteUsername - 远程用户名
   * @param {MediaStream} config.localStream - 本地音频流
   * @param {Function} [config.onIceCandidate] - ICE 候选生成回调
   * @param {Function} [config.onTrack] - 接收远程轨道回调
   * @param {Function} [config.onConnectionStateChange] - 连接状态变化回调
   * @param {Function} [config.onIceConnectionStateChange] - ICE 连接状态变化回调
   */
  constructor(config = {}) {
    this.remoteUsername = config.remoteUsername;
    this.localStream = config.localStream;

    // Callbacks
    this.onIceCandidate = config.onIceCandidate || (() => {});
    this.onTrack = config.onTrack || (() => {});
    this.onConnectionStateChange = config.onConnectionStateChange || (() => {});
    this.onIceConnectionStateChange = config.onIceConnectionStateChange || (() => {});

    // Free STUN servers for NAT traversal
    this.iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' }
    ];

    this.peerConnection = null;
    this.remoteStream = new MediaStream();

    this._initPeerConnection();
  }

  /**
   * 初始化 RTCPeerConnection
   * @private
   */
  _initPeerConnection() {
    const config = {
      iceServers: this.iceServers
    };

    this.peerConnection = new RTCPeerConnection(config);

    // Add local stream tracks to peer connection
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        this.peerConnection.addTrack(track, this.localStream);
      });
    }

    // Handle ICE candidates
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.onIceCandidate(event.candidate);
      }
    };

    // Handle remote tracks
    this.peerConnection.ontrack = (event) => {
      event.streams[0].getTracks().forEach(track => {
        this.remoteStream.addTrack(track);
      });
      this.onTrack(this.remoteStream);
    };

    // Monitor connection state
    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection.connectionState;
      console.log(`[WebRTC] Connection state with ${this.remoteUsername}:`, state);
      this.onConnectionStateChange(state);

      // Auto-cleanup on failed/closed connections
      if (state === 'failed' || state === 'closed') {
        this.close();
      }
    };

    // Monitor ICE connection state
    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection.iceConnectionState;
      console.log(`[WebRTC] ICE connection state with ${this.remoteUsername}:`, state);
      this.onIceConnectionStateChange(state);
    };
  }

  /**
   * 创建 SDP offer
   * @returns {Promise<RTCSessionDescriptionInit>} SDP offer
   */
  async createOffer() {
    try {
      const offer = await this.peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false
      });
      await this.peerConnection.setLocalDescription(offer);
      return offer;
    } catch (error) {
      console.error(`[WebRTC] Error creating offer for ${this.remoteUsername}:`, error);
      throw error;
    }
  }

  /**
   * 创建 SDP answer
   * @returns {Promise<RTCSessionDescriptionInit>} SDP answer
   */
  async createAnswer() {
    try {
      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);
      return answer;
    } catch (error) {
      console.error(`[WebRTC] Error creating answer for ${this.remoteUsername}:`, error);
      throw error;
    }
  }

  /**
   * 处理远程 SDP offer
   * @param {RTCSessionDescriptionInit} offer - 远程 SDP offer
   * @returns {Promise<void>}
   */
  async handleOffer(offer) {
    try {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    } catch (error) {
      console.error(`[WebRTC] Error handling offer from ${this.remoteUsername}:`, error);
      throw error;
    }
  }

  /**
   * 处理远程 SDP answer
   * @param {RTCSessionDescriptionInit} answer - 远程 SDP answer
   * @returns {Promise<void>}
   */
  async handleAnswer(answer) {
    try {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (error) {
      console.error(`[WebRTC] Error handling answer from ${this.remoteUsername}:`, error);
      throw error;
    }
  }

  /**
   * 添加 ICE candidate
   * @param {RTCIceCandidateInit} candidate - ICE candidate
   * @returns {Promise<void>}
   */
  async addIceCandidate(candidate) {
    try {
      if (candidate) {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      }
    } catch (error) {
      console.error(`[WebRTC] Error adding ICE candidate from ${this.remoteUsername}:`, error);
      throw error;
    }
  }

  /**
   * 获取连接状态
   * @returns {string} 连接状态
   */
  getConnectionState() {
    return this.peerConnection ? this.peerConnection.connectionState : 'closed';
  }

  /**
   * 获取 ICE 连接状态
   * @returns {string} ICE 连接状态
   */
  getIceConnectionState() {
    return this.peerConnection ? this.peerConnection.iceConnectionState : 'closed';
  }

  /**
   * 获取连接统计信息
   * @returns {Promise<Object>} 统计信息对象
   */
  async getStats() {
    if (!this.peerConnection) {
      return null;
    }

    try {
      const stats = await this.peerConnection.getStats();
      const statsReport = {};

      stats.forEach(report => {
        if (report.type === 'inbound-rtp' || report.type === 'outbound-rtp') {
          statsReport[report.type] = {
            bytesReceived: report.bytesReceived,
            bytesSent: report.bytesSent,
            packetsReceived: report.packetsReceived,
            packetsSent: report.packetsSent,
            packetsLost: report.packetsLost
          };
        }
      });

      return statsReport;
    } catch (error) {
      console.error(`[WebRTC] Error getting stats for ${this.remoteUsername}:`, error);
      return null;
    }
  }

  /**
   * 更新本地音频流
   * @param {MediaStream} newStream - 新的音频流
   */
  updateLocalStream(newStream) {
    if (!this.peerConnection) return;

    // Remove old tracks
    const senders = this.peerConnection.getSenders();
    senders.forEach(sender => {
      this.peerConnection.removeTrack(sender);
    });

    // Add new tracks
    if (newStream) {
      newStream.getTracks().forEach(track => {
        this.peerConnection.addTrack(track, newStream);
      });
    }

    this.localStream = newStream;
  }

  /**
   * 获取远程音频流
   * @returns {MediaStream} 远程音频流
   */
  getRemoteStream() {
    return this.remoteStream;
  }

  /**
   * 关闭连接
   */
  close() {
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    // Stop all remote stream tracks
    if (this.remoteStream) {
      this.remoteStream.getTracks().forEach(track => track.stop());
    }
  }

  /**
   * 检查连接是否活跃
   * @returns {boolean} 是否活跃
   */
  isActive() {
    if (!this.peerConnection) return false;
    const state = this.peerConnection.connectionState;
    return state === 'connected' || state === 'connecting';
  }
}

export default WebRTCManager;