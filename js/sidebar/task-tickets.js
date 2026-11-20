/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** TaskTicketView: taskTickets component; sidebar supplies shared presentation context. */
const TaskTicketView = (() => {
const { element, button, localDate, punch, resume, imprint, taskIcon, ticketNumber, timeCard, onRail } = SidebarHelpers;
return class TaskTicketView {
  constructor(sidebar) { this.sidebar = sidebar; }

  bindTicketDrop(node, receive) {
    const type = 'application/x-nightcord-ticket';
    node.addEventListener('dragover', event => {
      if (event.dataTransfer.types.includes(type) && this.sidebar.dragScope === this.sidebar.key()) {
        event.preventDefault(); node.classList.add('ticket-drop-target');
      }
    });
    node.addEventListener('dragleave', () => node.classList.remove('ticket-drop-target'));
    node.addEventListener('drop', event => {
      node.classList.remove('ticket-drop-target');
      const id = event.dataTransfer.getData(type);
      if (id && this.sidebar.dragScope === this.sidebar.key()) { event.preventDefault(); receive(id); }
    });
  }

  showRackTicket(id) {
    this.sidebar.taskFilters.firstElementChild.click();
    const row = [...this.sidebar.list.children].find(node => node.dataset.task === id);
    row?.scrollIntoView({block:'nearest', inline:'nearest', behavior:this.sidebar.scrollBehavior()});
    row?.querySelector('.ticket-transfer')?.focus({preventScroll:true});
  }

  hangTicket(id, source) {
    this.sidebar.saveTasks(state => {
      const task = state.tasks.find(item => item.id === id);
      if (!task) return;
      if (source === 'drawer' ? !task.archived : (task.station || 'rail') !== source) return;
      task.station = null;
      if (source !== 'clock') resume(task, Date.now());
    });
    this.sidebar.stationNotice.textContent = ''; this.showRackTicket(id);
  }

  stampTicket(id) {
    this.sidebar.saveTasks(state => {
      const task = state.tasks.find(item => item.id === id);
      if (!task || !onRail(task) || task.done) return;
      if (state.tasks.some(item => item.station === 'clock')) {
        this.sidebar.stationNotice.textContent = '钟口还有已盖印的单，请先取回。'; return;
      }
      punch(task, Date.now()); task.station = 'clock';
      this.sidebar.stationNotice.textContent = '';
    });
    this.sidebar.throat.querySelector('button')?.focus();
  }

  fileTicket(id) {
    this.sidebar.saveTasks(state => {
      const task = state.tasks.find(item => item.id === id);
      if (!task || task.archived || !task.done) {
        this.sidebar.stationNotice.textContent = '请先给进行中的任务打卡。'; return;
      }
      task.station = null; task.archived = true;
      this.sidebar.stationNotice.textContent = '';
    });
    this.sidebar.drawer.querySelector('summary').focus();
  }

  renderPocket(pocket, task, station, red = false) {
    const signature = task ? JSON.stringify([task,red]) : '';
    if (pocket.dataset.signature === signature) return;
    pocket.dataset.signature = signature; pocket.replaceChildren();
    if (!task) return;
    const tray = element('div', 'pocket-sheet');
    tray.append(red ? this.sidebar.redSlip(task) : this.taskSheet(task, false));
    const choices = element('div', 'pocket-choices');
    choices.append(button(red ? '取下红单' : station === 'printer' ? '取单上轨' : '取回挂单', () => {
      if (!red) { this.hangTicket(task.id, station); return; }
      this.sidebar.saveTasks(state => {
        const slip = state.slips?.find(s => s.id === task.id);
        if (slip) { slip.station = 'loose'; this.sidebar.selectedSlip = slip.id; }
      });
      this.sidebar.slipTray.querySelector('button')?.focus();
    }, 'pocket-action'));
    if (station === 'clock') choices.append(button('收入抽屉', () => this.fileTicket(task.id), 'pocket-action'));
    pocket.append(tray, choices);
  }

  renderDrawer(state) {
    const filed = state.tasks.filter(task => task.archived);
    this.sidebar.drawerTotal.textContent = filed.length + ' 张';
    if (!this.sidebar.drawer.open) return;
    const focus = this.sidebar.drawerBin.contains(document.activeElement) && document.activeElement.dataset.focus;
    this.sidebar.drawerBin.replaceChildren(...(filed.length ? filed.map(task => this.taskTicket(task)) : [element('p', '', '抽屉是空的。')]));
    if (focus) [...this.sidebar.drawerBin.querySelectorAll('[data-focus]')].find(node => node.dataset.focus === focus)?.focus({preventScroll:true});
  }

  moveTicket(id, beforeId) {
    if (id === beforeId) return;
    this.sidebar.saveTasks(state => {
      const source = state.tasks.findIndex(task => task.id === id);
      if (source < 0 || !state.tasks.some(task => task.id === beforeId)) return;
      const [task] = state.tasks.splice(source, 1);
      state.tasks.splice(state.tasks.findIndex(item => item.id === beforeId), 0, task);
    });
  }

  renderTasks(state) {
    const available = !!this.sidebar.key();
    for (const control of this.sidebar.taskForm.elements) control.disabled = !available;
    this.sidebar.openPad.disabled = !available;
    if (!this.sidebar.taskForm.hidden) this.sidebar.renderOrderPreview(state);
    const hanging = state.tasks.filter(onRail);
    const printed = state.tasks.find(task => task.station === 'printer');
    const redPrinted = (state.slips || []).find(s => s.station === 'printer');
    const stamped = state.tasks.find(task => task.station === 'clock');
    this.renderPocket(this.sidebar.output, printed || redPrinted, 'printer', !printed && !!redPrinted); this.renderPocket(this.sidebar.throat, stamped, 'clock');
    this.sidebar.renderLooseSlips(state);
    this.renderDrawer(state);
    this.sidebar.printerState.textContent = !available ? '未连接' : printed || redPrinted ? '待取单' : '就绪';
    this.sidebar.printerState.classList.toggle('is-ready', available);
    this.sidebar.count.textContent = available ? `轨上 ${hanging.length} 张` : '连接聊天室后即可管理自己的任务。';
    this.sidebar.undo.hidden = !this.sidebar.deletedTask; this.sidebar.undo.disabled = state.tasks.length >= 200;
    const tasks = hanging.filter(task => this.sidebar.taskFilter === 'all' || (this.sidebar.taskFilter === 'done') === task.done);
    const rows = tasks.map((task, i) => this.taskTicket(task, tasks[i - 1]?.id));
    const empty = this.sidebar.taskFilter === 'active' ? '没有未完成的任务。' : this.sidebar.taskFilter === 'done' ? '没有已完成的任务。' : '轨道空着。';
    const scroll = this.sidebar.list.scrollLeft;
    this.sidebar.replaceResults(rows, available ? empty : '任务会在身份确认后显示。', tasks.length);
    this.sidebar.list.scrollLeft = scroll; this.sidebar.more.hidden = true;
  }

  ticketPaper(task, interactive) {
    const paper = element('div', 'kitchen-ticket');
    const head = element('header', 'ticket-head');
    head.append(element('span', 'ticket-station', this.sidebar.context.textContent || '任务'),
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
      check.addEventListener('change', () => this.sidebar.saveTasks(state => {
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
      const slip = this.sidebar.redSlip(note, false); attached.append(slip);
      if (interactive) {
        const detach = button('取下', () => this.sidebar.saveTasks(state => {
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
        this.sidebar.dragScope = this.sidebar.key(); event.dataTransfer.setData('application/x-nightcord-ticket', task.id);
        event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setDragImage(row, 15, 12);
      };
      const endDrag = () => { this.sidebar.dragScope = null; this.sidebar.content.querySelectorAll('.ticket-drop-target').forEach(node => node.classList.remove('ticket-drop-target')); };
      for (const handle of [head, hanger]) {
        handle.addEventListener('dragstart', startDrag); handle.addEventListener('dragend', endDrag);
      }
      this.bindTicketDrop(row, id => this.moveTicket(id, task.id));
    }
    this.sidebar.bindSlipDrop(row, task.id);
    if (this.sidebar.selectedSlip) {
      const attach = button('贴在这里', () => this.sidebar.attachSlip(this.sidebar.selectedSlip, task.id), 'slip-attach');
      paper.prepend(attach);
    }
    const actions = element('footer', 'tool-task-actions');
    const transfer = button(task.archived ? '取出并重新计时' : task.done ? '再次开工' : '送入打卡钟', () => {
      if (task.done) this.hangTicket(task.id, task.archived ? 'drawer' : 'rail'); else this.stampTicket(task.id);
    }, 'ticket-transfer');
    transfer.dataset.focus = `task:${task.id}`;
    transfer.prepend(taskIcon(task.done ? 'undo' : 'stamp'));
    const edit = button('', () => {
      this.sidebar.editingTask = task.id; this.sidebar.taskTitle.value = task.title; this.sidebar.taskDue.value = task.due;
      this.sidebar.operator.value = task.operator || ''; this.sidebar.items.value = (task.items || []).map(item => item.text).join('\n');
      this.sidebar.setPaperMode('black'); this.sidebar.paperSelector.hidden = true; this.sidebar.orderOptions.open = true;
      this.sidebar.setTaskFormOpen(true); this.sidebar.padTitle.textContent = '修改任务'; this.sidebar.issueLabel.textContent = '保存修改'; this.sidebar.taskTitle.focus();
    }); edit.dataset.focus = `edit:${task.id}`; edit.title = '编辑'; edit.setAttribute('aria-label', '编辑'); edit.append(taskIcon('edit'));
    const remove = button('', () => {
      this.sidebar.deletedTask = task;
      this.sidebar.saveTasks(state => { state.tasks = state.tasks.filter(item => item.id !== task.id); });
      if (this.sidebar.editingTask === task.id) this.sidebar.resetTaskForm();
      this.sidebar.undo.focus();
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
};
})();
