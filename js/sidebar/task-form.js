/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** TaskFormView: taskForm component; sidebar supplies shared presentation context. */
const TaskFormView = (() => {
const { element, button, field, pad, localDate, taskIcon, clockDial, ticketNumber } = SidebarHelpers;
return class TaskFormView {
  constructor(sidebar) { this.sidebar = sidebar; }

  buildTasks() {
    const bench = element('div', 'task-bench');
    this.sidebar.taskForm = element('form', 'order-pad'); this.sidebar.taskForm.id = 'task-order-pad'; this.sidebar.taskForm.hidden = true;
    const terminalHead = element('header', 'order-terminal-head');
    terminalHead.append(element('span', '', '任务录入'));
    this.sidebar.terminalState = element('span', 'order-terminal-state'); terminalHead.append(this.sidebar.terminalState);
    const screen = element('div', 'order-terminal-screen');
    this.sidebar.orderPreview = element('section', 'order-display'); this.sidebar.orderPreview.setAttribute('aria-label', '待印内容');
    const entry = element('div', 'order-entry');
    this.sidebar.padTitle = element('h2', '', '新任务'); entry.append(this.sidebar.padTitle);
    const keyboard = element('div', 'order-keyboard');
    screen.append(this.sidebar.orderPreview, entry, keyboard);
    this.sidebar.taskForm.append(terminalHead, screen);
    this.sidebar.taskForm.addEventListener('input', () => this.renderOrderPreview());
    this.sidebar.paperMode = 'black';
    this.sidebar.paperSelector = element('fieldset', 'paper-selector');
    this.sidebar.paperSelector.append(element('legend', '', '添加任务'));
    for (const [value, text] of [['black', '黑单 · 任务'], ['red', '红单 · 贴条']]) {
      const label = element('label');
      const radio = element('input'); radio.type = 'radio'; radio.name = 'task-paper'; radio.value = value; radio.checked = value === 'black';
      radio.addEventListener('change', () => this.setPaperMode(value));
      label.append(radio, element('span', '', text)); this.sidebar.paperSelector.append(label);
    }
    keyboard.append(this.sidebar.paperSelector);
    const desk = element('div', 'task-desk-head');
    this.sidebar.openPad = button('添加任务', () => { this.setTaskFormOpen(true); this.sidebar.taskTitle.focus(); }, 'task-pad-toggle');
    this.sidebar.openPad.prepend(taskIcon('edit')); this.sidebar.openPad.setAttribute('aria-controls', this.sidebar.taskForm.id); this.sidebar.openPad.setAttribute('aria-expanded', 'false');
    const deskCopy = element('div', 'task-desk-copy');
    deskCopy.append(element('h2', '', '任务台'), element('p', '', '记下接下来要做的事。'));
    desk.append(deskCopy, this.sidebar.openPad, element('span', 'task-local', '仅保存在此浏览器'));
    const printer = element('section', 'task-printer'); printer.setAttribute('aria-label', '任务出单机');
    const face = element('div', 'task-faceplate');
    face.append(element('h2', '', '添加任务'));
    this.sidebar.printerState = element('span', 'task-printer-state'); face.append(this.sidebar.printerState);
    const fields = element('div', 'task-fields');
    this.sidebar.taskTitle = field('任务标题', 'text', 'tools-task-title', fields); this.sidebar.taskTitle.maxLength = 200; this.sidebar.taskTitle.required = true;
    this.sidebar.taskTitle.placeholder = '接下来要做什么？';
    this.sidebar.taskDue = field('截止日期（可选）', 'date', 'tools-task-due', fields);
    const options = element('details', 'task-options');
    options.append(element('summary', '', '操作人和清单'));
    const extra = element('div', 'task-fields');
    this.sidebar.operator = field('操作人', 'text', 'task-operator', extra); this.sidebar.operator.maxLength = 60;
    this.sidebar.operator.value = this.sidebar.read().operator || this.sidebar.ui.currentUser?.displayName || '';
    const itemLabel = element('label', 'tool-field', '清单（每行一项）');
    this.sidebar.items = element('textarea'); this.sidebar.items.rows = 2; this.sidebar.items.maxLength = 3630;
    itemLabel.append(this.sidebar.items); extra.append(itemLabel); options.append(extra);
    this.sidebar.orderOptions = options;
    const deck = element('div', 'task-printer-deck');
    const lid = element('div', 'printer-cover');
    lid.setAttribute('role', 'img'); lid.setAttribute('aria-label', '出单机');
    this.sidebar.output = element('div', 'device-pocket printer-mouth');
    printer.append(lid, this.sidebar.output, face);
    this.sidebar.taskSubmit = element('button', 'task-issue'); this.sidebar.taskSubmit.type = 'submit';
    this.sidebar.issueLabel = element('span', '', '交印'); this.sidebar.taskSubmit.append(taskIcon('printer'), this.sidebar.issueLabel);
    this.sidebar.cancelEdit = button('收起', () => { this.resetTaskForm(); this.sidebar.openPad.focus(); });
    deck.append(this.sidebar.cancelEdit, this.sidebar.taskSubmit); entry.append(fields, options); keyboard.append(deck);
    const clock = element('section', 'task-clock'); clock.setAttribute('aria-label', '打卡钟');
    const clockFace = element('div', 'task-faceplate'); clockFace.append(element('h2', '', '打卡钟'));
    const clockBody = element('div','recorder-body');
    const {dial, set} = clockDial(); clockBody.append(dial);
    let lastDay;
    const tick = () => {
      const now = new Date(); set(now);
      const today = localDate(now);
      if (lastDay && lastDay !== today) this.sidebar.renderTasks(this.sidebar.read());
      lastDay = today; this.sidebar.clockTick = setTimeout(tick, 60000 - now.getTime() % 60000);
    };
    tick();
    this.sidebar.throat = element('div', 'device-pocket clock-throat');
    clock.append(clockBody, this.sidebar.throat, clockFace); bench.append(printer, clock);
    this.sidebar.bindTicketDrop(clock, id => this.sidebar.stampTicket(id));
    this.sidebar.stationNotice = element('p', 'task-station-notice'); this.sidebar.stationNotice.setAttribute('role', 'status');
    this.sidebar.taskForm.addEventListener('submit', event => {
      event.preventDefault();
      const title = this.sidebar.taskTitle.value.trim();
      if (!title) { this.sidebar.taskTitle.setCustomValidity('请输入任务标题。'); this.sidebar.taskTitle.reportValidity(); return; }
      const id = this.sidebar.editingTask;
      const state = this.sidebar.read();
      if (id && !state.tasks.some(task => task.id === id)) { this.sidebar.count.textContent = '该任务已在其他标签页删除，请取消编辑。'; return; }
      const red = this.sidebar.paperMode === 'red' && !id;
      if (!id && (red ? (state.slips || []).length : state.tasks.length) >= 200) { this.sidebar.count.textContent = '已达到 200 张上限，请先整理。'; return; }
      const lines = this.sidebar.items.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      if (!red && (lines.length > 30 || lines.some(line => line.length > 120))) {
        this.sidebar.items.setCustomValidity('最多 30 项，每项最多 120 字。'); options.open = true; this.sidebar.items.reportValidity(); return;
      }
      if (!id && (state.tasks.some(task => task.station === 'printer') || (state.slips || []).some(s => s.station === 'printer'))) {
        this.sidebar.stationNotice.textContent = '出纸口有一张待取的单。取单后可继续交印。';
        this.sidebar.output.querySelector('button')?.focus(); return;
      }
      this.sidebar.saveTasks(next => {
        if (red) {
          (next.slips ||= []).push({id:crypto.randomUUID(), text:title, at:Date.now(), station:'printer'});
          return;
        }
        let task = next.tasks.find(task => task.id === id);
        if (!id) {
          const now = Date.now();
          next.sequence = (next.sequence || 0) + 1;
          task = { id: crypto.randomUUID(), number: next.sequence, done: false, createdAt: now, station: 'printer', startedAt: null, sessions: [], notes: [] };
          next.tasks.unshift(task); next.operator = this.sidebar.operator.value.trim();
        }
        if (!task) return;
        task.title = title; task.due = this.sidebar.taskDue.value; task.operator = this.sidebar.operator.value.trim();
        const previous = [...(task.items || [])];
        task.items = lines.map(text => {
          const index = previous.findIndex(item => item.text === text);
          return index < 0 ? { text, checked: false } : previous.splice(index, 1)[0];
        });
      });
      this.resetTaskForm();
      (id ? this.sidebar.openPad : this.sidebar.output.querySelector('button'))?.focus();
    });
    this.sidebar.taskTitle.addEventListener('input', () => this.sidebar.taskTitle.setCustomValidity(''));
    this.sidebar.items.addEventListener('input', () => this.sidebar.items.setCustomValidity(''));
    const rack = element('div', 'task-rack-heading');
    rack.append(element('h2', '', '任务轨道'));
    const toolbar = element('div', 'task-toolbar');
    this.sidebar.taskFilters = this.sidebar.filters([['all', '全部任务'], ['active', '未完成'], ['done', '已完成']], this.sidebar.taskFilter,
      value => { this.sidebar.taskFilter = value; this.sidebar.renderTasks(this.sidebar.read()); this.sidebar.list.scrollLeft = 0; });
    this.sidebar.slipTray = element('section', 'loose-slips'); this.sidebar.slipTray.setAttribute('aria-label', '待贴红单');
    const stationHead = element('div', 'task-station-head');
    stationHead.append(desk, bench);
    toolbar.append(this.sidebar.taskFilters); this.sidebar.content.append(stationHead, this.sidebar.taskForm, this.sidebar.stationNotice, this.sidebar.slipTray, rack, toolbar);
    this.sidebar.undo = button('撤销删除', () => {
      const task = this.sidebar.deletedTask;
      if (!task) return;
      this.sidebar.saveTasks(state => {
        if (state.tasks.length >= 200) return;
        if (!state.tasks.some(existing => existing.id === task.id)) state.tasks.unshift(task);
        this.sidebar.deletedTask = null;
      });
      if (this.sidebar.undo.hidden) (this.sidebar.list.querySelector('input') || this.sidebar.taskTitle).focus();
    });
    this.sidebar.undo.prepend(taskIcon('undo')); this.sidebar.undo.hidden = true; toolbar.append(this.sidebar.undo);
    this.sidebar.resultsList(() => this.sidebar.renderTasks(this.sidebar.read())); rack.append(this.sidebar.count);
    this.sidebar.list.setAttribute('aria-label', '任务轨道');
    this.sidebar.list.tabIndex = 0;
    const rail = element('div', 'rail-drive');
    const left = button('‹', () => this.sidebar.list.scrollBy({left:-220, behavior:this.scrollBehavior()}), 'rail-wheel');
    left.setAttribute('aria-label','向左转动轨道');
    const right = button('›', () => this.sidebar.list.scrollBy({left:220, behavior:this.scrollBehavior()}), 'rail-wheel');
    right.setAttribute('aria-label','向右转动轨道');
    const grip = element('div', 'rail-grip'); grip.title = '左右拖动横杆，或转动两侧滚轮';
    let drag;
    grip.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      drag = {x:event.clientX, scroll:this.sidebar.list.scrollLeft}; grip.setPointerCapture(event.pointerId);
    });
    grip.addEventListener('pointermove', event => {
      if (drag) this.sidebar.list.scrollLeft = drag.scroll + drag.x - event.clientX;
    });
    const release = () => { drag = null; };
    grip.addEventListener('pointerup', release); grip.addEventListener('pointercancel', release);
    grip.addEventListener('lostpointercapture', release);
    rail.addEventListener('wheel', event => {
      if (event.ctrlKey || this.sidebar.list.scrollWidth <= this.sidebar.list.clientWidth) return;
      event.preventDefault(); this.sidebar.list.scrollLeft += event.deltaY + event.deltaX;
    }, {passive:false});
    this.sidebar.list.addEventListener('keydown', event => {
      if (event.target !== this.sidebar.list || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home' || event.key === 'End') this.sidebar.list.scrollLeft = event.key === 'Home' ? 0 : this.sidebar.list.scrollWidth;
      else this.sidebar.list.scrollBy({left:event.key === 'ArrowLeft' ? -160 : 160, behavior:this.scrollBehavior()});
    });
    rail.append(left,grip,right); this.sidebar.list.before(rail);
    this.sidebar.drawer = element('details', 'file-drawer');
    const handle = element('summary'); handle.append(element('span', 'drawer-label', '归档抽屉'));
    this.sidebar.drawerTotal = element('span', 'drawer-total'); handle.append(this.sidebar.drawerTotal);
    this.sidebar.drawerBin = element('div', 'drawer-bin'); this.sidebar.drawer.append(handle, this.sidebar.drawerBin);
    this.sidebar.drawer.addEventListener('toggle', () => { if (this.sidebar.kind === 'tasks' && this.sidebar.drawer.open) this.sidebar.renderDrawer(this.sidebar.read()); });
    this.sidebar.bindTicketDrop(handle, id => this.sidebar.fileTicket(id));
    this.sidebar.content.append(this.sidebar.drawer);

  }

  setTaskFormOpen(open) {
    this.sidebar.taskForm.hidden = !open;
    this.sidebar.openPad.setAttribute('aria-expanded', String(open));
    if (open) this.renderOrderPreview();
  }

  resetTaskForm() {
    this.sidebar.editingTask = null; this.sidebar.taskForm.reset(); this.sidebar.taskTitle.setCustomValidity('');
    this.sidebar.items.setCustomValidity(''); this.sidebar.orderOptions.open = false;
    this.sidebar.operator.value = this.sidebar.read().operator || this.sidebar.ui.currentUser?.displayName || '';
    this.sidebar.issueLabel.textContent = '交印'; this.setPaperMode('black'); this.sidebar.paperSelector.hidden = false; this.setTaskFormOpen(false);
  }

  scrollBehavior() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
  }

  setPaperMode(mode) {
    this.sidebar.paperMode = mode;
    for (const input of this.sidebar.paperSelector.querySelectorAll('input')) input.checked = input.value === mode;
    this.sidebar.items.setCustomValidity('');
    this.sidebar.taskForm.dataset.ink = mode;
    this.sidebar.padTitle.textContent = mode === 'red' ? '红单' : '新任务';
    this.sidebar.taskTitle.parentElement.querySelector('.tool-field-label').textContent = mode === 'red' ? '红单内容' : '任务标题';
    this.sidebar.taskTitle.placeholder = mode === 'red' ? '写下要贴的补充、修改或提醒…' : '接下来要做什么？';
    this.sidebar.taskDue.parentElement.hidden = mode === 'red';
    this.sidebar.orderOptions.hidden = mode === 'red';
    this.renderOrderPreview();
  }

  renderOrderPreview(state = this.sidebar.read()) {
    const red = this.sidebar.paperMode === 'red';
    const editing = state.tasks.find(task => task.id === this.sidebar.editingTask);
    const head = element('div', 'order-display-head');
    head.append(element('span', '', editing ? '修改中' : '待印内容'),
      element('span', '', red ? '红单' : ticketNumber(editing || {number:(state.sequence || 0) + 1})));
    const title = element('h3', 'order-preview-title', this.sidebar.taskTitle.value.trim() || (red ? '等待输入补充…' : '等待输入任务…'));
    const meta = element('div', 'order-preview-meta');
    if (!red) {
      meta.append(element('span', '', this.sidebar.operator.value.trim() || '未署名'));
      if (this.sidebar.taskDue.value) meta.append(element('span', '', '截止 ' + this.sidebar.taskDue.value));
    }
    const lines = element('ol', 'order-preview-items');
    if (!red) for (const text of this.sidebar.items.value.split(/\r?\n/).map(text => text.trim()).filter(Boolean)) lines.append(element('li', '', text));
    this.sidebar.orderPreview.replaceChildren(head, title, meta, lines);
    const waiting = state.tasks.some(task => task.station === 'printer') || state.slips?.some(slip => slip.station === 'printer');
    this.sidebar.terminalState.textContent = !this.sidebar.key() ? '未连接' : editing ? '修改已存任务' : waiting ? '出单机 · 待取单' : '出单机 · 就绪';
    this.sidebar.terminalState.dataset.state = !this.sidebar.key() ? 'offline' : waiting && !editing ? 'waiting' : 'ready';
  }
};
})();
