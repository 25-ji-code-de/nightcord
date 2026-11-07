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
 * AI 人设统一配置
 *
 * 配置说明：
 * - persona: API 调用时使用的人设 ID（内部标识）
 * - displayName: UI 显示名称
 * - mentionName: @提及时使用的名称（可以是中文、日文等）
 * - commandName: /命令时使用的名称（通常是英文或简写）
 */

const AI_PERSONAS = [
  {
    persona: 'nako',
    displayName: 'Nako',
    mentionName: 'Nako',
    commandName: 'nako'
  },
  {
    persona: 'asagi',
    displayName: 'Asagi',
    mentionName: 'Asagi',
    commandName: 'asagi'
  },
  {
    persona: 'miku',
    displayName: 'Miku',
    mentionName: 'Miku',
    commandName: 'miku'
  },
  {
    persona: 'yui',
    displayName: '汤川唯',
    mentionName: '汤川唯',
    commandName: 'yui'
  }
];

/**
 * 检测消息中的 AI 触发
 * @param {string} message - 用户输入的消息
 * @param {NightcordMentions} [mentions] - 与渲染器共享分词的提及服务
 * @returns {Object|null} 返回 {persona, displayName, prompt, triggerType} 或 null
 */
function detectAITrigger(message, mentions) {
  if (!message || typeof message !== 'string') return null;
  mentions ||= window.NightcordMentions ? new window.NightcordMentions() : null;

  for (const ai of AI_PERSONAS) {
    const match = message.match(new RegExp(`^/${ai.commandName}(?:\\s+([\\s\\S]*))?$`, 'i'));
    if (match) {
      return {
        persona: ai.persona, displayName: ai.displayName,
        prompt: mentions ? mentions.prompt(match[1] || '') : match[1] || '',
        triggerType: 'command'
      };
    }
  }

  const parts = mentions ? mentions.parts(message) : [{ type: 'text', content: message }];
  for (const part of parts) {
    let ai;
    if (mentions?.isMention(part) && part.desc.type?.toLowerCase() === 'ai') {
      const id = part.payload.toLowerCase();
      ai = AI_PERSONAS.find(config => [config.persona, config.mentionName.toLowerCase()].includes(id));
    } else if (part.type === 'text') {
      ai = AI_PERSONAS.find(config => mentions
        ? mentions.containsText(part.content, config.mentionName)
        : part.content.startsWith(`@${config.mentionName} `));
    }
    if (ai) {
      const prompt = mentions ? mentions.prompt(message, ai.mentionName)
        : message.slice(ai.mentionName.length + 2).trim();
      const triggerType = part.type !== 'text' ? 'mention_token'
        : message.toLowerCase().startsWith(`@${ai.mentionName.toLowerCase()}`) ? 'mention_start' : 'mention_inline';
      return { persona: ai.persona, displayName: ai.displayName, prompt, triggerType };
    }
  }
  return null;
}

/**
 * 获取所有 AI 显示名称列表
 * @returns {Array<string>} 显示名称数组
 */
function getAllDisplayNames() {
  return AI_PERSONAS.map(ai => ai.displayName);
}

/**
 * 根据 persona ID 获取显示名称
 * @param {string} persona - persona ID
 * @returns {string|null} 显示名称或 null
 */
function getDisplayName(persona) {
  const ai = AI_PERSONAS.find(a => a.persona === persona);
  return ai ? ai.displayName : null;
}

/**
 * 根据 persona ID 获取完整配置
 * @param {string} persona - persona ID
 * @returns {Object|null} AI 配置对象或 null
 */
function getAIConfig(persona) {
  return AI_PERSONAS.find(a => a.persona === persona) || null;
}

// 导出到全局对象供浏览器使用
window.AIConfig = {
  AI_PERSONAS,
  detectAITrigger,
  getAllDisplayNames,
  getDisplayName,
  getAIConfig
};
