/* SPDX-License-Identifier: AGPL-3.0-only */
/** Classifies actual message data, independently of rendering and delivery. */
class MessageAlerts {
  static labels = { mention: '@ 我', reply: '回复我', everyone: '全体提及', message: '新消息' };

  constructor(mentions, replyTargets) { this.mentions = mentions; this.replyTargets = replyTargets; }

  classify(message, user, lookup) {
    if (!user?.id || !message.profile?.id || message.profile.id === user.id || message.sender
        || message.localNakoMessageId || typeof message.text !== 'string') return [];
    // Markdown code and quoted examples are not calls for attention. The SEKAI
    // parser then handles structured Code/Reply/Mention and legacy re tokens.
    const text = message.text.replace(/```[\s\S]*?(?:```|$)/g, '')
      .replace(/`[^`\n]*`|^\s*>.*$/gm, '');
    const reasons = new Set();
    for (const part of this.mentions?.parts(text) || []) {
      if (this.mentions.isMention(part)) {
        const type = (part.desc.type || 'user').toLowerCase();
        if (type === 'all') reasons.add('everyone');
        else if (type === 'user' && part.payload === user.id) reasons.add('mention');
      } else if (part.type === 'text') {
        if (this.mentions.containsText(part.content, 'everyone')) reasons.add('everyone');
        if (this.mentions.containsText(part.content, user.displayName)) reasons.add('mention');
      } else if (!this.replyTargets && (part.sekaiType === 'reply' || part.sekaiType === 're')) {
        const ts = Number(part.payload);
        const original = Number.isSafeInteger(ts) && ts > 0 ? lookup(ts) : null;
        if (original?.profile?.id === user.id && !original.sender) reasons.add('reply');
      }
    }
    for (const ts of this.replyTargets?.(text) || []) {
      const original = lookup(ts);
      if (original?.profile?.id === user.id && !original.sender) reasons.add('reply');
    }
    return ['mention', 'reply', 'everyone', 'message'].filter(kind => kind === 'message' || reasons.has(kind));
  }
}
