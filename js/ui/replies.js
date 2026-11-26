/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** ReplyView: replies component; ui supplies shared presentation context. */
class ReplyView {
  constructor(ui) { this.ui = ui; }

  /**
   * 查找被回复消息的预览信息（SEKAI v2 Reply）
   * @param {number|string} ts
   * @returns {{ name?: string, preview?: string } | null}
   */
  lookupReplyMeta(ts) {
    const key = Number(ts) || ts;
    const meta = this.ui.messageMeta.get(key) || this.ui.messageMeta.get(String(ts));
    if (!meta) return null;
    const plain = this.extractPlainTextForReply(meta.text || '');
    const preview = plain.length > 50 ? plain.substring(0, 50) + '...' : plain;
    return {
      name: meta.user || '',
      preview: preview.replace(/\n/g, ' ')
    };
  }

  /**
   * 取出本条消息里所有被回复消息的 timestamp。
   *
   * 只认 token：畸形 token 在渲染器眼里本来就是纯文本，这里跟着走同一套判断。
   * v2 是 `<$SEKAI:Reply::123>`，v1 遗留是 `[re:123|preview]`。
   *
   * @param {string} text 消息原文
   * @returns {number[]} 去重后的 timestamp 列表
   */
  replyTargets(text) {
    // Examples inside Markdown code or quoted lines are not reply actions.
    const source = String(text || '').replace(/```[\s\S]*?(?:```|(?![\s\S]))|`[^`\n]*`|^>[^\n]*/gm, '');
    const parts = this.ui.mentions?.parts(source) || [];
    const targets = [];
    for (const part of parts) {
      if (part.type !== 'sekai') continue;
      if (part.sekaiType !== 'reply' && part.sekaiType !== 're') continue;
      const timestamp = Number(part.payload);
      if (!Number.isSafeInteger(timestamp) || timestamp <= 0) continue;
      if (!targets.includes(timestamp)) targets.push(timestamp);
    }
    return targets;
  }

  /**
   * 这条消息是不是在回复「我」。
   *
   * 归属只按消息 id 判断，和 mentions.isMentioned 一个策略：没有 id 就不认，
   * 宁可漏报也不要因为重名把别人的回复推给我。
   *
   * @param {string} text 消息原文
   * @param {{ id?: string } | null} [user] 当前用户，缺省取 ui.currentUser
   * @returns {boolean}
   */
  isReplyToMe(text, user = this.ui.currentUser) {
    if (!user?.id) return false;
    // Message rendering is batched; ownership must also work before its next frame.
    return this.replyTargets(text).some(timestamp => {
      const target = this.ui.messages.find(message => Number(message.replyKey || message.timestamp) === timestamp);
      return target?.profile?.id === user.id;
    });
  }

  /**
   * 设置回复跳转事件监听器
   * @private
   */
  setupReplyJumpListener() {
    document.addEventListener('reply-jump', (event) => {
      const { timestamp } = event.detail;
      const messageEl = this.ui.messageIndex.get(timestamp);

      if (messageEl) {
        // 滚动到目标消息
        messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // 添加高亮动画
        messageEl.classList.add('message-highlighted');
        setTimeout(() => {
          messageEl.classList.remove('message-highlighted');
        }, 2000);
      } else {
        // 消息不存在或不在当前视图中
        console.warn('Reply target message not found:', timestamp);
      }
    });
  }

  /**
   * 创建回复按钮
   * @param {Object} msg - 消息对象
   * @returns {HTMLElement}
   * @private
   */
  createReplyButton(msg) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'message-reply-btn';
    btn.title = '回复此消息';
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 -960 960 960" width="24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M760-200v-160q0-50-35-85t-85-35H273l144 144-57 56-240-240 240-240 57 56-144 144h367q83 0 141.5 58.5T840-360v160h-80Z"/>
    </svg>`;

    btn.onclick = (e) => {
      e.stopPropagation();
      this.insertReplyReference(msg);
    };

    return btn;
  }

  /**
   * 在输入框插入回复引用
   * 发送策略：Reply 使用 SEKAI v2（无 wire preview，通常比 v1 更短；预览渲染时客户端派生）
   * @param {Object} msg - 要引用的消息对象
   * @private
   */
  insertReplyReference(msg) {
    const input = this.ui.elements.chatInput;
    if (!input || input.disabled) return;

    // SEKAI v2 Reply：payload = timestamp only
    const reference = `<$SEKAI:Reply::${msg.replyKey || msg.timestamp}> `;

    // 插入到当前光标位置
    const start = input.selectionStart || 0;
    const end = input.selectionEnd || start;
    const current = input.value;

    input.value = current.substring(0, start) + reference + current.substring(end);

    // 设置光标位置到引用后面
    const newPos = start + reference.length;
    input.setSelectionRange(newPos, newPos);

    // 聚焦输入框
    if (window.innerWidth > 768) {
      input.focus();
    }

    // 触发 input 事件以通知其他监听器
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * 按 SEKAI v2 规范构造匹配 token 的正则。
   *
   * Type 的形状取自 SekaiRenderer.V2_TYPE_SOURCE（规范 §3.3），
   * **不要在这里另写一份**。此前这几处用的是 `<\$SEKAI:[^>\n]*>`，
   * 不校验 Type，于是 `<$SEKAI:123:x>` 这类畸形 token 在渲染器眼里是
   * 纯文本、在这里却是 token —— 屏幕上看得见，复制/引用时整段消失。
   *
   * 渲染器不可用时回落到宽松形状：宁可沿用旧行为，也不要因为脚本
   * 加载顺序变了就把所有 token 都漏掉。
   * @private
   */
  _v2TokenRe(flags) {
    const type = (typeof SekaiRenderer !== 'undefined' && SekaiRenderer.V2_TYPE_SOURCE) || '[^>\\n]*';
    return new RegExp(`<\\$SEKAI:${type}:[^>\\n]*>`, flags);
  }

  /** 多行块：`<$SEKAI:Type:desc>` + 换行 + 内容 + `<&SEKAI>`。 */
  _v2BlockRe() {
    const type = (typeof SekaiRenderer !== 'undefined' && SekaiRenderer.V2_TYPE_SOURCE) || '[^\\n>]*';
    return new RegExp(`<\\$SEKAI:${type}:[^\\n>]*>\\r?\\n[\\s\\S]*?^<&SEKAI>\\s*$`, 'gm');
  }

  extractPlainTextForReply(text) {
    if (!text) return '';

    let plainText = text;

    // --- SEKAI v2 ---
    // Multi-line blocks: drop entirely (code etc.)
    plainText = plainText.replace(this._v2BlockRe(), '');

    // Format: try to keep decoded payload text
    plainText = plainText.replace(/<\$SEKAI:Format:([^>]*):([^>]*)>/gi, (_, desc, payload) => {
      if (/enc=base64/i.test(desc) && this.ui.sekaiRenderer) {
        try {
          return this.ui.sekaiRenderer.base64DecodeUtf8(payload);
        } catch (_) { /* fall through */ }
      }
      return payload || '';
    });

    // Mention: keep display name if present
    plainText = plainText.replace(/<\$SEKAI:Mention:([^>:\r\n]*):([^>\r\n]*)>/gi, (_, desc, payload) => {
      if (/(?:^|;)type=all(?:;|$)/i.test(desc)) return '@everyone';
      const m = /(?:^|;)display=([^;]*)/.exec(desc);
      if (m) {
        try { return '@' + decodeURIComponent(m[1].replace(/\+/g, '%20')); }
        catch { return '@' + m[1]; }
      }
      return payload ? '@' + payload : '';
    });

    // Other single-line v2 tokens — remove
    plainText = plainText.replace(this._v2TokenRe('g'), '');

    // --- SEKAI v1 ---
    // 1. 移除嵌套回复标记 [re:timestamp|preview]
    plainText = plainText.replace(/\[re:[^\]]+\]/g, '');

    // 2. 处理有文本内容的 SEKAI 标记
    plainText = plainText.replace(/\[(color|truecolor):([^|\]]+)\|([^\]]+)\]/g, '$3');
    plainText = plainText.replace(/\[img:[^|\]]+\|([^\]]+)\]/g, '$1');
    plainText = plainText.replace(/\[link:[^|\]]+\|([^\]]+)\]/g, '$1');

    // 3. 移除其他 SEKAI 标记（stamp, file, audio, code 等）
    plainText = plainText.replace(/\[(\w+):([^\]]+)\]/g, '');

    // 4. 移除 Markdown 格式标记
    plainText = plainText.replace(/\*\*(.+?)\*\*/g, '$1');
    plainText = plainText.replace(/\*(.+?)\*/g, '$1');
    plainText = plainText.replace(/~~(.+?)~~/g, '$1');
    plainText = plainText.replace(/\|\|(.+?)\|\|/g, '$1');
    plainText = plainText.replace(/`(.+?)`/g, '$1');
    plainText = plainText.replace(/^>\s+/gm, '');

    // 5. 清理多余空白
    plainText = plainText.trim();

    return plainText;
  }
}
