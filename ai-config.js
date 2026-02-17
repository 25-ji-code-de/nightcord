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
 * @returns {Object|null} 返回 {persona, displayName, prompt, triggerType} 或 null
 */
function detectAITrigger(message) {
  if (!message || typeof message !== 'string') {
    return null;
  }

  for (const ai of AI_PERSONAS) {
    // 1. 检测命令模式: /commandName prompt
    const commandRegex = new RegExp(`^\\/${ai.commandName}\\s+(.+)`, 'i');
    const commandMatch = message.match(commandRegex);
    if (commandMatch) {
      return {
        persona: ai.persona,
        displayName: ai.displayName,
        prompt: commandMatch[1],
        triggerType: 'command'
      };
    }

    // 2. 检测 @mention 开头模式: @mentionName prompt
    const mentionPrefix = `@${ai.mentionName} `;
    if (message.startsWith(mentionPrefix)) {
      return {
        persona: ai.persona,
        displayName: ai.displayName,
        prompt: message.substring(mentionPrefix.length),
        triggerType: 'mention_start'
      };
    }

    // 3. 检测句中提及模式: any text @mentionName any text
    const mentionRegex = new RegExp(`@${ai.mentionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    if (mentionRegex.test(message)) {
      return {
        persona: ai.persona,
        displayName: ai.displayName,
        prompt: message,
        triggerType: 'mention_inline'
      };
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
