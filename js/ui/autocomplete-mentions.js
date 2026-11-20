/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** AutocompleteMentions: mentionView component; autocomplete supplies shared presentation context. */
class AutocompleteMentions {
  constructor(autocomplete) { this.autocomplete = autocomplete; }

  /**
   * 提及候选：所有人、AI 角色与已知成员。
   * 供输入框补全和侧栏提及选择器共用，保持两处身份与排序一致。
   */
  mentionCandidates() {
    const allUsers = this.autocomplete.getAllUsers().map(user => {
      const profile = user.profile;
      const id = profile?.id || '';
      const kind = profile ? (profile.authenticated ? '账号' : '访客') : '成员';
      const identifier = profile?.username ? `@${profile.username}` : id.split(':').slice(1).join(':');
      const shortIdentifier = profile?.username ? identifier : identifier.slice(-8);
      return {
        ...user, type: 'user', id,
        detail: [kind, shortIdentifier].filter(Boolean).join(' · '),
        detailTitle: [kind, identifier, user.status === 'online' ? '在线' : '离线'].filter(Boolean).join(' · ')
      };
    });
    allUsers.unshift(
      { name: 'everyone', type: 'all', id: '', avatar: '', color: '', label: '所有人' },
      ...(window.AIConfig?.AI_PERSONAS || []).map(ai => ({
        name: ai.displayName, type: 'ai', id: ai.persona, avatar: '', color: '', label: 'AI'
      }))
    );
    return allUsers;
  }

  mentionGroups(matches) {
    const groups = {
      all: { label: '所有人', members: [] }, ai: { label: 'AI 助手', members: [] },
      online: { label: '在线成员', members: [] }, offline: { label: '离线成员', members: [] },
    };
    for (const candidate of this.mentionCandidates()) {
      if (!matches(candidate)) continue;
      const key = candidate.type === 'user' ? (candidate.status === 'online' ? 'online' : 'offline') : candidate.type;
      groups[key].members.push(candidate);
    }
    const sections = Object.values(groups).filter(group => group.members.length);
    for (const { members } of sections) members.sort((a, b) => a.name.localeCompare(b.name));
    return sections;
  }

  showMentionList(query) {
    const lowerQuery = query.toLowerCase();
    const matches = this.autocomplete.mentionGroups(u => u.name.toLowerCase().startsWith(lowerQuery)).flatMap(group => group.members);

    /*
     * u.name 是别人起的名字（roster 与历史消息的发送者）。
     * 不转义时 `"><img src=x onerror=alert(1)>` 会闭合 data-name="，
     * 直接逃出属性上下文 —— 这一处比成员列表那处还危险。
     */
    this.autocomplete.renderItems(matches, (u) => `
      <div class="mention-item" data-name="${escapeHtml(u.name)}" data-type="${escapeHtml(u.type || 'user')}" data-id="${escapeHtml(u.id || '')}" data-status="${escapeHtml(u.status || '')}" title="${escapeHtml(u.detailTitle || u.label || '')}">
        <span class="avatar ${escapeHtml(u.color)}" aria-hidden="true">${escapeHtml(u.avatar)}</span>
        <span class="mention-identity">
          <span class="mention-name">${escapeHtml(u.name)}</span>
          <span class="mention-detail">${escapeHtml(u.label || u.detail || '')}</span>
        </span>
        <div class="status-indicator" title="${escapeHtml(u.label || (u.status === 'online' ? '在线' : '离线'))}"></div>
      </div>
    `, (item) => this.autocomplete.completeMention(item.dataset.name, item.dataset.type, item.dataset.id));

    this.autocomplete.list.querySelectorAll('.mention-item').forEach((item, index) => {
      this.renderMentionAvatar(item.querySelector('.avatar'), matches[index]);
    });
  }

  renderMentionAvatar(avatar, candidate) {
    if (candidate.type === 'user') {
      this.autocomplete.renderAvatar?.(avatar, candidate.profile);
    } else {
      avatar.classList.add('mention-symbol');
      avatar.appendChild(this.createMentionIcon(candidate.type));
    }
  }

  createMentionIcon(type) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.75');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    icon.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', type === 'all'
      ? 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z'
      : 'M12 3v3M10 3h2M4 10H2M22 10h-2M8 18v3M16 18v3M7 6h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3ZM8 10v2M16 10v2M9 15h6');
    icon.appendChild(path);
    return icon;
  }
}
