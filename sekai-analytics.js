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
        this.stopOnlineTracking();
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
      // 检查是否已登录
      if (!this.sekaiPassAuth || !this.sekaiPassAuth.isAuthenticated()) {
        console.debug('[SEKAI Analytics] Not authenticated, skipping event report');
        return;
      }

      const accessToken = localStorage.getItem('sekai_pass_access_token');
      if (!accessToken) return;

      const event = {
        project: 'nightcord',
        event_type: eventType,
        metadata: metadata
      };

      try {
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
        console.error('[SEKAI Analytics] Failed to report event:', error);

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

      const events = [...this.eventQueue];
      this.eventQueue = [];

      for (const event of events) {
        await this.reportEvent(event.event_type, event.metadata);
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
