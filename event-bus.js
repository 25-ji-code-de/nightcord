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
 * EventBus - 事件总线
 *
 * @example
 * const eventBus = new EventBus();
 * eventBus.on('message', (data) => console.log('Received:', data));
 * eventBus.emit('message', { text: 'Hello' });
 * eventBus.off('message', callback);
 */
class EventBus {
  constructor() {
    /**
     * 存储事件监听器的对象
     * @type {Object.<string, Function[]>}
     */
    this.listeners = Object.create(null);
  }

  /**
   * 订阅事件
   * @param {string} event - 事件名称
   * @param {Function} callback - 回调函数
   * @returns {Function} unsubscribe helper
   */
  on(event, callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('EventBus.on: callback must be a function');
    }
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
    return () => this.off(event, callback);
  }

  /**
   * 订阅一次：触发后自动取消
   * @param {string} event
   * @param {Function} callback
   * @returns {Function} unsubscribe
   */
  once(event, callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('EventBus.once: callback must be a function');
    }
    const wrapper = (data) => {
      this.off(event, wrapper);
      callback(data);
    };
    // Preserve identity for off via wrapper only
    return this.on(event, wrapper);
  }

  /**
   * 取消订阅事件
   * @param {string} event - 事件名称
   * @param {Function} callback - 要移除的回调函数
   */
  off(event, callback) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter((cb) => cb !== callback);
    if (this.listeners[event].length === 0) {
      delete this.listeners[event];
    }
  }

  /**
   * 发布事件（单个监听器异常不影响其他监听器）
   * @param {string} event - 事件名称
   * @param {*} data - 传递给监听器的数据
   */
  emit(event, data) {
    const list = this.listeners[event];
    if (!list || list.length === 0) return;
    // Snapshot so on/off during emit is stable
    const snapshot = list.slice();
    for (const callback of snapshot) {
      try {
        callback(data);
      } catch (err) {
        console.error(`EventBus: listener for "${event}" threw`, err);
      }
    }
  }

  /**
   * 清空所有事件监听器
   */
  clear() {
    this.listeners = Object.create(null);
  }

  /**
   * 清空指定事件的所有监听器
   * @param {string} event - 事件名称
   */
  clearEvent(event) {
    if (this.listeners[event]) {
      delete this.listeners[event];
    }
  }

  /**
   * 获取指定事件的监听器数量
   * @param {string} event - 事件名称
   * @returns {number} 监听器数量
   */
  listenerCount(event) {
    return this.listeners[event] ? this.listeners[event].length : 0;
  }
}
