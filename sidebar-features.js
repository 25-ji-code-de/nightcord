/* SPDX-License-Identifier: AGPL-3.0-only */
(function (global) {
  'use strict';
  const TITLES = { search: '搜索', inbox: '收件箱', tasks: '任务', help: '帮助' };
  const PAGE_SIZE = 50;
  const HELP = [
    ['搜索聊天记录', '输入关键词进行搜索；您可以按发送者或日期进行筛选，点击搜索结果即可跳转至原始消息。搜索范围涵盖当前聊天窗口中已加载的聊天记录（包括保存在您浏览器本地的数据），但不包含尚未加载的服务器端记录。您可以使用 Ctrl / ⌘ + K 快捷键快速打开搜索功能。'],
    ['收件箱与 @ 提及', '收件箱会汇总当前聊天室中提及你或“@everyone”的消息。你发送的消息以及 AI 的回复不包含在内。你可以筛选未读消息，将单条消息标记为“已读”或“未读”，也可以将所有消息标记为“已读”。仅打开收件箱并不会清除未读计数；只有当你点击某条消息时，它才会被标记为“已读”。“已读/未读”状态存储在你当前使用的浏览器本地。'],
    ['管理我的任务', '点击“添加任务”打开录入终端，选择“黑单 · 任务”或“红单 · 贴条”，核对内容后交印。黑单取出上轨后开始计时，送入打卡钟结束本段；取回后可再次开工或收入抽屉。红单可拖到任务上，也可选中后点击“贴在这里”，并支持取下重贴。拖动横杆、横向滑动或转动两侧滚轮可查看其他任务。任务与工时记录在同一张卡上，累计工时保留已结束的各段。数据按房间和身份保存在当前浏览器，清除站点数据会删除这些内容。'],
    ['发送消息、表情与附件', '按“回车键”（Enter）发送消息，按“Shift + 回车键”换行；每条消息最多可包含 256 个字符。输入“@”可选择成员或 AI，输入“::”可选择表情符号。使用输入框旁边的附件按钮，可以上传图片、音乐或文件。点击消息上的回复按钮，即可引用原消息。'],
    ['账号和成员资料', '点击成员的头像或昵称，即可查看其个人资料。您可以通过点击侧边栏底部的个人头像来修改访客昵称，也可以前往“SEKAI Pass”编辑您的账户详情。访客身份基于浏览器 Cookie；即使昵称相同，也会被视为不同的身份。'],
    ['语音聊天', '语音聊天功能目前可在测试房间及默认房间中使用，需登录 SEKAI Pass 账号。进入语音聊天后，您可以控制麦克风、收听他人发言或退出通话；请务必授予浏览器访问麦克风的权限。侧边栏中的摄像头图标目前仅用于显示状态。'],
    ['外观与导航', '点击齿轮图标可进入设置界面，在此您可以调整配色方案及成员列表的布局。使用双箭头图标可展开或收起成员列表；选择“首页”（Home）则可返回至聊天界面的底部。搜索、收件箱、任务和帮助等功能会在主内容区域内打开；您可以按下 Esc 键或点击“返回聊天”选项以退出当前页面。'],
    ['连接或保存失败', '如果连接中断，系统会自动尝试恢复。若您无法发送数据，请等待连接恢复；如果登录会话已过期，请重新登录。若收到无法保存数据的提示，请检查网站存储功能是否已被禁用，或存储空间是否已满；任何未保存的任务或“已读”状态更新，仅在当前页面会话期间有效。'],
    ['私信', '私信功能暂未上线；待系统架构确定后，该功能将被整合进来。目前，在聊天区域发送的消息，房间内的所有成员均可见。'],
  ];
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, action, className = 'tool-button') {
    const node = element('button', className, text);
    node.type = 'button'; node.addEventListener('click', action);
    return node;
  }
  function helpEntry(title, ...content) {
    const detail = element('details');
    detail.append(element('summary', '', title), ...content);
    return detail;
  }
  function externalLink(label, url) {
    const link = element('a', '', label);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }
  function field(label, type, id, parent) {
    const wrapper = element('label', 'tool-field');
    wrapper.append(element('span', 'tool-field-label', label));
    const input = element('input'); input.type = type; input.id = id;
    wrapper.append(input); parent.append(wrapper);
    return input;
  }
  const messageKey = message => `${message.timestamp}:${message.profile?.id || message.user}`;
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
  const timestamp = value => Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime()) ? value : null;
  const pad = n => String(n).padStart(2, '0');
  const localDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const localTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const durationText = ms => {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? `${minutes} 分` : `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`;
  };
  const listOf = value => Array.isArray(value) ? value : [];
  const safeText = (value, size) => typeof value === 'string' ? value.slice(0, size) : '';
  function punch(task, now) {
    if (task.done) return;
    task.sessions ||= [];
    const start = timestamp(task.startedAt);
    task.sessions.push({ start: start && start <= now ? start : null, end: now });
    task.startedAt = null; task.completedAt = now; task.done = true;
  }
  function resume(task, now) {
    task.startedAt = now; task.completedAt = null; task.done = false; task.archived = false;
  }
  function imprint(value) {
    const d = new Date(value);
    const time = element('time', '', `${localDate(d)} ${localTime(d)}`);
    time.dateTime = d.toISOString(); return time;
  }
  function taskIcon(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'), use = document.createElementNS(ns, 'use');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false'); svg.setAttribute('class', 'task-icon');
    use.setAttribute('href', `/icons/task-tools.svg#${name}`); svg.append(use); return svg;
  }
  function clockDial() {
    const ns = 'http://www.w3.org/2000/svg';
    const shape = (tag, attrs) => {
      const node = document.createElementNS(ns, tag);
      for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
      return node;
    };
    const dial = shape('svg', {viewBox:'0 0 220 220', class:'clock-dial', role:'img'});
    for (let i = 0; i < 60; i++) {
      const angle = i * Math.PI / 30;
      const mark = radius => [110 + Math.sin(angle) * radius, 144 - Math.cos(angle) * radius * .86];
      const [x1,y1] = mark(38), [x2,y2] = mark(i % 5 ? 37 : 34);
      dial.append(shape('line', {x1,y1,x2,y2, stroke:'#c2ced9', 'stroke-width':i % 5 ? .6 : 1.4}));
      if (i % 5 === 0) {
        const [x,y] = mark(47);
        const number = shape('text', {x,y:y+3.5, 'text-anchor':'middle', fill:'#edf1f3', 'font-size':11, 'font-family':'Arial, sans-serif','font-weight':700});
        number.textContent = i ? i / 5 : 12; dial.append(number);
      }
    }
    const hand = (len, width) => shape('line', {x1:110,y1:147,x2:110,y2:144-len, stroke:'#f3f5f2', 'stroke-width':width,'stroke-linecap':'round'});
    const hour = hand(20,3.2), minute = hand(30,2);
    dial.append(hour, minute, shape('circle',{cx:110, cy:144, r:2.9, fill:'#cbd8de'}));
    return { dial, set(now) {
      hour.setAttribute('transform', `rotate(${(now.getHours()%12 + now.getMinutes()/60)*30} 110 144)`);
      minute.setAttribute('transform', `rotate(${now.getMinutes()*6} 110 144)`);
      dial.setAttribute('aria-label', '本地时间 ' + localTime(now));
    }};
  }
  const ticketNumber = task => task.number ? '#' + String(task.number).padStart(3, '0') : '任务';
  function timeCard(task) {
    const card = element('section', 'time-card');
    card.append(element('h4','time-card-name','工时记录'));
    const table = element('table'); table.setAttribute('aria-label','分段工时');
    const header = table.createTHead().insertRow();
    for (const text of ['日期','开工','收工','小计']) {
      const th = element('th','',text); th.scope = 'col'; header.append(th);
    }
    const body = table.createTBody();
    const sessions = [...(task.sessions || [])];
    if (!sessions.length && task.completedAt) sessions.push({start:null, end:task.completedAt});
    if (task.startedAt) sessions.push({start:task.startedAt, end:null});
    let total = 0;
    for (const session of sessions) {
      const start = session.start && new Date(session.start), end = session.end && new Date(session.end);
      const day = localDate(start || end);
      const row = body.insertRow(); row.insertCell().textContent = day.slice(5);
      for (const d of [start,end]) {
        const cell = row.insertCell();
        if (d) { const time = imprint(d); time.title = time.textContent; time.textContent = (localDate(d) !== day ? localDate(d).slice(5)+' ' : '') + localTime(d); cell.append(time); }
      }
      const subtotal = row.insertCell();
      if (start && end) { const span = end - start; subtotal.textContent = durationText(span); total += span; }
    }
    for (let i=sessions.length; i<4; i++) {
      const row = body.insertRow(); row.setAttribute('aria-hidden','true'); for(let j=0;j<4;j++) row.insertCell();
    }
    card.append(table);
    if (sessions.some(s => s.start && s.end)) card.append(element('div','card-total','累计　' + durationText(total)));
    return card;
  }
  const onRail = task => !task.archived && !task.station;

  class SidebarFeatures {
    constructor(ui) {
      this.ui = ui;
      this.memory = new Map();
      this.unsaved = new Set();
      this.kind = null;
      this.limit = PAGE_SIZE;
      this.inboxFilter = 'all';
      this.taskFilter = 'all';
      for (const kind of Object.keys(TITLES)) {
        const navigation = document.querySelector(`#navigation-${kind}`);
        navigation?.removeAttribute('aria-haspopup');
        navigation?.addEventListener('click', () => this.open(kind));
      }
      for (const id of ['navigation-chat', 'navigation-channel', 'navigation-mentions']) {
        document.querySelector(`#${id}`)?.addEventListener('click', () => this.close(false), true);
      }
      document.addEventListener('reply-jump', () => this.close(false), true);
      for (const event of ['message:received', 'room:ready', 'room:synced', 'room:changed', 'session:updated', 'session:unavailable']) {
        ui.eventBus.on(event, () => this.scheduleRefresh());
      }
      global.addEventListener('storage', event => {
        if (event.key === null || event.key === this.key()) {
          if (event.key === null) { this.memory.clear(); this.unsaved.clear(); }
          else { this.memory.delete(event.key); this.unsaved.delete(event.key); }
          this.scheduleRefresh();
        }
      });
      document.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !event.isComposing
          && !document.querySelector('dialog[open], .name-chooser:not(.hidden)')) {
          event.preventDefault(); this.open('search');
        }
      });
      // 导航按钮的 aria-controls 与面板的 aria-labelledby 需要目标一开始就存在
      this.ensurePanel();
    }

    key() {
      return this.ui.currentUser?.id && this.ui.currentRoom
        ? `nightcord-sidebar:${encodeURIComponent(this.ui.currentRoom)}:${encodeURIComponent(this.ui.currentUser.id)}` : null;
    }

    read() {
      const key = this.key();
      if (!key) return { tasks: [], read: {} };
      if (this.unsaved.has(key)) return this.memory.get(key);
      let data;
      try { data = JSON.parse(localStorage.getItem(key) || '{}'); }
      catch { this.storageError = true; return this.memory.get(key) || { tasks: [], read: {} }; }
      const tasks = (Array.isArray(data?.tasks) ? data.tasks : []).filter(task => task && typeof task.id === 'string'
        && typeof task.title === 'string' && task.title.trim()).slice(0, 200).map(task => ({
        id: task.id.slice(0, 80), title: task.title.slice(0, 200), done: task.done === true, due: validDate(task.due) ? task.due : '',
        createdAt: timestamp(task.createdAt), completedAt: task.done === true ? timestamp(task.completedAt) : null,
        number: Number.isSafeInteger(task.number) && task.number > 0 ? task.number : null,
        operator: safeText(task.operator, 60), archived: task.done === true && task.archived === true,
        station: !task.archived && ['printer', 'clock'].includes(task.station) ? task.station : null,
        startedAt: task.done === true ? null : timestamp(task.startedAt),
        sessions: listOf(task.sessions).filter(s => timestamp(s?.end)).map(s => ({
          start: timestamp(s.start) && s.start <= s.end ? s.start : null, end: s.end,
        })),
        items: listOf(task.items).slice(0, 30).filter(i => typeof i?.text === 'string').map(i => ({ text: i.text.slice(0, 120), checked: i.checked === true })),
        notes: listOf(task.notes).filter(n => typeof n?.text === 'string').map(n => ({ id: safeText(n.id, 80), text: n.text.slice(0, 200), at: timestamp(n.at) })),
      }));
      const read = Object.fromEntries(Object.entries(data?.read && typeof data.read === 'object' ? data.read : {})
        .filter(([key, value]) => key.length < 300 && value === true && Number.isFinite(Number(key.split(':')[0])))
        .sort(([a], [b]) => Number(b.split(':')[0]) - Number(a.split(':')[0])).slice(0, 2000));
      const sequence = Math.max(Number.isSafeInteger(data?.sequence) && data.sequence > 0 ? data.sequence : 0, ...tasks.map(task => task.number || 0));
      const slips = listOf(data?.slips).filter(s => s && typeof s.id === 'string' && typeof s.text === 'string' && s.text.trim()).slice(0, 200)
        .map(s => ({id:s.id.slice(0,80), text:s.text.slice(0,200), at:timestamp(s.at), station:s.station === 'printer' ? 'printer' : 'loose'}));
      const state = { tasks, slips, read, sequence, operator: safeText(data?.operator, 60) };
      this.memory.set(key, state);
      return state;
    }

    save(change) {
      const key = this.key();
      if (!key) return null;
      const state = this.read();
      change(state);
      state.read = Object.fromEntries(Object.entries(state.read)
        .sort(([a], [b]) => Number(b.split(':')[0]) - Number(a.split(':')[0])).slice(0, 2000));
      this.memory.set(key, state);
      try {
        localStorage.setItem(key, JSON.stringify(state));
        this.unsaved.delete(key); this.storageError = false;
      } catch { this.unsaved.add(key); this.storageError = true; }
      return state;
    }

    saveTasks(change) {
      const state = this.save(change);
      if (!state) return;
      this.renderTasks(state);
      this.renderStorageWarning();
    }

    saveRead(change) {
      const mentions = this.mentions();
      const state = this.save(state => change(state.read, mentions));
      if (state) this.refresh(state, mentions);
    }

    scheduleRefresh() {
      if (this.refreshPending) return;
      this.refreshPending = true;
      queueMicrotask(() => { this.refreshPending = false; this.refresh(); });
    }

    messages() {
      return this.ui.messages.filter(message => message.user !== '系统' && !message.localNakoMessageId
        && Number.isFinite(message.timestamp) && typeof message.text === 'string');
    }

    mentions() {
      const user = this.ui.currentUser;
      if (!user) return [];
      const seen = new Set();
      return this.messages().filter(message => {
        const key = messageKey(message);
        if (!message.profile?.id || message.profile.id === user.id || message.sender || seen.has(key)
          || !this.ui.mentions?.isMentioned(message.text, user)) return false;
        seen.add(key); return true;
      }).sort((a, b) => b.timestamp - a.timestamp).slice(0, 2000);
    }

    refresh(state = this.read(), mentions = this.mentions()) {
      const unread = mentions.filter(message => !state.read[messageKey(message)]);
      const nav = document.querySelector('#navigation-inbox');
      if (nav) {
        let badge = nav.querySelector('.navigation-badge');
        if (!badge) { badge = element('span', 'navigation-badge'); badge.setAttribute('aria-hidden', 'true'); nav.append(badge); }
        badge.textContent = unread.length > 99 ? '99+' : String(unread.length); badge.hidden = !unread.length;
        nav.setAttribute('aria-label', unread.length ? `收件箱，${unread.length} 条未读` : '收件箱');
      }
      if (!this.panel || this.panel.hidden) return;
      if (this.scope !== this.key()) {
        this.scope = this.key(); this.limit = PAGE_SIZE; this.deletedTask = null; this.editingTask = null;
        this.buildContent();
      }
      if (this.kind === 'search') this.renderSearch();
      if (this.kind === 'inbox') this.renderInbox(state, mentions, unread);
      if (this.kind === 'tasks') this.renderTasks(state);
      this.renderStorageWarning();
    }

    renderStorageWarning() {
      this.warning.textContent = this.storageError || this.unsaved.has(this.key())
        ? '浏览器存储不可用或数据无法读取，改动仅在当前页面保留。' : '';
      this.warning.hidden = !this.warning.textContent;
    }

    ensurePanel() {
      if (this.panel) return;
      this.panel = element('section', 'sidebar-tools');
      this.panel.hidden = true;
      this.panel.id = 'sidebar-tools';
      this.panel.setAttribute('aria-labelledby', 'sidebar-tools-title');
      const header = element('header', 'chat-header tools-header');
      const menu = element('button', 'tools-menu');
      menu.type = 'button';
      menu.setAttribute('aria-label', '打开导航');
      menu.setAttribute('aria-controls', 'member-sidebar');
      menu.setAttribute('aria-expanded', 'false');
      const menuIcon = document.querySelector('.sidebar-toggle svg')?.cloneNode(true);
      if (menuIcon) menu.append(menuIcon);
      this.headerIcon = element('span', 'tools-header-icon');
      this.context = element('span', 'tools-room');
      this.title = element('h1'); this.title.id = 'sidebar-tools-title';
      const close = button('返回聊天', () => this.close(), 'tools-back'); close.setAttribute('aria-label', '返回聊天');
      header.append(menu, this.headerIcon, this.title, this.context, close);
      this.content = element('div', 'tools-content');
      this.body = element('div', 'tools-body');
      this.warning = element('p', 'tools-warning'); this.warning.setAttribute('role', 'status'); this.warning.hidden = true;
      this.body.append(this.warning, this.content);
      this.panel.append(header, this.body);
      this.panel.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !event.isComposing) {
          event.preventDefault(); event.stopPropagation(); this.close();
        }
      });
      this.ui.elements.main.append(this.panel);
    }

    open(kind) {
      if (!TITLES[kind]) return;
      this.ensurePanel();
      this.ui.closeMentionPicker({ restoreFocus: false });
      this.returnFocus = document.activeElement;
      if (this.panel.hidden) this.chatScrollTop = this.ui.elements.chatlog.scrollTop;
      document.querySelector(`#navigation-${this.kind}`)?.classList.remove('is-active');
      document.querySelector(`#navigation-${this.kind}`)?.removeAttribute('aria-current');
      this.kind = kind; this.scope = this.key(); this.limit = PAGE_SIZE; this.deletedTask = null; this.editingTask = null;
      this.buildContent();
      this.ui.closeNavigationDrawer?.();
      this.ui.elements.main.classList.add('tool-view');
      this.panel.hidden = false;
      this.body.scrollTop = 0;
      document.querySelector('#navigation-chat')?.removeAttribute('aria-current');
      document.querySelector(`#navigation-${kind}`)?.classList.add('is-active');
      document.querySelector(`#navigation-${kind}`)?.setAttribute('aria-current', 'page');
      this.refresh();
      (this.content.querySelector('input:not(:disabled), button:not(:disabled), summary') || this.panel.querySelector('button')).focus();
    }

    close(restoreFocus = true) {
      if (!this.panel || this.panel.hidden) return;
      clearTimeout(this.clockTick);
      this.panel.hidden = true;
      this.ui.elements.main.classList.remove('tool-view');
      this.ui.elements.chatlog.scrollTop = this.chatScrollTop || 0;
      document.querySelector(`#navigation-${this.kind}`)?.classList.remove('is-active');
      document.querySelector(`#navigation-${this.kind}`)?.removeAttribute('aria-current');
      document.querySelector('#navigation-chat')?.setAttribute('aria-current', 'page');
      if (restoreFocus) {
        const visible = node => node?.isConnected && node.getClientRects().length && !node.closest('[inert]');
        const navigation = document.querySelector(`#navigation-${this.kind}`);
        const target = visible(this.returnFocus) ? this.returnFocus
          : visible(navigation) ? navigation : document.querySelector('.sidebar-toggle');
        target?.focus({ preventScroll: true });
      }
      this.returnFocus = null;
    }

    buildContent() {
      clearTimeout(this.clockTick);
      this.selectedSlip = null;
      this.title.textContent = TITLES[this.kind];
      this.panel.dataset.tool = this.kind;
      this.context.textContent = this.ui.elements.roomName?.textContent || this.ui.currentRoom || '聊天室';
      this.headerIcon.replaceChildren(document.querySelector(`#navigation-${this.kind} > svg`).cloneNode(true));
      this.content.replaceChildren();
      if (this.kind === 'search') this.buildSearch();
      if (this.kind === 'inbox') this.buildInbox();
      if (this.kind === 'tasks') this.buildTasks();
      if (this.kind === 'help') this.buildHelp();
    }

    resultsList(renderMore = () => this.refresh()) {
      this.count = element('p', 'tools-count'); this.count.setAttribute('role', 'status');
      this.list = element('div', 'tools-results');
      this.list.tabIndex = -1;
      this.more = button('加载更多', () => {
        const previous = this.limit;
        this.limit += PAGE_SIZE; renderMore();
        this.list.children[previous]?.querySelector('button, input')?.focus();
      });
      this.content.append(this.count, this.list, this.more);
    }

    replaceResults(nodes, emptyText, count) {
      const focused = this.list.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
      this.list.replaceChildren(...(nodes.length ? nodes : [element('p', 'tools-empty', emptyText)]));
      this.more.hidden = count <= this.limit;
      if (focused) {
        const target = [...this.list.querySelectorAll('[data-focus]')].find(node => node.dataset.focus === focused);
        (target || this.list.querySelector('button, input') || this.list).focus({ preventScroll: true });
      }
    }

    preview(message) {
      return this.ui.extractPlainTextForReply(message.text).trim() || message.text;
    }

    messageRow(message, readState) {
      const row = element('article', 'tool-message');
      const key = messageKey(message);
      const unread = readState && !readState[key];
      row.classList.toggle('is-unread', !!unread);
      const jump = button('', () => this.jump(message, !!readState), 'tool-message-link');
      jump.dataset.focus = `jump:${key}`;
      const meta = element('span', 'tool-message-meta');
      meta.append(element('strong', '', message.user), element('time', '', this.ui.formatDate(message.timestamp)));
      const avatar = element('span', 'tool-message-avatar avatar');
      const fallback = this.ui.generateAvatar(message.user);
      avatar.classList.add(fallback.color); avatar.textContent = message.user.slice(0, 1);
      this.ui.profileUI.avatar(avatar, message.profile);
      const content = element('span', 'tool-message-content');
      content.append(meta, element('span', 'tool-message-preview', this.preview(message)));
      if (unread) meta.append(element('span', 'tool-unread-label', '未读'));
      jump.append(avatar, content);
      jump.title = '跳转到消息';
      row.append(jump);
      if (readState) {
        const toggle = button(unread ? '标为已读' : '标为未读', () => this.saveRead(read => {
          if (unread) read[key] = true; else delete read[key];
        }));
        toggle.dataset.focus = `read:${key}`; row.append(toggle);
      }
      return row;
    }

    jump(message, markRead) {
      const target = this.ui.messageIndex.get(message.timestamp);
      if (!target?.isConnected) {
        this.count.textContent = '这条消息尚未显示，请稍后重试。'; return;
      }
      if (markRead) this.saveRead(read => { read[messageKey(message)] = true; });
      this.returnFocus = null;
      this.close(); this.ui.closeNavigationDrawer?.();
      this.ui.isAtBottom = false; this.ui.updateUserActivityTime();
      target.tabIndex = -1; target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'center', behavior: global.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      target.classList.add('message-highlighted');
      setTimeout(() => target.classList.remove('message-highlighted'), 2000);
    }

    buildSearch() {
      const toolbar = element('div', 'tools-search-bar');
      this.query = field('关键词', 'search', 'tools-search-query', toolbar); this.query.placeholder = '搜索聊天记录';
      const icon = document.querySelector('#navigation-search > svg').cloneNode(true);
      this.query.parentElement.prepend(icon);
      const disclosure = element('details', 'tools-search-options');
      const summary = element('summary', '', '筛选');
      disclosure.append(summary);
      const filters = element('div', 'tools-filters');
      this.author = field('发送者', 'search', 'tools-search-author', filters); this.author.placeholder = '昵称或用户 ID';
      this.after = field('开始日期', 'date', 'tools-search-after', filters);
      this.before = field('结束日期', 'date', 'tools-search-before', filters);
      filters.addEventListener('input', () => { this.limit = PAGE_SIZE; this.renderSearch(); });
      this.query.addEventListener('input', () => { this.limit = PAGE_SIZE; this.renderSearch(); });
      filters.append(button('清除筛选', () => {
        for (const input of [this.query, this.author, this.after, this.before]) input.value = '';
        this.limit = PAGE_SIZE; this.renderSearch(); this.query.focus();
      }));
      disclosure.append(filters);
      this.content.append(toolbar, disclosure, element('p', 'tools-description', '当前房间 · 已加载的聊天记录'));
      this.resultsList();
    }

    renderSearch() {
      if (this.after.value && this.before.value && this.after.value > this.before.value) {
        this.count.textContent = '结束日期不能早于开始日期。';
        this.replaceResults([], '请调整日期范围。', 0); return;
      }
      const query = this.query.value.trim().toLocaleLowerCase();
      const author = this.author.value.trim().toLocaleLowerCase();
      const start = this.after.value ? new Date(`${this.after.value}T00:00:00`).getTime() : -Infinity;
      const end = this.before.value ? new Date(`${this.before.value}T23:59:59.999`).getTime() : Infinity;
      const results = this.messages().filter(message => message.timestamp >= start && message.timestamp <= end
        && (!query || `${message.text}\n${this.preview(message)}`.toLocaleLowerCase().includes(query))
        && (!author || `${message.user}\n${message.profile?.id || ''}`.toLocaleLowerCase().includes(author)))
        .sort((a, b) => b.timestamp - a.timestamp);
      this.count.textContent = `${results.length} 条结果 · 最新消息在前`;
      this.replaceResults(results.slice(0, this.limit).map(message => this.messageRow(message)), '没有找到匹配消息，试试其他关键词或筛选条件。', results.length);
    }

    filters(options, selected, onChange) {
      const group = element('div', 'tools-filter-buttons');
      for (const [value, label] of options) {
        const control = button(label, () => {
          for (const child of group.children) child.setAttribute('aria-pressed', String(child === control));
          this.limit = PAGE_SIZE; onChange(value);
        });
        control.setAttribute('aria-pressed', String(value === selected)); group.append(control);
      }
      return group;
    }

    buildInbox() {
      this.content.append(element('p', 'tools-description', '提及你的消息，都在这里。'));
      const toolbar = element('div', 'tools-inbox-toolbar');
      toolbar.append(this.filters([['all', '全部提醒'], ['unread', '只看未读']], this.inboxFilter, value => { this.inboxFilter = value; this.refresh(); }));
      this.markAll = button('全部标为已读', () => this.saveRead((read, mentions) => {
        for (const message of mentions) read[messageKey(message)] = true;
      }));
      toolbar.append(this.markAll); this.content.append(toolbar); this.resultsList();
    }

    renderInbox(state, mentions, unread) {
      const results = this.inboxFilter === 'unread' ? unread : mentions;
      this.markAll.disabled = !unread.length;
      this.count.textContent = `${unread.length} 条未读 · ${mentions.length} 条提醒`;
      this.replaceResults(results.slice(0, this.limit).map(message => this.messageRow(message, state.read)),
        !this.key() ? '连接聊天室后即可查看提及你的消息。' : this.inboxFilter === 'unread' ? '没有未读提醒。' : '还没有提及你的消息。', results.length);
    }

    buildTasks() {
      const bench = element('div', 'task-bench');
      this.taskForm = element('form', 'order-pad'); this.taskForm.id = 'task-order-pad'; this.taskForm.hidden = true;
      const terminalHead = element('header', 'order-terminal-head');
      terminalHead.append(element('span', '', '任务录入'));
      this.terminalState = element('span', 'order-terminal-state'); terminalHead.append(this.terminalState);
      const screen = element('div', 'order-terminal-screen');
      this.orderPreview = element('section', 'order-display'); this.orderPreview.setAttribute('aria-label', '待印内容');
      const entry = element('div', 'order-entry');
      this.padTitle = element('h2', '', '新任务'); entry.append(this.padTitle);
      const keyboard = element('div', 'order-keyboard');
      screen.append(this.orderPreview, entry, keyboard);
      this.taskForm.append(terminalHead, screen);
      this.taskForm.addEventListener('input', () => this.renderOrderPreview());
      this.paperMode = 'black';
      this.paperSelector = element('fieldset', 'paper-selector');
      this.paperSelector.append(element('legend', '', '添加任务'));
      for (const [value, text] of [['black', '黑单 · 任务'], ['red', '红单 · 贴条']]) {
        const label = element('label');
        const radio = element('input'); radio.type = 'radio'; radio.name = 'task-paper'; radio.value = value; radio.checked = value === 'black';
        radio.addEventListener('change', () => this.setPaperMode(value));
        label.append(radio, element('span', '', text)); this.paperSelector.append(label);
      }
      keyboard.append(this.paperSelector);
      const desk = element('div', 'task-desk-head');
      this.openPad = button('添加任务', () => { this.setTaskFormOpen(true); this.taskTitle.focus(); }, 'task-pad-toggle');
      this.openPad.prepend(taskIcon('edit')); this.openPad.setAttribute('aria-controls', this.taskForm.id); this.openPad.setAttribute('aria-expanded', 'false');
      const deskCopy = element('div', 'task-desk-copy');
      deskCopy.append(element('h2', '', '任务台'), element('p', '', '记下接下来要做的事。'));
      desk.append(deskCopy, this.openPad, element('span', 'task-local', '仅保存在此浏览器'));
      const printer = element('section', 'task-printer'); printer.setAttribute('aria-label', '任务出单机');
      const face = element('div', 'task-faceplate');
      face.append(element('h2', '', '添加任务'));
      this.printerState = element('span', 'task-printer-state'); face.append(this.printerState);
      const fields = element('div', 'task-fields');
      this.taskTitle = field('任务标题', 'text', 'tools-task-title', fields); this.taskTitle.maxLength = 200; this.taskTitle.required = true;
      this.taskTitle.placeholder = '接下来要做什么？';
      this.taskDue = field('截止日期（可选）', 'date', 'tools-task-due', fields);
      const options = element('details', 'task-options');
      options.append(element('summary', '', '操作人和清单'));
      const extra = element('div', 'task-fields');
      this.operator = field('操作人', 'text', 'task-operator', extra); this.operator.maxLength = 60;
      this.operator.value = this.read().operator || this.ui.currentUser?.displayName || '';
      const itemLabel = element('label', 'tool-field', '清单（每行一项）');
      this.items = element('textarea'); this.items.rows = 2; this.items.maxLength = 3630;
      itemLabel.append(this.items); extra.append(itemLabel); options.append(extra);
      this.orderOptions = options;
      const deck = element('div', 'task-printer-deck');
      const lid = element('div', 'printer-cover');
      lid.setAttribute('role', 'img'); lid.setAttribute('aria-label', '出单机');
      this.output = element('div', 'device-pocket printer-mouth');
      printer.append(lid, this.output, face);
      this.taskSubmit = element('button', 'task-issue'); this.taskSubmit.type = 'submit';
      this.issueLabel = element('span', '', '交印'); this.taskSubmit.append(taskIcon('printer'), this.issueLabel);
      this.cancelEdit = button('收起', () => { this.resetTaskForm(); this.openPad.focus(); });
      deck.append(this.cancelEdit, this.taskSubmit); entry.append(fields, options); keyboard.append(deck);
      const clock = element('section', 'task-clock'); clock.setAttribute('aria-label', '打卡钟');
      const clockFace = element('div', 'task-faceplate'); clockFace.append(element('h2', '', '打卡钟'));
      const clockBody = element('div','recorder-body');
      const {dial, set} = clockDial(); clockBody.append(dial);
      let lastDay;
      const tick = () => {
        const now = new Date(); set(now);
        const today = localDate(now);
        if (lastDay && lastDay !== today) this.renderTasks(this.read());
        lastDay = today; this.clockTick = setTimeout(tick, 60000 - now.getTime() % 60000);
      };
      tick();
      this.throat = element('div', 'device-pocket clock-throat');
      clock.append(clockBody, this.throat, clockFace); bench.append(printer, clock);
      this.bindTicketDrop(clock, id => this.stampTicket(id));
      this.stationNotice = element('p', 'task-station-notice'); this.stationNotice.setAttribute('role', 'status');
      this.taskForm.addEventListener('submit', event => {
        event.preventDefault();
        const title = this.taskTitle.value.trim();
        if (!title) { this.taskTitle.setCustomValidity('请输入任务标题。'); this.taskTitle.reportValidity(); return; }
        const id = this.editingTask;
        const state = this.read();
        if (id && !state.tasks.some(task => task.id === id)) { this.count.textContent = '该任务已在其他标签页删除，请取消编辑。'; return; }
        const red = this.paperMode === 'red' && !id;
        if (!id && (red ? (state.slips || []).length : state.tasks.length) >= 200) { this.count.textContent = '已达到 200 张上限，请先整理。'; return; }
        const lines = this.items.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (!red && (lines.length > 30 || lines.some(line => line.length > 120))) {
          this.items.setCustomValidity('最多 30 项，每项最多 120 字。'); options.open = true; this.items.reportValidity(); return;
        }
        if (!id && (state.tasks.some(task => task.station === 'printer') || (state.slips || []).some(s => s.station === 'printer'))) {
          this.stationNotice.textContent = '出纸口有一张待取的单。取单后可继续交印。';
          this.output.querySelector('button')?.focus(); return;
        }
        this.saveTasks(next => {
          if (red) {
            (next.slips ||= []).push({id:crypto.randomUUID(), text:title, at:Date.now(), station:'printer'});
            return;
          }
          let task = next.tasks.find(task => task.id === id);
          if (!id) {
            const now = Date.now();
            next.sequence = (next.sequence || 0) + 1;
            task = { id: crypto.randomUUID(), number: next.sequence, done: false, createdAt: now, station: 'printer', startedAt: null, sessions: [], notes: [] };
            next.tasks.unshift(task); next.operator = this.operator.value.trim();
          }
          if (!task) return;
          task.title = title; task.due = this.taskDue.value; task.operator = this.operator.value.trim();
          const previous = [...(task.items || [])];
          task.items = lines.map(text => {
            const index = previous.findIndex(item => item.text === text);
            return index < 0 ? { text, checked: false } : previous.splice(index, 1)[0];
          });
        });
        this.resetTaskForm();
        (id ? this.openPad : this.output.querySelector('button'))?.focus();
      });
      this.taskTitle.addEventListener('input', () => this.taskTitle.setCustomValidity(''));
      this.items.addEventListener('input', () => this.items.setCustomValidity(''));
      const rack = element('div', 'task-rack-heading');
      rack.append(element('h2', '', '任务轨道'));
      const toolbar = element('div', 'task-toolbar');
      this.taskFilters = this.filters([['all', '全部任务'], ['active', '未完成'], ['done', '已完成']], this.taskFilter,
        value => { this.taskFilter = value; this.renderTasks(this.read()); this.list.scrollLeft = 0; });
      this.slipTray = element('section', 'loose-slips'); this.slipTray.setAttribute('aria-label', '待贴红单');
      const stationHead = element('div', 'task-station-head');
      stationHead.append(desk, bench);
      toolbar.append(this.taskFilters); this.content.append(stationHead, this.taskForm, this.stationNotice, this.slipTray, rack, toolbar);
      this.undo = button('撤销删除', () => {
        const task = this.deletedTask;
        if (!task) return;
        this.saveTasks(state => {
          if (state.tasks.length >= 200) return;
          if (!state.tasks.some(existing => existing.id === task.id)) state.tasks.unshift(task);
          this.deletedTask = null;
        });
        if (this.undo.hidden) (this.list.querySelector('input') || this.taskTitle).focus();
      });
      this.undo.prepend(taskIcon('undo')); this.undo.hidden = true; toolbar.append(this.undo);
      this.resultsList(() => this.renderTasks(this.read())); rack.append(this.count);
      this.list.setAttribute('aria-label', '任务轨道');
      this.list.tabIndex = 0;
      const rail = element('div', 'rail-drive');
      const left = button('‹', () => this.list.scrollBy({left:-220, behavior:this.scrollBehavior()}), 'rail-wheel');
      left.setAttribute('aria-label','向左转动轨道');
      const right = button('›', () => this.list.scrollBy({left:220, behavior:this.scrollBehavior()}), 'rail-wheel');
      right.setAttribute('aria-label','向右转动轨道');
      const grip = element('div', 'rail-grip'); grip.title = '左右拖动横杆，或转动两侧滚轮';
      let drag;
      grip.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        drag = {x:event.clientX, scroll:this.list.scrollLeft}; grip.setPointerCapture(event.pointerId);
      });
      grip.addEventListener('pointermove', event => {
        if (drag) this.list.scrollLeft = drag.scroll + drag.x - event.clientX;
      });
      const release = () => { drag = null; };
      grip.addEventListener('pointerup', release); grip.addEventListener('pointercancel', release);
      grip.addEventListener('lostpointercapture', release);
      rail.addEventListener('wheel', event => {
        if (event.ctrlKey || this.list.scrollWidth <= this.list.clientWidth) return;
        event.preventDefault(); this.list.scrollLeft += event.deltaY + event.deltaX;
      }, {passive:false});
      this.list.addEventListener('keydown', event => {
        if (event.target !== this.list || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        event.preventDefault();
        if (event.key === 'Home' || event.key === 'End') this.list.scrollLeft = event.key === 'Home' ? 0 : this.list.scrollWidth;
        else this.list.scrollBy({left:event.key === 'ArrowLeft' ? -160 : 160, behavior:this.scrollBehavior()});
      });
      rail.append(left,grip,right); this.list.before(rail);
      this.drawer = element('details', 'file-drawer');
      const handle = element('summary'); handle.append(element('span', 'drawer-label', '归档抽屉'));
      this.drawerTotal = element('span', 'drawer-total'); handle.append(this.drawerTotal);
      this.drawerBin = element('div', 'drawer-bin'); this.drawer.append(handle, this.drawerBin);
      this.drawer.addEventListener('toggle', () => { if (this.kind === 'tasks' && this.drawer.open) this.renderDrawer(this.read()); });
      this.bindTicketDrop(handle, id => this.fileTicket(id));
      this.content.append(this.drawer);

    }

    setTaskFormOpen(open) {
      this.taskForm.hidden = !open;
      this.openPad.setAttribute('aria-expanded', String(open));
      if (open) this.renderOrderPreview();
    }

    resetTaskForm() {
      this.editingTask = null; this.taskForm.reset(); this.taskTitle.setCustomValidity('');
      this.items.setCustomValidity(''); this.orderOptions.open = false;
      this.operator.value = this.read().operator || this.ui.currentUser?.displayName || '';
      this.issueLabel.textContent = '交印'; this.setPaperMode('black'); this.paperSelector.hidden = false; this.setTaskFormOpen(false);
    }

    scrollBehavior() {
      return global.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
    }

    setPaperMode(mode) {
      this.paperMode = mode;
      for (const input of this.paperSelector.querySelectorAll('input')) input.checked = input.value === mode;
      this.items.setCustomValidity('');
      this.taskForm.dataset.ink = mode;
      this.padTitle.textContent = mode === 'red' ? '红单' : '新任务';
      this.taskTitle.parentElement.querySelector('.tool-field-label').textContent = mode === 'red' ? '红单内容' : '任务标题';
      this.taskTitle.placeholder = mode === 'red' ? '写下要贴的补充、修改或提醒…' : '接下来要做什么？';
      this.taskDue.parentElement.hidden = mode === 'red';
      this.orderOptions.hidden = mode === 'red';
      this.renderOrderPreview();
    }

    renderOrderPreview(state = this.read()) {
      const red = this.paperMode === 'red';
      const editing = state.tasks.find(task => task.id === this.editingTask);
      const head = element('div', 'order-display-head');
      head.append(element('span', '', editing ? '修改中' : '待印内容'),
        element('span', '', red ? '红单' : ticketNumber(editing || {number:(state.sequence || 0) + 1})));
      const title = element('h3', 'order-preview-title', this.taskTitle.value.trim() || (red ? '等待输入补充…' : '等待输入任务…'));
      const meta = element('div', 'order-preview-meta');
      if (!red) {
        meta.append(element('span', '', this.operator.value.trim() || '未署名'));
        if (this.taskDue.value) meta.append(element('span', '', '截止 ' + this.taskDue.value));
      }
      const lines = element('ol', 'order-preview-items');
      if (!red) for (const text of this.items.value.split(/\r?\n/).map(text => text.trim()).filter(Boolean)) lines.append(element('li', '', text));
      this.orderPreview.replaceChildren(head, title, meta, lines);
      const waiting = state.tasks.some(task => task.station === 'printer') || state.slips?.some(slip => slip.station === 'printer');
      this.terminalState.textContent = !this.key() ? '未连接' : editing ? '修改已存任务' : waiting ? '出单机 · 待取单' : '出单机 · 就绪';
      this.terminalState.dataset.state = !this.key() ? 'offline' : waiting && !editing ? 'waiting' : 'ready';
    }

    bindTicketDrop(node, receive) {
      const type = 'application/x-nightcord-ticket';
      node.addEventListener('dragover', event => {
        if (event.dataTransfer.types.includes(type) && this.dragScope === this.key()) {
          event.preventDefault(); node.classList.add('ticket-drop-target');
        }
      });
      node.addEventListener('dragleave', () => node.classList.remove('ticket-drop-target'));
      node.addEventListener('drop', event => {
        node.classList.remove('ticket-drop-target');
        const id = event.dataTransfer.getData(type);
        if (id && this.dragScope === this.key()) { event.preventDefault(); receive(id); }
      });
    }

    showRackTicket(id) {
      this.taskFilters.firstElementChild.click();
      const row = [...this.list.children].find(node => node.dataset.task === id);
      row?.scrollIntoView({block:'nearest', inline:'nearest', behavior:this.scrollBehavior()});
      row?.querySelector('.ticket-transfer')?.focus({preventScroll:true});
    }

    hangTicket(id, source) {
      this.saveTasks(state => {
        const task = state.tasks.find(item => item.id === id);
        if (!task) return;
        if (source === 'drawer' ? !task.archived : (task.station || 'rail') !== source) return;
        task.station = null;
        if (source !== 'clock') resume(task, Date.now());
      });
      this.stationNotice.textContent = ''; this.showRackTicket(id);
    }

    stampTicket(id) {
      this.saveTasks(state => {
        const task = state.tasks.find(item => item.id === id);
        if (!task || !onRail(task) || task.done) return;
        if (state.tasks.some(item => item.station === 'clock')) {
          this.stationNotice.textContent = '钟口还有已盖印的单，请先取回。'; return;
        }
        punch(task, Date.now()); task.station = 'clock';
        this.stationNotice.textContent = '';
      });
      this.throat.querySelector('button')?.focus();
    }

    fileTicket(id) {
      this.saveTasks(state => {
        const task = state.tasks.find(item => item.id === id);
        if (!task || task.archived || !task.done) {
          this.stationNotice.textContent = '请先给进行中的任务打卡。'; return;
        }
        task.station = null; task.archived = true;
        this.stationNotice.textContent = '';
      });
      this.drawer.querySelector('summary').focus();
    }

    redSlip(slip, draggable = true) {
      const paper = element('div', 'red-slip');
      paper.append(element('span', 'red-slip-label', '红单'), element('p', '', slip.text));
      const footer = element('div', 'red-slip-footer');
      if (slip.at) footer.append(imprint(slip.at));
      paper.append(footer);
      if (draggable) {
        paper.draggable = true; paper.title = '拖到任务上贴好';
        paper.addEventListener('dragstart', event => {
          this.dragScope = this.key(); event.dataTransfer.setData('application/x-nightcord-red-slip',slip.id);
          event.dataTransfer.effectAllowed = 'move';
        });
        paper.addEventListener('dragend', () => {
          this.dragScope = null;
          this.content.querySelectorAll('.ticket-drop-target').forEach(node => node.classList.remove('ticket-drop-target'));
        });
      }
      return paper;
    }

    attachSlip(id, taskId) {
      let attached = false;
      this.saveTasks(state => {
        const task = state.tasks.find(task => task.id === taskId);
        const slip = state.slips?.find(slip => slip.id === id);
        if (!task || !slip) return;
        (task.notes ||= []).push({id:slip.id, text:slip.text, at:slip.at});
        state.slips = state.slips.filter(s => s.id !== id);
        this.selectedSlip = null; attached = true;
      });
      this.stationNotice.textContent = attached ? '红单已贴好。' : '这张红单或任务已在其他页面移走。';
      if (attached) [...this.content.querySelectorAll('.tool-task')].find(node => node.dataset.task === taskId)?.querySelector('.ticket-transfer')?.focus({preventScroll:true});
    }

    bindSlipDrop(node, taskId) {
      const type = 'application/x-nightcord-red-slip';
      node.addEventListener('dragover', event => {
        if (event.dataTransfer.types.includes(type) && this.dragScope === this.key()) {
          event.preventDefault(); node.classList.add('ticket-drop-target');
        }
      });
      node.addEventListener('dragleave', () => node.classList.remove('ticket-drop-target'));
      node.addEventListener('drop', event => {
        node.classList.remove('ticket-drop-target');
        const id = event.dataTransfer.getData(type);
        if (id && this.dragScope === this.key()) { event.preventDefault(); event.stopPropagation(); this.attachSlip(id,taskId); }
      });
    }

    renderLooseSlips(state) {
      const slips = (state.slips || []).filter(s => s.station !== 'printer');
      const focused = this.slipTray.contains(document.activeElement) ? document.activeElement.closest('.loose-slip')?.dataset.slip : null;
      if (!slips.some(s => s.id === this.selectedSlip)) this.selectedSlip = null;
      this.slipTray.hidden = !slips.length;
      this.slipTray.replaceChildren();
      if (!slips.length) return;
      this.slipTray.append(element('p','slip-tray-hint','把红单拖到任务上，或选择后点“贴在这里”。'));
      for (const slip of slips) {
        const holder = element('div','loose-slip'); holder.classList.toggle('is-selected',this.selectedSlip === slip.id);
        const choose = button(this.selectedSlip === slip.id ? '放回' : '选择这张红单', () => {
          this.selectedSlip = this.selectedSlip === slip.id ? null : slip.id; this.renderTasks(this.read());
          [...this.slipTray.querySelectorAll('.loose-slip')].find(node => node.dataset.slip === slip.id)?.querySelector('button')?.focus({preventScroll:true});
        }, 'tool-button');
        holder.dataset.slip = slip.id;
        choose.setAttribute('aria-pressed',String(this.selectedSlip === slip.id));
        holder.append(this.redSlip(slip), choose); this.slipTray.append(holder);
      }
      if (focused) [...this.slipTray.querySelectorAll('.loose-slip')].find(node => node.dataset.slip === focused)?.querySelector('button')?.focus({preventScroll:true});
    }

    renderPocket(pocket, task, station, red = false) {
      const signature = task ? JSON.stringify([task,red]) : '';
      if (pocket.dataset.signature === signature) return;
      pocket.dataset.signature = signature; pocket.replaceChildren();
      if (!task) return;
      const tray = element('div', 'pocket-sheet');
      tray.append(red ? this.redSlip(task) : this.taskSheet(task, false));
      const choices = element('div', 'pocket-choices');
      choices.append(button(red ? '取下红单' : station === 'printer' ? '取单上轨' : '取回挂单', () => {
        if (!red) { this.hangTicket(task.id, station); return; }
        this.saveTasks(state => {
          const slip = state.slips?.find(s => s.id === task.id);
          if (slip) { slip.station = 'loose'; this.selectedSlip = slip.id; }
        });
        this.slipTray.querySelector('button')?.focus();
      }, 'pocket-action'));
      if (station === 'clock') choices.append(button('收入抽屉', () => this.fileTicket(task.id), 'pocket-action'));
      pocket.append(tray, choices);
    }

    renderDrawer(state) {
      const filed = state.tasks.filter(task => task.archived);
      this.drawerTotal.textContent = filed.length + ' 张';
      if (!this.drawer.open) return;
      const focus = this.drawerBin.contains(document.activeElement) && document.activeElement.dataset.focus;
      this.drawerBin.replaceChildren(...(filed.length ? filed.map(task => this.taskTicket(task)) : [element('p', '', '抽屉是空的。')]));
      if (focus) [...this.drawerBin.querySelectorAll('[data-focus]')].find(node => node.dataset.focus === focus)?.focus({preventScroll:true});
    }

    moveTicket(id, beforeId) {
      if (id === beforeId) return;
      this.saveTasks(state => {
        const source = state.tasks.findIndex(task => task.id === id);
        if (source < 0 || !state.tasks.some(task => task.id === beforeId)) return;
        const [task] = state.tasks.splice(source, 1);
        state.tasks.splice(state.tasks.findIndex(item => item.id === beforeId), 0, task);
      });
    }

    renderTasks(state) {
      const available = !!this.key();
      for (const control of this.taskForm.elements) control.disabled = !available;
      this.openPad.disabled = !available;
      if (!this.taskForm.hidden) this.renderOrderPreview(state);
      const hanging = state.tasks.filter(onRail);
      const printed = state.tasks.find(task => task.station === 'printer');
      const redPrinted = (state.slips || []).find(s => s.station === 'printer');
      const stamped = state.tasks.find(task => task.station === 'clock');
      this.renderPocket(this.output, printed || redPrinted, 'printer', !printed && !!redPrinted); this.renderPocket(this.throat, stamped, 'clock');
      this.renderLooseSlips(state);
      this.renderDrawer(state);
      this.printerState.textContent = !available ? '未连接' : printed || redPrinted ? '待取单' : '就绪';
      this.printerState.classList.toggle('is-ready', available);
      this.count.textContent = available ? `轨上 ${hanging.length} 张` : '连接聊天室后即可管理自己的任务。';
      this.undo.hidden = !this.deletedTask; this.undo.disabled = state.tasks.length >= 200;
      const tasks = hanging.filter(task => this.taskFilter === 'all' || (this.taskFilter === 'done') === task.done);
      const rows = tasks.map((task, i) => this.taskTicket(task, tasks[i - 1]?.id));
      const empty = this.taskFilter === 'active' ? '没有未完成的任务。' : this.taskFilter === 'done' ? '没有已完成的任务。' : '轨道空着。';
      const scroll = this.list.scrollLeft;
      this.replaceResults(rows, available ? empty : '任务会在身份确认后显示。', tasks.length);
      this.list.scrollLeft = scroll; this.more.hidden = true;
    }

    ticketPaper(task, interactive) {
      const paper = element('div', 'kitchen-ticket');
      const head = element('header', 'ticket-head');
      head.append(element('span', 'ticket-station', this.context.textContent || '任务'),
        element('strong', 'ticket-number', ticketNumber(task)));
      const title = element('h3', 'tool-task-title', task.title);
      const meta = element('div', 'ticket-meta');
      const identity = element('div', 'ticket-identity');
      const status = element('span', 'ticket-state', task.done ? '已完成' : task.startedAt ? '进行中' : '待处理');
      status.dataset.state = task.done ? 'done' : task.startedAt ? 'active' : 'pending';
      identity.append(element('span', '', task.operator || '—'),
        status);
      meta.append(identity);
      if (task.createdAt) { const issued = element('div', 'ticket-issued'); issued.append(imprint(task.createdAt)); meta.append(issued); }
      paper.append(head, title, meta);
      for (const [i,item] of (task.items || []).entries()) {
        if (!interactive) { paper.append(element('div','ticket-item',item.text)); continue; }
        const label = element('label','ticket-item');
        const check = element('input'); check.type = 'checkbox'; check.checked = item.checked; check.dataset.focus = `item:${task.id}:${i}`;
        check.addEventListener('change', () => this.saveTasks(state => {
          const entry = state.tasks.find(t => t.id === task.id)?.items?.[i];
          if (entry?.text === item.text) entry.checked = check.checked;
        }));
        label.append(check, element('span','',item.text)); paper.append(label);
      }
      if (task.due) {
        const overdue = !task.done && task.due < localDate(new Date());
        const due = element('div','tool-task-date','截止 ' + task.due + (overdue ? ' · 已逾期' : ''));
        due.classList.toggle('is-overdue', overdue); paper.append(due);
      }
      for (const note of task.notes || []) {
        const attached = element('div','ticket-amendment');
        const slip = this.redSlip(note, false); attached.append(slip);
        if (interactive) {
          const detach = button('取下', () => this.saveTasks(state => {
            const current = state.tasks.find(t => t.id === task.id);
            const index = current?.notes.findIndex(n => n.id === note.id && n.text === note.text && n.at === note.at) ?? -1;
            if (index < 0 || (state.slips || []).length >= 200) return;
            const [removed] = current.notes.splice(index,1);
            (state.slips ||= []).push({...removed, id:removed.id || crypto.randomUUID(), station:'loose'});
          }), 'slip-detach');
          detach.setAttribute('aria-label', '取下红单：' + note.text);
          slip.querySelector('.red-slip-footer').append(detach);
        }
        paper.append(attached);
      }
      return paper;
    }

    taskSheet(task, interactive) {
      const sheet = element('div', 'task-sheet');
      sheet.append(this.ticketPaper(task, interactive), timeCard(task));
      return sheet;
    }

    taskTicket(task, previousId) {
      const row = element('article', 'tool-task'); row.dataset.task = task.id;
      const sheet = this.taskSheet(task, true);
      const paper = sheet.querySelector('.kitchen-ticket');
      const head = paper.querySelector('.ticket-head');
      if (!task.archived) {
        const hanger = element('span', 'ticket-hanger');
        hanger.setAttribute('aria-hidden', 'true'); hanger.draggable = true;
        hanger.title = '拖动夹子可移动任务'; row.append(hanger);
        head.draggable = true; head.title = '拖动单头可排序、打卡或归档';
        const startDrag = event => {
          this.dragScope = this.key(); event.dataTransfer.setData('application/x-nightcord-ticket', task.id);
          event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setDragImage(row, 15, 12);
        };
        const endDrag = () => { this.dragScope = null; this.content.querySelectorAll('.ticket-drop-target').forEach(node => node.classList.remove('ticket-drop-target')); };
        for (const handle of [head, hanger]) {
          handle.addEventListener('dragstart', startDrag); handle.addEventListener('dragend', endDrag);
        }
        this.bindTicketDrop(row, id => this.moveTicket(id, task.id));
      }
      this.bindSlipDrop(row, task.id);
      if (this.selectedSlip) {
        const attach = button('贴在这里', () => this.attachSlip(this.selectedSlip, task.id), 'slip-attach');
        paper.prepend(attach);
      }
      const actions = element('footer', 'tool-task-actions');
      const transfer = button(task.archived ? '取出并重新计时' : task.done ? '再次开工' : '送入打卡钟', () => {
        if (task.done) this.hangTicket(task.id, task.archived ? 'drawer' : 'rail'); else this.stampTicket(task.id);
      }, 'ticket-transfer');
      transfer.dataset.focus = `task:${task.id}`;
      transfer.prepend(taskIcon(task.done ? 'undo' : 'stamp'));
      const edit = button('', () => {
        this.editingTask = task.id; this.taskTitle.value = task.title; this.taskDue.value = task.due;
        this.operator.value = task.operator || ''; this.items.value = (task.items || []).map(item => item.text).join('\n');
        this.setPaperMode('black'); this.paperSelector.hidden = true; this.orderOptions.open = true;
        this.setTaskFormOpen(true); this.padTitle.textContent = '修改任务'; this.issueLabel.textContent = '保存修改'; this.taskTitle.focus();
      }); edit.dataset.focus = `edit:${task.id}`; edit.title = '编辑'; edit.setAttribute('aria-label', '编辑'); edit.append(taskIcon('edit'));
      const remove = button('', () => {
        this.deletedTask = task;
        this.saveTasks(state => { state.tasks = state.tasks.filter(item => item.id !== task.id); });
        if (this.editingTask === task.id) this.resetTaskForm();
        this.undo.focus();
      }); remove.dataset.focus = `remove:${task.id}`; remove.title = '删除'; remove.setAttribute('aria-label', `删除任务：${task.title}`); remove.append(taskIcon('trash'));
      actions.append(transfer, edit, remove);
      const filing = element('div', 'ticket-filing');
      if (!task.archived) {
        if (task.done) {
          const archive = button('放进抽屉', () => this.fileTicket(task.id));
          archive.dataset.focus = `file:${task.id}`; filing.append(archive);
        }
        if (previousId) {
          const move = button('前移一位', () => this.moveTicket(task.id, previousId));
          move.dataset.focus = `move:${task.id}`; filing.append(move);
        }
      }
      const controls = element('div', 'ticket-controls'); controls.append(actions, filing);
      row.append(sheet, controls); return row;
    }

    buildHelp() {
      this.content.append(element('p', 'tools-description', '关于 Nightcord，你可能想知道的事。'));
      const search = field('搜索帮助', 'search', 'tools-help-query', this.content);
      search.placeholder = '搜索帮助内容';
      const results = element('div', 'tools-help'); results.id = 'tools-help-results'; search.setAttribute('aria-controls', results.id);
      const repo = 'https://github.com/25-ji-code-de/nightcord';
      const legalDocs = 'https://docs.nightcord.de5.net/legal/complete';
      const legalLinks = element('p', 'tools-links');
      legalLinks.append(
        externalLink('用户协议', `${legalDocs}/terms-nightcord`),
        externalLink('隐私政策', `${legalDocs}/privacy-nightcord`),
        externalLink('版权声明', `${repo}/blob/main/README.md#版权声明`),
        externalLink('开源许可', `${repo}/blob/main/LICENSE`),
      );
      const contact = element('p');
      contact.append('如果您是权利人，认为站内内容侵犯了您的权益，请通过 ', externalLink('GitHub Issues', `${repo}/issues`), ' 联系维护者，并附上相关内容的位置。');
      const entries = HELP.map(([title, text]) => helpEntry(title, element('p', '', text)));
      const disclaimer = helpEntry('免责声明',
          element('p', '', 'Nightcord 是受《Project SEKAI》启发的非官方、非商业粉丝作品，与 SEGA、Colorful Palette、Crypton Future Media 等权利方无官方关联。'),
          element('p', '', '角色、贴纸、音乐和音效等游戏素材的版权归各自权利人所有。若要转载或商用这些素材，请遵守权利方的授权要求。AGPL-3.0-only 开源许可仅适用于 Nightcord 的原创代码。'),
          element('p', '', '本服务按现状提供。有关服务中断、数据丢失等情形的责任限制及例外，请参阅「法律条款」中的用户协议。'),
          contact,
          element('p', 'tools-legal-note', '使用本网站即表示您已阅读并同意上述条款。'),
      );
      disclaimer.dataset.keywords = 'Disclaimer';
      entries.push(helpEntry('法律条款', legalLinks), disclaimer);
      const render = () => {
        const query = search.value.trim().toLocaleLowerCase();
        results.replaceChildren();
        for (const detail of entries) {
          const searchable = [detail.textContent, detail.dataset.keywords].join(' ').toLocaleLowerCase();
          if (!searchable.includes(query)) continue;
          detail.open = !!query;
          results.append(detail);
        }
        if (!results.children.length) results.append(element('p', 'tools-empty', '没有匹配的帮助内容。'));
      };
      search.addEventListener('input', render); this.content.append(results); render();
      const links = element('p', 'tools-links');
      links.append(externalLink('项目文档', `${repo}#readme`), externalLink('反馈问题', `${repo}/issues`));
      this.content.append(links);
    }
  }
  global.SidebarFeatures = SidebarFeatures;
})(window);
