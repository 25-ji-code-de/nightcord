/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** Validates outgoing chat input and routes local AI commands through events. */
class MessageCommands {
  constructor({ eventBus, send, aiConfig, mentions, spacing, typeSource, encode }) {
    Object.assign(this, { eventBus, send, aiConfig, mentions, spacing, typeSource, encode });
  }

  error(message) {
    this.eventBus.emit('error', { message });
    return false;
  }

  submit(input) {
    let message = String(input || '').trim();
    if (!message) return false;
    if (message.length > 256) return this.error('消息超过 256 字符，请缩短后重试。');
    if (/^\/clear$/i.test(message)) {
      this.eventBus.emit('nako:clear');
      this.eventBus.emit('message:sent', { message });
      this.eventBus.emit('message:notice', { message: 'Nako 的对话上下文已清除。下次对话将不携带历史消息。' });
      return true;
    }
    const trigger = this.aiConfig.detectAITrigger(message, this.mentions);
    if (trigger) {
      if (!trigger.prompt.trim()) return this.error(`请输入要问 ${trigger.displayName} 的问题`);
      if (this.send(message) === false) return this.error('消息发送失败，请连接聊天室后重试。');
      this.eventBus.emit('nako:ask', { prompt: trigger.prompt.trim(), persona: trigger.persona });
      return true;
    }
    message = this.format(message);
    // 语C的角色前缀也计入 256 字符上限；encode('') 即前缀本身，非角色发言时为空。
    const prefix = this.encode?.('') ?? '';
    if (message.length + prefix.length > 256) {
      return this.error(prefix
        ? `角色消息最多 ${256 - prefix.length} 个字符（角色前缀占用 ${prefix.length} 个），请缩短后重试。`
        : '格式化后的消息超过 256 字符，请缩短后重试。');
    }
    return this.send(this.encode ? this.encode(message) : message);
  }

  format(message) {
    if (this.spacing) {
      // 保护 SEKAI / Markdown 语法不被 pangu 插入空格
      const placeholders = [];
      let placeholderPrefix = '__SEKAI_';
      while (message.includes(placeholderPrefix)) placeholderPrefix = `_${placeholderPrefix}`;
      const protect = (match) => {
        const index = placeholders.length;
        placeholders.push(match);
        return `${placeholderPrefix}${index}__`;
      };

      // 0. 保护 SEKAI v2 multi-line blocks (<$SEKAI:…>\n…\n<&SEKAI>)
      message = message.replace(new RegExp(`<\\$SEKAI:${this.typeSource}:[^\\n>]*>\\r?\\n[\\s\\S]*?^<&SEKAI>\\s*$`, 'gm'), protect);

      // 1. 保护 SEKAI v2 single-line tokens
      message = message.replace(new RegExp(`<\\$SEKAI:${this.typeSource}:[^>\\n]*>`, 'g'), protect);

      // 2. 保护 SEKAI v1 [type:data] 与 legacy stickers
      message = message.replace(/\[([^\]]+)\]/g, protect);

      // 3. 保护 markdown 格式标记
      message = message.replace(/\*\*([^*]+)\*\*/g, protect);
      message = message.replace(/\*([^*\s][^*]*[^*\s])\*/g, protect);
      message = message.replace(/~~([^~]+)~~/g, protect);
      message = message.replace(/\|\|([^|]+)\|\|/g, protect);
      message = message.replace(/`([^`]+)`/g, protect);

      message = this.spacing(message);

      for (let index = placeholders.length - 1; index >= 0; index--) {
        message = message.replace(`${placeholderPrefix}${index}__`, () => placeholders[index]);
      }
    }

    // 发送侧 stamp 保持 v1 短语法（256 预算 + autocomplete 生态）
    // [stamp_0806] / [stamp0806] → [stamp:0806]；不改写成 v2
    message = message
      .replace(/\[stamp_(\d+)\]/gi, (_, n) => `[stamp:${n}]`)
      .replace(/\[stamp(\d+)\]/gi, (_, n) => `[stamp:${n}]`);

    return message;
  }
}
