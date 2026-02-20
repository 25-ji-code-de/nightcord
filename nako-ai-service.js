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
 * NakoAIService - Nako AI 服务
 * 负责调用 Nako AI API，处理流式响应，通过事件总线与外部通信
 *
 * @example
 * const eventBus = new EventBus();
 * const nakoService = new NakoAIService({
 *   eventBus,
 *   apiUrl: 'https://nako.nightcord.de5.net/api/chat'
 * });
 *
 * // 监听事件
 * eventBus.on('nako:stream:start', (data) => {
 *   console.log('Nako 开始回复:', data.messageId);
 * });
 *
 * eventBus.on('nako:stream:chunk', (data) => {
 *   console.log('收到片段:', data.chunk);
 * });
 *
 * eventBus.on('nako:stream:end', (data) => {
 *   console.log('Nako 完成:', data.fullContent);
 * });
 *
 * // 调用 Nako
 * nakoService.ask('你好');
 */
class NakoAIService {
  /**
   * 创建 Nako AI 服务实例
   * @param {Object} config - 配置对象
   * @param {EventBus} config.eventBus - 事件总线实例
   * @param {string} [config.apiUrl] - Nako API 地址
   * @param {string} [config.nakoName] - Nako 显示名称
   * @param {number} [config.timeout] - 请求超时时间（毫秒）
   * @param {boolean} [config.stream] - 是否使用流式输出
   * @param {Function} [config.getAccessToken] - 获取 access token 的函数
   */
  constructor(config = {}) {
    this.eventBus = config.eventBus || new EventBus();
    this.apiUrl = config.apiUrl || 'https://nako.nightcord.de5.net/api/chat';
    this.nakoName = config.nakoName || 'Nako';
    this.timeout = config.timeout || 60000; // 60秒超时
    this.stream = config.stream !== false; // 默认启用流式
    this.getAccessToken = config.getAccessToken; // 获取 access token 的函数

    // 跟踪正在进行的请求
    this.activeRequests = new Map(); // messageId -> AbortController
  }

  /**
   * 向 Nako 提问
   * @param {string} prompt - 用户问题
   * @param {Object} options - 可选参数
   * @param {string} options.userId - 用户 ID
   * @param {Array} options.history - 对话历史
   * @param {string} options.persona - 人设名称（如 "nako", "asagi"）
   * @returns {Promise<string>} 完整回复内容
   * @fires nako:stream:start
   * @fires nako:stream:chunk
   * @fires nako:stream:end
   * @fires nako:error
   */
  async _prepareAuthHeaders() {
    const headers = {
      'Content-Type': 'application/json',
    };

    if (this.getAccessToken) {
      try {
        const accessToken = await this.getAccessToken();
        if (accessToken) {
          headers['Authorization'] = `Bearer ${accessToken}`;
        }
      } catch (error) {
        console.warn('Failed to get access token:', error);
      }
    }

    return headers;
  }

  _buildApiUrl(persona) {
    if (!persona) return this.apiUrl;

    const url = new URL(this.apiUrl);
    url.searchParams.set('persona', persona);
    return url.toString();
  }

  async _processResponse(response, messageId) {
    const contentType = response.headers.get('content-type');
    let fullContent = '';
    let fullReasoning = '';
    let usage = null;

    if (this.stream && contentType && contentType.includes('text/event-stream')) {
      const result = await this.processSSEStream(response, messageId);
      fullContent = result.content;
      fullReasoning = result.reasoning;
    } else if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Nako 返回错误');
      }

      fullContent = data.response || '';
      fullReasoning = data.reasoningContent || '';
      usage = data.usage;

      if (!fullContent.trim()) {
        throw new Error('Nako 返回了空响应');
      }

      this.eventBus.emit('nako:stream:chunk', {
        messageId,
        chunk: fullContent,
        timestamp: Date.now()
      });
    } else {
      throw new Error('未知的响应格式');
    }

    if (!fullContent.trim()) {
      throw new Error('Nako 返回了空响应');
    }

    return { fullContent, fullReasoning, usage };
  }

  async ask(prompt, options = {}) {
    if (!prompt || !prompt.trim()) {
      throw new Error('问题不能为空');
    }

    const { userId = 'Anonymous', history = [], persona } = options;
    const displayName = this.getPersonaDisplayName(persona);
    const messageId = `nako_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const abortController = new AbortController();
    this.activeRequests.set(messageId, abortController);

    this.eventBus.emit('nako:stream:start', {
      messageId,
      user: displayName,
      prompt,
      userId,
      timestamp: Date.now()
    });

    try {
      const timeoutId = setTimeout(() => {
        abortController.abort();
      }, this.timeout);

      const headers = await this._prepareAuthHeaders();
      const apiUrl = this._buildApiUrl(persona);

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          userId: userId,
          message: prompt.trim(),
          history: history,
          stream: this.stream
        }),
        signal: abortController.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`API 错误: ${response.status} ${response.statusText}`);
      }

      const { fullContent, fullReasoning, usage } = await this._processResponse(response, messageId);

      this.eventBus.emit('nako:stream:end', {
        messageId,
        user: displayName,
        fullContent,
        reasoning: fullReasoning,
        usage,
        timestamp: Date.now()
      });

      this.activeRequests.delete(messageId);
      return fullContent;

    } catch (error) {
      this.activeRequests.delete(messageId);

      this.eventBus.emit('nako:error', {
        messageId,
        error: error.message,
        timestamp: Date.now()
      });

      throw error;
    }
  }

  /**
   * 模拟流式输出（用于非流式 API）
   * @private
   * @param {string} messageId - 消息 ID
   * @param {string} fullContent - 完整内容
   */
  async simulateStream(messageId, fullContent) {
    // 逐字输出，模拟打字效果
    const chars = fullContent.split('');
    let accumulated = '';

    for (const char of chars) {
      accumulated += char;

      // 发出片段事件
      this.eventBus.emit('nako:stream:chunk', {
        messageId,
        chunk: char,
        timestamp: Date.now()
      });

      // 延迟，模拟打字速度（根据字符类型调整）
      const delay = this.getTypingDelay(char);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  /**
   * 获取打字延迟（毫秒）
   * @private
   * @param {string} char - 字符
   * @returns {number} 延迟时间
   */
  getTypingDelay(char) {
    // 标点符号稍慢
    if (/[，。！？、；：,.!?;:]/.test(char)) {
      return 100;
    }
    // 换行符稍慢
    if (char === '\n') {
      return 150;
    }
    // 普通字符
    return 30;
  }

  /**
   * 处理 SSE 流式响应
   * @private
   * @param {Response} response - Fetch Response 对象
   * @param {string} messageId - 消息 ID
   * @returns {Promise<string>} 完整内容
   */
  async processSSEStream(response, messageId) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let fullReasoning = ''; // 收集完整的思考过程
    let buffer = ''; // 缓冲区，用于处理不完整的数据

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      // 解析 SSE 格式：按行分割，但保留最后一行（可能不完整）
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留最后一行到缓冲区

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();

          // 检查是否结束
          if (data === '[DONE]') {
            continue;
          }

          // 跳过空数据
          if (!data) {
            continue;
          }

          try {
            // 解析 JSON
            const json = JSON.parse(data);

            // 检查是否有 choices 数组
            if (json.choices && json.choices.length > 0) {
              const choice = json.choices[0];
              const delta = choice.delta || {};

              // 收集思考过程（reasoning_content）
              const reasoning = delta.reasoning_content || '';
              if (reasoning) {
                fullReasoning += reasoning;
              }

              // 收集最终输出（content）
              const text = delta.content || '';
              if (text) {
                fullContent += text;

                // 发出片段事件
                this.eventBus.emit('nako:stream:chunk', {
                  messageId,
                  chunk: text,
                  timestamp: Date.now()
                });
              }

              // 检查是否完成
              if (choice.finish_reason === 'stop') {
                break;
              }
            }
          } catch (e) {
            console.warn('解析 SSE 数据失败:', data, e);
          }
        }
      }
    }

    // 返回内容和思考过程
    return { content: fullContent, reasoning: fullReasoning };
  }

  /**
   * 处理流式响应（旧版，保留兼容）
   * @private
   * @param {Response} response - Fetch Response 对象
   * @param {string} messageId - 消息 ID
   * @returns {Promise<string>} 完整内容
   * @deprecated 使用 processSSEStream 代替
   */
  async processStream(response, messageId) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });

      // 解析 SSE 格式
      const lines = chunk.split('\n').filter(line => line.trim());
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            // 尝试解析 JSON
            const json = JSON.parse(data);
            const text = json.response || json.content || json.text || json.message || '';
            if (text) {
              fullContent += text;
              // 发出片段事件
              this.eventBus.emit('nako:stream:chunk', {
                messageId,
                chunk: text,
                timestamp: Date.now()
              });
            }
          } catch (e) {
            // 如果不是 JSON，直接当作文本
            if (data && data !== '[DONE]') {
              fullContent += data;
              this.eventBus.emit('nako:stream:chunk', {
                messageId,
                chunk: data,
                timestamp: Date.now()
              });
            }
          }
        }
      }
    }

    return fullContent;
  }

  /**
   * 取消正在进行的请求
   * @param {string} messageId - 消息 ID
   * @returns {boolean} 是否成功取消
   */
  cancel(messageId) {
    const controller = this.activeRequests.get(messageId);
    if (controller) {
      controller.abort();
      this.activeRequests.delete(messageId);

      this.eventBus.emit('nako:cancelled', {
        messageId,
        timestamp: Date.now()
      });

      return true;
    }
    return false;
  }

  /**
   * 取消所有正在进行的请求
   */
  cancelAll() {
    for (const [messageId, controller] of this.activeRequests.entries()) {
      controller.abort();
      this.eventBus.emit('nako:cancelled', {
        messageId,
        timestamp: Date.now()
      });
    }
    this.activeRequests.clear();
  }

  /**
   * 检查是否有正在进行的请求
   * @returns {boolean}
   */
  hasActiveRequests() {
    return this.activeRequests.size > 0;
  }

  /**
   * 获取正在进行的请求数量
   * @returns {number}
   */
  getActiveRequestCount() {
    return this.activeRequests.size;
  }

  /**
   * 获取配置信息
   * @returns {Object}
   */
  getConfig() {
    return {
      apiUrl: this.apiUrl,
      nakoName: this.nakoName,
      timeout: this.timeout,
      activeRequests: this.activeRequests.size
    };
  }

  /**
   * 根据 persona 获取显示名称
   * @param {string} persona - 人设标识
   * @returns {string} 显示名称
   */
  getPersonaDisplayName(persona) {
    // 使用统一配置获取显示名称
    return window.AIConfig.getDisplayName(persona) || this.nakoName;
  }
}
