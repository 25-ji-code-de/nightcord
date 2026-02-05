/**
 * VoiceRoomManager - 语音聊天室管理器
 * 负责协调多个 WebRTC 连接（mesh topology）
 * 通过 EventBus 发送事件，完全独立于 UI
 */
import WebRTCManager from './webrtc-manager.js';

class VoiceRoomManager {
  /**
   * 创建语音聊天室管理器
   * @param {EventBus} eventBus - 事件总线
   * @param {WebSocketManager} wsManager - WebSocket 管理器（用于信令）
   */
  constructor(eventBus, wsManager) {
    this.eventBus = eventBus;
    this.wsManager = wsManager;

    // Voice chat state
    this.inVoice = false;
    this.localStream = null;
    this.isMuted = false;
    this.username = null;
    this.roomname = null;

    // Peer connections map: username -> WebRTCManager
    this.peers = new Map();

    // Remote streams map: username -> MediaStream
    this.remoteStreams = new Map();

    // Subscribe to WebSocket messages for signaling
    this.setupSignalingHandlers();
  }

  /**
   * 设置 WebSocket 信令处理器
   */
  setupSignalingHandlers() {
    // Store original onMessage handler
    const originalOnMessage = this.wsManager.onMessage;

    // Wrap it to intercept WebRTC signaling
    this.wsManager.onMessage = (data) => {
      if (data.type && data.type.startsWith('webrtc-')) {
        this.handleSignaling(data);
      } else if (data.type === 'voice-state') {
        this.handleVoiceState(data);
      } else {
        // Pass non-WebRTC messages to original handler
        if (originalOnMessage) {
          originalOnMessage(data);
        }
      }
    };
  }

  /**
   * 加入语音聊天
   * @param {string} username - 用户名
   * @param {string} roomname - 房间名
   */
  async joinVoiceChat(username, roomname) {
    if (this.inVoice) {
      console.warn('Already in voice chat');
      return;
    }

    if (!username || !roomname) {
      throw new Error('Username and roomname required');
    }

    this.username = username;
    this.roomname = roomname;

    try {
      // Request microphone access
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

      this.inVoice = true;

      // Notify server and other clients
      this.broadcastVoiceState();

      // Emit event
      this.eventBus.emit('voice:joined', {
        username: this.username,
        local: true
      });

      console.log('Joined voice chat');
    } catch (error) {
      console.error('Failed to get microphone access:', error);
      this.eventBus.emit('voice:error', {
        message: 'Microphone access denied',
        error
      });
      throw error;
    }
  }

  /**
   * 离开语音聊天
   */
  leaveVoiceChat() {
    if (!this.inVoice) return;

    // Stop local stream
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }

    // Close all peer connections
    this.peers.forEach((manager) => {
      manager.close();
    });
    this.peers.clear();
    this.remoteStreams.clear();

    this.inVoice = false;

    // Notify server
    this.broadcastVoiceState();

    // Emit event
    this.eventBus.emit('voice:left', {
      username: this.username,
      local: true
    });

    console.log('Left voice chat');
  }

  /**
   * 切换麦克风静音状态
   * @returns {boolean} 新的静音状态
   */
  toggleMute() {
    if (!this.inVoice || !this.localStream) {
      console.warn('Not in voice chat');
      return this.isMuted;
    }

    this.isMuted = !this.isMuted;

    // Mute/unmute audio tracks
    this.localStream.getAudioTracks().forEach(track => {
      track.enabled = !this.isMuted;
    });

    // Notify others
    this.broadcastVoiceState();

    // Emit event
    this.eventBus.emit('voice:muted', {
      username: this.username,
      muted: this.isMuted
    });

    console.log(`Microphone ${this.isMuted ? 'muted' : 'unmuted'}`);
    return this.isMuted;
  }

  /**
   * 广播语音状态到其他用户
   */
  broadcastVoiceState() {
    if (!this.wsManager.isConnected()) return;

    this.wsManager.send({
      type: 'voice-state',
      username: this.username,
      roomname: this.roomname,
      inVoice: this.inVoice,
      muted: this.isMuted
    });
  }

  /**
   * 处理语音状态消息
   * @param {Object} data - 语音状态数据
   */
  handleVoiceState(data) {
    const { username, inVoice, muted } = data;

    if (username === this.username) return; // Ignore own state

    if (inVoice) {
      // Remote user joined voice
      this.eventBus.emit('voice:joined', {
        username,
        local: false
      });

      // If we're also in voice, initiate connection
      if (this.inVoice) {
        this.createPeerConnection(username);
      }
    } else {
      // Remote user left voice
      this.removePeer(username);
      this.eventBus.emit('voice:left', {
        username,
        local: false
      });
    }

    if (muted !== undefined) {
      this.eventBus.emit('voice:muted', {
        username,
        muted
      });
    }
  }

  /**
   * 创建与远程用户的对等连接
   * @param {string} remoteUsername - 远程用户名
   */
  async createPeerConnection(remoteUsername) {
    if (this.peers.has(remoteUsername)) {
      console.warn(`Peer connection to ${remoteUsername} already exists`);
      return;
    }

    console.log(`Creating peer connection to ${remoteUsername}`);

    const manager = new WebRTCManager({
      onIceCandidate: (candidate) => {
        this.sendSignaling({
          type: 'webrtc-ice-candidate',
          to: remoteUsername,
          candidate
        });
      },
      onRemoteStream: (stream) => {
        console.log(`Received remote stream from ${remoteUsername}`);
        this.remoteStreams.set(remoteUsername, stream);
        this.eventBus.emit('voice:stream-added', {
          username: remoteUsername,
          stream
        });
      },
      onConnectionStateChange: (state) => {
        console.log(`Connection to ${remoteUsername}: ${state}`);
        this.eventBus.emit('voice:connection-state', {
          username: remoteUsername,
          state
        });

        if (state === 'failed' || state === 'closed') {
          this.removePeer(remoteUsername);
        }
      }
    });

    this.peers.set(remoteUsername, manager);

    // Add local stream
    if (this.localStream) {
      manager.addLocalStream(this.localStream);
    }

    // Create and send offer
    try {
      const offer = await manager.createOffer();
      this.sendSignaling({
        type: 'webrtc-offer',
        to: remoteUsername,
        offer
      });
    } catch (error) {
      console.error('Failed to create offer:', error);
      this.removePeer(remoteUsername);
    }
  }

  /**
   * 移除对等连接
   * @param {string} username - 用户名
   */
  removePeer(username) {
    const manager = this.peers.get(username);
    if (manager) {
      manager.close();
      this.peers.delete(username);
    }

    const stream = this.remoteStreams.get(username);
    if (stream) {
      this.remoteStreams.delete(username);
      this.eventBus.emit('voice:stream-removed', {
        username
      });
    }
  }

  /**
   * 处理信令消息
   * @param {Object} data - 信令数据
   */
  async handleSignaling(data) {
    const { type, from, offer, answer, candidate } = data;

    if (from === this.username) return; // Ignore own messages

    switch (type) {
      case 'webrtc-offer':
        await this.handleOffer(from, offer);
        break;

      case 'webrtc-answer':
        await this.handleAnswer(from, answer);
        break;

      case 'webrtc-ice-candidate':
        await this.handleIceCandidate(from, candidate);
        break;
    }
  }

  /**
   * 处理 WebRTC offer
   * @param {string} from - 发送者用户名
   * @param {RTCSessionDescriptionInit} offer - SDP offer
   */
  async handleOffer(from, offer) {
    console.log(`Received offer from ${from}`);

    // Create peer connection if doesn't exist
    if (!this.peers.has(from)) {
      const manager = new WebRTCManager({
        onIceCandidate: (candidate) => {
          this.sendSignaling({
            type: 'webrtc-ice-candidate',
            to: from,
            candidate
          });
        },
        onRemoteStream: (stream) => {
          console.log(`Received remote stream from ${from}`);
          this.remoteStreams.set(from, stream);
          this.eventBus.emit('voice:stream-added', {
            username: from,
            stream
          });
        },
        onConnectionStateChange: (state) => {
          console.log(`Connection to ${from}: ${state}`);
          this.eventBus.emit('voice:connection-state', {
            username: from,
            state
          });

          if (state === 'failed' || state === 'closed') {
            this.removePeer(from);
          }
        }
      });

      this.peers.set(from, manager);

      // Add local stream
      if (this.localStream) {
        manager.addLocalStream(this.localStream);
      }
    }

    const manager = this.peers.get(from);

    try {
      await manager.handleOffer(offer);
      const answer = await manager.createAnswer();

      this.sendSignaling({
        type: 'webrtc-answer',
        to: from,
        answer
      });
    } catch (error) {
      console.error('Failed to handle offer:', error);
      this.removePeer(from);
    }
  }

  /**
   * 处理 WebRTC answer
   * @param {string} from - 发送者用户名
   * @param {RTCSessionDescriptionInit} answer - SDP answer
   */
  async handleAnswer(from, answer) {
    console.log(`Received answer from ${from}`);

    const manager = this.peers.get(from);
    if (!manager) {
      console.warn(`No peer connection for ${from}`);
      return;
    }

    try {
      await manager.handleAnswer(answer);
    } catch (error) {
      console.error('Failed to handle answer:', error);
      this.removePeer(from);
    }
  }

  /**
   * 处理 ICE candidate
   * @param {string} from - 发送者用户名
   * @param {RTCIceCandidateInit} candidate - ICE candidate
   */
  async handleIceCandidate(from, candidate) {
    const manager = this.peers.get(from);
    if (!manager) {
      console.warn(`No peer connection for ${from}`);
      return;
    }

    try {
      await manager.addIceCandidate(candidate);
    } catch (error) {
      console.error('Failed to add ICE candidate:', error);
    }
  }

  /**
   * 发送信令消息
   * @param {Object} data - 信令数据
   */
  sendSignaling(data) {
    if (!this.wsManager.isConnected()) {
      console.warn('WebSocket not connected, cannot send signaling');
      return;
    }

    this.wsManager.send({
      ...data,
      from: this.username,
      roomname: this.roomname
    });
  }

  /**
   * 获取所有语音参与者
   * @returns {string[]} 参与者用户名列表
   */
  getParticipants() {
    const participants = Array.from(this.peers.keys());
    if (this.inVoice) {
      participants.unshift(this.username);
    }
    return participants;
  }

  /**
   * 获取远程音频流
   * @param {string} username - 用户名
   * @returns {MediaStream|null} 音频流
   */
  getRemoteStream(username) {
    return this.remoteStreams.get(username) || null;
  }

  /**
   * 销毁管理器
   */
  destroy() {
    this.leaveVoiceChat();
  }
}

export default VoiceRoomManager;