/*
 * Nightcord - A modern, modular real-time chat application
 * Copyright (C) 2025 The 25-ji-code-de Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * SEKAI Analytics - 事件上报服务
 * 将用户活动数据上报到 SEKAI Platform API
 */
(function (global) {
  class SekaiAnalytics {
    constructor({ apiUrl, eventBus, sekaiPassAuth } = {}) {
      this.apiUrl = apiUrl || 'https://api.nightcord.de5.net';
      this.eventBus = eventBus;
      this.sekaiPassAuth = sekaiPassAuth;

      // 在线时长统计
      this.onlineStartTime = null;
      this.onlineReportInterval = null;

      // 事件队列（离线时缓存）
      this.eventQueue = [];
      this.maxQueueSize = 50;

      // 初始化
      this.init();
    }

    /**
     * 初始化事件监听
     */
    init() {
      if (!this.eventBus) return;

      // 监听消息发送事件
      this.eventBus.on('message:sent', (data) => {
        this.reportEvent('message_sent', {
          message_length: data.message?.length || 0
        });
      });

      // 监听连接打开事件（开始计时）
      this.eventBus.on('connection:open', () => {
        this.startOnlineTracking();
      });

      // 监听连接关闭事件（停止计时）
      this.eventBus.on('connection:close', () => {
        this.stopOnlineTracking();
      });

      // 页面卸载时上报最后的在线时长
      window.addEventListener('beforeunload', () => {
        this.flushOnlineTimeBeacon();
      });
      // pagehide is more reliable on mobile
      window.addEventListener('pagehide', () => {
        this.flushOnlineTimeBeacon();
      });
    }

    /**
     * 开始在线时长追踪
     */
    startOnlineTracking() {
      if (this.onlineStartTime) return; // 已经在追踪中

      this.onlineStartTime = Date.now();

      // 每 5 分钟上报一次在线时长
      this.onlineReportInterval = setInterval(() => {
        this.reportOnlineTime();
      }, 5 * 60 * 1000);
    }

    /**
     * 停止在线时长追踪
     */
    stopOnlineTracking() {
      if (!this.onlineStartTime) return;

      // 上报最后的在线时长
      this.reportOnlineTime();

      // 清理
      this.onlineStartTime = null;
      if (this.onlineReportInterval) {
        clearInterval(this.onlineReportInterval);
        this.onlineReportInterval = null;
      }
    }

    /**
     * Best-effort online time report on page unload (sendBeacon when possible).
     */
    flushOnlineTimeBeacon() {
      if (!this.onlineStartTime) return;
      const now = Date.now();
      const minutes = Math.floor((now - this.onlineStartTime) / 60000);
      this.onlineStartTime = null;
      if (this.onlineReportInterval) {
        clearInterval(this.onlineReportInterval);
        this.onlineReportInterval = null;
      }
      if (minutes <= 0 || !this.sekaiPassAuth) return;

      const event = {
        project: 'nightcord',
        event_type: 'online_time',
        metadata: { minutes },
      };

      try {
        const token = localStorage.getItem('sekai_pass_access_token');
        if (!token || typeof navigator.sendBeacon !== 'function') {
          // Fire-and-forget; may be cancelled by unload
          void this.reportEvent('online_time', { minutes });
          return;
        }
        // sendBeacon cannot set Authorization; fall back to async fetch keepalive
        void fetch(`${this.apiUrl}/user/events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(event),
          keepalive: true,
        }).catch(() => {});
      } catch (_) {
        /* ignore */
      }
    }

    /**
     * 上报在线时长
     */
    reportOnlineTime() {
      if (!this.onlineStartTime) return;

      const now = Date.now();
      const minutes = Math.floor((now - this.onlineStartTime) / 60000);

      if (minutes > 0) {
        this.reportEvent('online_time', { minutes });
        this.onlineStartTime = now; // 重置起始时间
      }
    }

    /**
     * 上报事件到 SEKAI Platform API
     */
    async reportEvent(eventType, metadata = {}) {
      if (!this.sekaiPassAuth) {
        console.debug('[SEKAI Analytics] SEKAI Pass not initialized, skipping event report');
        return;
      }

      const event = {
        project: 'nightcord',
        event_type: eventType,
        metadata: metadata
      };

      try {
        // 使用自动刷新的 getAccessToken 方法（会自动检查和刷新 token）
        const accessToken = await this.sekaiPassAuth.getAccessToken();

        const response = await fetch(`${this.apiUrl}/user/events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
          },
          body: JSON.stringify(event)
        });

        if (!response.ok) {
          throw new Error(`Failed to report event: ${response.status}`);
        }

        console.debug('[SEKAI Analytics] Event reported:', eventType, metadata);
      } catch (error) {
        // 如果未登录或 token 失效，静默跳过
        console.debug('[SEKAI Analytics] Failed to report event:', error.message);

        // 如果上报失败，加入队列（可选：实现离线缓存）
        this.queueEvent(event);
      }
    }

    /**
     * 将事件加入队列（离线缓存）
     */
    queueEvent(event) {
      if (this.eventQueue.length >= this.maxQueueSize) {
        this.eventQueue.shift(); // 移除最旧的事件
      }
      this.eventQueue.push(event);
    }

    /**
     * 重试队列中的事件
     */
    async retryQueuedEvents() {
      if (this.eventQueue.length === 0) return;

      const events = this.eventQueue.splice(0, this.eventQueue.length);
      // Cap retry burst to avoid hammering API after reconnect
      const batch = events.slice(0, 10);
      const rest = events.slice(10);
      for (const event of batch) {
        await this.reportEvent(event.event_type, event.metadata);
      }
      // Put untried events back at the front of the queue
      if (rest.length) {
        this.eventQueue = rest.concat(this.eventQueue).slice(0, this.maxQueueSize);
      }
    }

    /**
     * 手动上报自定义事件
     */
    track(eventType, metadata = {}) {
      this.reportEvent(eventType, metadata);
    }
  }

  global.SekaiAnalytics = SekaiAnalytics;
})(window);
