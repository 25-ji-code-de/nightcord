/**
 * VoiceRoomManager - 语音聊天室管理器（使用 PeerJS）
 * 使用 PeerJS 进行 WebRTC 信令，避免通过聊天消息传输大量数据
 */
class VoiceRoomManagerPeerJS {
  constructor(eventBus, wsManager) {
    this.eventBus = eventBus;
    this.wsManager = wsManager;

    // Voice chat state
    this.inVoice = false;
    this.localStream = null;
    this.isMuted = false;
    this.username = null;
    this.roomname = null;

    // PeerJS instance
    this.peer = null;
    this.peerId = null;

    // Active calls: username -> MediaConnection
    this.calls = new Map();

    // Remote streams: username -> MediaStream
    this.remoteStreams = new Map();

    // Username to PeerID mapping
    this.usernameToPeerId = new Map();

    this.setupSignalingHandlers();
  }

  setupSignalingHandlers() {
    this.eventBus.on('message:received', (data) => {
      this.handleChatMessage(data);
    });
  }

  async joinVoiceChat(username, roomname, options = {}) {
    if (this.inVoice) {
      console.warn('Already in voice chat');
      return;
    }

    this.username = username;
    this.roomname = roomname;

    try {
      // Get media access (audio and optionally video)
      const constraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: options.video ? {
          width: { ideal: 640 },
          height: { ideal: 480 }
        } : false
      };

      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);

      // Initialize PeerJS
      await this.initializePeer();

      this.inVoice = true;

      // Broadcast voice state with PeerID
      this.broadcastVoiceState();

      this.eventBus.emit('voice:joined', {
        username: this.username,
        local: true
      });

      // Show local video if available
      if (this.localStream.getVideoTracks().length > 0 && window.showVideo) {
        window.showVideo(this.localStream, this.username, true);
      }

      console.log('Joined voice chat with PeerID:', this.peerId);
    } catch (error) {
      console.error('Failed to join voice chat:', error);
      this.eventBus.emit('voice:error', {
        message: 'Failed to join voice chat',
        error
      });
      throw error;
    }
  }

  async initializePeer() {
    return new Promise((resolve, reject) => {
      const peerId = `${this.roomname}-${this.username}-${Date.now()}`.replace(/[^a-zA-Z0-9-]/g, '_');

      this.peer = new Peer(peerId, {
        debug: 2, // Enable verbose logging
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            {
              urls: 'turn:openrelay.metered.ca:80',
              username: 'openrelayproject',
              credential: 'openrelayproject'
            },
            {
              urls: 'turn:openrelay.metered.ca:443',
              username: 'openrelayproject',
              credential: 'openrelayproject'
            }
          ],
          sdpSemantics: 'unified-plan',
          iceCandidatePoolSize: 10
        }
      });

      this.peer.on('open', (id) => {
        this.peerId = id;
        console.log('PeerJS connected with ID:', id);

        this.peer.on('call', (call) => {
          console.log('Receiving call from:', call.peer);
          // Answer the call with our local stream immediately
          call.answer(this.localStream);

          // Important: Set up stream handler BEFORE answering
          let streamReceived = false;
          call.on('stream', (remoteStream) => {
            if (streamReceived) return;
            streamReceived = true;

            console.log('Stream received in call handler');
            this.handleIncomingCall(call, remoteStream);
          });
        });

        resolve();
      });

      this.peer.on('error', (error) => {
        console.error('PeerJS error:', error);
        if (error.type === 'unavailable-id') {
          // ID taken, try again with different timestamp
          setTimeout(() => this.initializePeer().then(resolve).catch(reject), 100);
        } else {
          reject(error);
        }
      });
    });
  }

  handleIncomingCall(call, remoteStream) {
    console.log('Handling incoming call from:', call.peer);

    // Monitor peer connection state
    if (call.peerConnection) {
      const pc = call.peerConnection;

      pc.oniceconnectionstatechange = () => {
        console.log(`[Incoming] ICE connection state:`, pc.iceConnectionState);
      };

      pc.onconnectionstatechange = () => {
        console.log(`[Incoming] Connection state:`, pc.connectionState);
      };

      pc.onicegatheringstatechange = () => {
        console.log(`[Incoming] ICE gathering state:`, pc.iceGatheringState);
      };

      pc.onsignalingstatechange = () => {
        console.log(`[Incoming] Signaling state:`, pc.signalingState);
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log(`[Incoming] ICE candidate:`, event.candidate.candidate);
        } else {
          console.log(`[Incoming] ICE gathering complete`);
        }
      };
    }

    // Get username from peer ID
    const username = this.getPeerIdUsername(call.peer);
    console.log(`Received stream from peer ${call.peer}, username: ${username}`);

    if (!username) {
      console.warn('Could not find username for peer:', call.peer);
      return;
    }

    console.log('Stream details:', {
      id: remoteStream.id,
      active: remoteStream.active,
      tracks: remoteStream.getTracks().map(t => ({
        kind: t.kind,
        id: t.id,
        enabled: t.enabled,
        muted: t.muted,
        readyState: t.readyState,
        label: t.label
      }))
    });

    this.remoteStreams.set(username, remoteStream);
    this.calls.set(username, call);
    this.eventBus.emit('voice:stream-added', {
      username,
      stream: remoteStream
    });

    // Check if video track exists
    const videoTrack = remoteStream.getVideoTracks()[0];
    const audioTrack = remoteStream.getAudioTracks()[0];

    if (videoTrack) {
      if (videoTrack.muted) {
        console.log(`Video track is muted for ${username}, waiting for unmute...`);
        videoTrack.onunmute = () => {
          console.log(`Video track unmuted for ${username}, showing video now`);
          if (window.showVideo) {
            window.showVideo(remoteStream, username, false);
          }
        };
      } else {
        if (window.showVideo) {
          console.log(`Showing video for ${username}`);
          window.showVideo(remoteStream, username, false);
        }
      }
    } else if (audioTrack) {
      // No video, but has audio - play audio only
      console.log(`No video tracks for ${username}, playing audio only`);
      if (window.playAudio) {
        window.playAudio(remoteStream, username);
      }
    } else {
      console.log(`No video or audio tracks for ${username}`);
    }

    call.on('close', () => {
      const username = this.getPeerIdUsername(call.peer);
      if (username) {
        this.removePeer(username);
      }
    });

    call.on('error', (error) => {
      console.error('Call error:', error);
      const username = this.getPeerIdUsername(call.peer);
      if (username) {
        this.removePeer(username);
      }
    });
  }

  getPeerIdUsername(peerId) {
    for (const [username, id] of this.usernameToPeerId.entries()) {
      if (id === peerId) return username;
    }
    return null;
  }

  leaveVoiceChat() {
    if (!this.inVoice) return;

    // Stop local stream
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }

    // Close all calls
    this.calls.forEach((call) => {
      call.close();
    });
    this.calls.clear();
    this.remoteStreams.clear();
    this.usernameToPeerId.clear();

    // Close peer connection
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
      this.peerId = null;
    }

    this.inVoice = false;

    // Notify server
    this.broadcastVoiceState();

    this.eventBus.emit('voice:left', {
      username: this.username,
      local: true
    });

    // Remove local video display
    if (window.removeVideo) {
      window.removeVideo(this.username);
    }

    console.log('Left voice chat');
  }

  toggleMute() {
    if (!this.inVoice || !this.localStream) {
      console.warn('Not in voice chat');
      return this.isMuted;
    }

    this.isMuted = !this.isMuted;

    this.localStream.getAudioTracks().forEach(track => {
      track.enabled = !this.isMuted;
    });

    this.broadcastVoiceState();

    this.eventBus.emit('voice:muted', {
      username: this.username,
      muted: this.isMuted
    });

    console.log(`Microphone ${this.isMuted ? 'muted' : 'unmuted'}`);
    return this.isMuted;
  }

  broadcastVoiceState() {
    if (!this.wsManager.isConnected()) return;

    const message = `[VOICE_PEER:${JSON.stringify({
      username: this.username,
      inVoice: this.inVoice,
      muted: this.isMuted,
      peerId: this.peerId
    })}]`;

    this.wsManager.send({ message });
  }

  handleChatMessage(messageData) {
    const { name, message } = messageData;
    if (!message || !message.startsWith('[VOICE_PEER:')) return;

    try {
      const jsonStr = message.slice('[VOICE_PEER:'.length, -1);
      const data = JSON.parse(jsonStr);

      if (data.username === this.username) return; // Ignore own messages

      this.handleVoiceState(data);
    } catch (e) {
      console.warn('Failed to parse voice peer message:', e);
    }
  }

  handleVoiceState(data) {
    const { username, inVoice, muted, peerId } = data;

    if (inVoice && peerId) {
      // Remote user joined voice
      this.usernameToPeerId.set(username, peerId);

      this.eventBus.emit('voice:joined', {
        username,
        local: false
      });

      // If we're also in voice, initiate call
      if (this.inVoice && !this.calls.has(username)) {
        this.callPeer(username, peerId);
      }
    } else {
      // Remote user left voice
      this.removePeer(username);
      this.usernameToPeerId.delete(username);

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

  callPeer(username, peerId) {
    if (!this.localStream || !this.peer) return;

    console.log(`Calling ${username} at ${peerId}`);
    console.log('Local stream tracks:', this.localStream.getTracks().map(t => `${t.kind}: ${t.enabled}`));

    const call = this.peer.call(peerId, this.localStream);
    this.calls.set(username, call);

    // Wait a bit for peerConnection to be created
    setTimeout(() => {
      if (call.peerConnection) {
        const pc = call.peerConnection;
        console.log(`[${username}] PeerConnection created, monitoring states...`);

        pc.oniceconnectionstatechange = () => {
          console.log(`[${username}] ICE connection state:`, pc.iceConnectionState);
        };

        pc.onconnectionstatechange = () => {
          console.log(`[${username}] Connection state:`, pc.connectionState);
        };

        pc.onicegatheringstatechange = () => {
          console.log(`[${username}] ICE gathering state:`, pc.iceGatheringState);
        };

        pc.onsignalingstatechange = () => {
          console.log(`[${username}] Signaling state:`, pc.signalingState);
        };

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            console.log(`[${username}] ICE candidate:`, event.candidate.candidate);
          } else {
            console.log(`[${username}] ICE gathering complete`);
          }
        };

        // Log initial state
        console.log(`[${username}] Initial states:`, {
          ice: pc.iceConnectionState,
          connection: pc.connectionState,
          signaling: pc.signalingState
        });
      } else {
        console.warn(`[${username}] PeerConnection not created yet`);
      }
    }, 100);

    let streamHandled = false; // Prevent duplicate stream handling

    call.on('stream', (remoteStream) => {
      if (streamHandled) {
        console.log('Stream already handled for', username);
        return;
      }
      streamHandled = true;

      console.log(`Received stream from ${username}`);
      console.log('Stream details:', {
        id: remoteStream.id,
        active: remoteStream.active,
        tracks: remoteStream.getTracks().map(t => ({
          kind: t.kind,
          id: t.id,
          enabled: t.enabled,
          muted: t.muted,
          readyState: t.readyState,
          label: t.label
        }))
      });

      this.remoteStreams.set(username, remoteStream);
      this.eventBus.emit('voice:stream-added', {
        username,
        stream: remoteStream
      });

      // Check if video track exists
      const videoTrack = remoteStream.getVideoTracks()[0];
      const audioTrack = remoteStream.getAudioTracks()[0];

      if (videoTrack) {
        if (videoTrack.muted) {
          console.log(`Video track is muted for ${username}, waiting for unmute...`);
          videoTrack.onunmute = () => {
            console.log(`Video track unmuted for ${username}, showing video now`);
            if (window.showVideo) {
              window.showVideo(remoteStream, username, false);
            }
          };
          // Also set a timeout to show video anyway after 2 seconds
          setTimeout(() => {
            if (window.showVideo) {
              console.log(`Showing video for ${username} after timeout`);
              window.showVideo(remoteStream, username, false);
            }
          }, 2000);
        } else {
          // Video track is not muted, show immediately
          if (window.showVideo) {
            console.log(`Showing video for ${username}`);
            window.showVideo(remoteStream, username, false);
          }
        }
      } else if (audioTrack) {
        // No video, but has audio - play audio only
        console.log(`No video tracks for ${username}, playing audio only`);
        if (window.playAudio) {
          window.playAudio(remoteStream, username);
        }
      } else {
        console.log(`No video or audio tracks for ${username}`);
      }
    });

    call.on('close', () => {
      console.log(`Call with ${username} closed`);
      this.removePeer(username);
    });

    call.on('error', (error) => {
      console.error(`Call error with ${username}:`, error);
      this.removePeer(username);
    });
  }

  removePeer(username) {
    const call = this.calls.get(username);
    if (call) {
      call.close();
      this.calls.delete(username);
    }

    const stream = this.remoteStreams.get(username);
    if (stream) {
      this.remoteStreams.delete(username);
      this.eventBus.emit('voice:stream-removed', {
        username
      });

      // Remove video display
      if (window.removeVideo) {
        window.removeVideo(username);
      }
    }
  }

  getParticipants() {
    const participants = Array.from(this.calls.keys());
    if (this.inVoice) {
      participants.unshift(this.username);
    }
    return participants;
  }

  getRemoteStream(username) {
    return this.remoteStreams.get(username) || null;
  }

  destroy() {
    this.leaveVoiceChat();
  }
}
