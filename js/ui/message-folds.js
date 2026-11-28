/* SPDX-License-Identifier: AGPL-3.0-only */
/** Collapse presentation only; original rows keep their identity and chronology. */
class MessageFoldView {
  constructor(ui) {
    this.ui = ui;
    this.openMessages = new Set();
    this.openGroups = new Set();
    this.nodeGroups = new WeakMap();
    this.records = new Map();
    this.groups = [];
    this.cursor = 0;
  }
  key(message) { return String(message.replyKey || message.seq || message.timestamp); }
  ensureScope() {
    const scope = `${this.ui.managedChat ? 'managed' : 'public'}:${this.ui.currentRoom || ''}`;
    if (scope !== this.scope) {
      this.openMessages.clear(); this.openGroups.clear(); this.scope = scope;
      this.source = null;
    }
  }
  prepare() {
    this.ensureScope();
    const messages = this.ui.messages;
    if (this.source !== messages || this.cursor > messages.length) {
      this.source = messages; this.cursor = 0; this.records.clear(); this.groups = [];
    }
    for (; this.cursor < messages.length; this.cursor++) {
      const message = messages[this.cursor];
      if (!message.profile?.id || message.sender || message.delivery || message.user === '系统' || message.localNakoMessageId) continue;
      const timestamp = Number(message.timestamp), key = this.key(message);
      if (!Number.isFinite(timestamp) || this.records.has(key)) continue;
      const content = MessagePolicy.fingerprint(message.text || (message.sticker ? `[sticker:${message.sticker}]` : ''));
      if (!content) continue;
      // Only recent clusters are candidates, even when years of history are loaded.
      let group = this.groups.findLast(group => group.last > timestamp - MessagePolicy.WINDOW_MS
        && group.last <= timestamp && MessagePolicy.similar(group.content, content));
      if (!group) {
        group = { key, content, members: [], last: timestamp, active: false };
        this.groups.push(group);
      }
      const record = { key, actor: message.profile.id, timestamp, group };
      group.members.push(record); group.last = timestamp; this.records.set(key, record);
      const recent = group.members.filter(member => member.timestamp > timestamp - MessagePolicy.WINDOW_MS);
      if (recent.length >= MessagePolicy.GROUP_MESSAGES && new Set(recent.map(member => member.actor)).size >= MessagePolicy.GROUP_SENDERS) group.active = true;
    }
  }
  repeated(message) {
    this.prepare();
    return this.records.get(this.key(message))?.group.active === true;
  }
  decorate(message, body) {
    this.ensureScope();
    if (message.user === '系统' || message.delivery || message.localNakoMessageId) return body;
    const reason = MessagePolicy.analyze(message.text).reason;
    if (!reason) return body;
    const key = this.key(message);
    const scope = this.scope;
    const details = document.createElement('details'); details.className = 'message-fold';
    const summary = document.createElement('summary');
    const label = document.createElement('span');
    const preview = document.createElement('span'); preview.className = 'message-fold-preview';
    preview.textContent = [...MessagePolicy.segmenter.segment(MessagePolicy.body(message.text).replace(/\s+/g, ' '))]
      .slice(0, 60).map(part => part.segment).join('');
    details.open = this.openMessages.has(key);
    const update = () => {
      label.textContent = `${reason} · ${details.open ? '收起' : '展开'}`;
      preview.hidden = details.open;
      if (details.open) this.openMessages.add(key); else this.openMessages.delete(key);
    };
    summary.append(label, preview); details.append(summary, body); update();
    details.addEventListener('toggle', () => {
      if (scope !== this.scope || !details.isConnected) return;
      update(); this.ui.readingPosition?.scheduleCapture();
    });
    return details;
  }
  apply() {
    this.prepare();
    if (!this.groups.some(group => group.active && (!group.summary?.isConnected
        || group.count !== group.members.length || group.open !== this.openGroups.has(group.key)))) return;
    const log = this.ui.elements.chatlog;
    const batches = new Set();
    let anchor;
    if (!this.ui.isAtBottom) {
      const top = log.getBoundingClientRect().top;
      for (const batch of log.children) {
        if (batch.getBoundingClientRect().bottom <= top) continue;
        for (const node of batch.classList.contains('message-batch') ? batch.children : [batch]) {
          if (node.hidden) continue;
          const rect = node.getBoundingClientRect();
          if (rect.bottom > top) { anchor = { node, top: rect.top }; break; }
        }
        if (anchor) break;
      }
    }
    for (const group of this.groups) {
      if (!group.active) continue;
      const nodes = group.members.map(member => this.ui.messageIndex.get(Number(member.key))).filter(node => node?.isConnected);
      if (!nodes.length) continue;
      if (!group.summary?.isConnected) {
        group.summary = document.createElement('div'); group.summary.className = 'message-repeat-summary';
        group.button = document.createElement('button'); group.button.type = 'button';
        group.summary.append(group.button); nodes[0].before(group.summary);
        group.button.addEventListener('click', () => {
          if (this.openGroups.has(group.key)) this.openGroups.delete(group.key); else this.openGroups.add(group.key);
          this.apply(); this.ui.readingPosition?.scheduleCapture();
        });
      }
      // Do not hide a control the reader is currently using or text being selected.
      const selection = globalThis.getSelection?.();
      if (nodes.some(node => node.contains(document.activeElement)
          || selection && !selection.isCollapsed && node.contains(selection.anchorNode))) this.openGroups.add(group.key);
      const open = this.openGroups.has(group.key);
      group.open = open; group.count = group.members.length;
      const label = `${group.members.length} 条相似消息 · ${new Set(group.members.map(member => member.actor)).size} 人 · ${open ? '收起' : '展开'}`;
      if (group.button.textContent !== label) group.button.textContent = label;
      group.button.setAttribute('aria-expanded', String(open));
      for (const node of nodes) {
        node.hidden = !open; this.nodeGroups.set(node, group); batches.add(node.parentElement);
      }
    }
    // Empty content-visibility batches must not retain a large off-screen spacer.
    for (const batch of batches) {
      if (!batch?.classList.contains('message-batch')) continue;
      const visible = [...batch.children].filter(node => !node.hidden).length;
      batch.hidden = visible === 0;
      batch.style.setProperty('--message-batch-height', `${visible * 72}px`);
    }
    if (anchor) {
      const visible = anchor.node.hidden ? this.nodeGroups.get(anchor.node)?.summary : anchor.node;
      if (visible) log.scrollTop += visible.getBoundingClientRect().top - anchor.top;
    }
  }
  reveal(node) {
    const group = this.nodeGroups.get(node);
    if (group) { this.openGroups.add(group.key); this.apply(); }
    for (const details of node.querySelectorAll('.message-fold')) details.open = true;
  }
}
