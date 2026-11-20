/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** TaskSlipView: taskSlips component; sidebar supplies shared presentation context. */
const TaskSlipView = (() => {
const { element, button, imprint } = SidebarHelpers;
return class TaskSlipView {
  constructor(sidebar) { this.sidebar = sidebar; }

  redSlip(slip, draggable = true) {
    const paper = element('div', 'red-slip');
    paper.append(element('span', 'red-slip-label', '红单'), element('p', '', slip.text));
    const footer = element('div', 'red-slip-footer');
    if (slip.at) footer.append(imprint(slip.at));
    paper.append(footer);
    if (draggable) {
      paper.draggable = true; paper.title = '拖到任务上贴好';
      paper.addEventListener('dragstart', event => {
        this.sidebar.dragScope = this.sidebar.key(); event.dataTransfer.setData('application/x-nightcord-red-slip',slip.id);
        event.dataTransfer.effectAllowed = 'move';
      });
      paper.addEventListener('dragend', () => {
        this.sidebar.dragScope = null;
        this.sidebar.content.querySelectorAll('.ticket-drop-target').forEach(node => node.classList.remove('ticket-drop-target'));
      });
    }
    return paper;
  }

  attachSlip(id, taskId) {
    let attached = false;
    this.sidebar.saveTasks(state => {
      const task = state.tasks.find(task => task.id === taskId);
      const slip = state.slips?.find(slip => slip.id === id);
      if (!task || !slip) return;
      (task.notes ||= []).push({id:slip.id, text:slip.text, at:slip.at});
      state.slips = state.slips.filter(s => s.id !== id);
      this.sidebar.selectedSlip = null; attached = true;
    });
    this.sidebar.stationNotice.textContent = attached ? '红单已贴好。' : '这张红单或任务已在其他页面移走。';
    if (attached) [...this.sidebar.content.querySelectorAll('.tool-task')].find(node => node.dataset.task === taskId)?.querySelector('.ticket-transfer')?.focus({preventScroll:true});
  }

  bindSlipDrop(node, taskId) {
    const type = 'application/x-nightcord-red-slip';
    node.addEventListener('dragover', event => {
      if (event.dataTransfer.types.includes(type) && this.sidebar.dragScope === this.sidebar.key()) {
        event.preventDefault(); node.classList.add('ticket-drop-target');
      }
    });
    node.addEventListener('dragleave', () => node.classList.remove('ticket-drop-target'));
    node.addEventListener('drop', event => {
      node.classList.remove('ticket-drop-target');
      const id = event.dataTransfer.getData(type);
      if (id && this.sidebar.dragScope === this.sidebar.key()) { event.preventDefault(); event.stopPropagation(); this.attachSlip(id,taskId); }
    });
  }

  renderLooseSlips(state) {
    const slips = (state.slips || []).filter(s => s.station !== 'printer');
    const focused = this.sidebar.slipTray.contains(document.activeElement) ? document.activeElement.closest('.loose-slip')?.dataset.slip : null;
    if (!slips.some(s => s.id === this.sidebar.selectedSlip)) this.sidebar.selectedSlip = null;
    this.sidebar.slipTray.hidden = !slips.length;
    this.sidebar.slipTray.replaceChildren();
    if (!slips.length) return;
    this.sidebar.slipTray.append(element('p','slip-tray-hint','把红单拖到任务上，或选择后点“贴在这里”。'));
    for (const slip of slips) {
      const holder = element('div','loose-slip'); holder.classList.toggle('is-selected',this.sidebar.selectedSlip === slip.id);
      const choose = button(this.sidebar.selectedSlip === slip.id ? '放回' : '选择这张红单', () => {
        this.sidebar.selectedSlip = this.sidebar.selectedSlip === slip.id ? null : slip.id; this.sidebar.renderTasks(this.sidebar.read());
        [...this.sidebar.slipTray.querySelectorAll('.loose-slip')].find(node => node.dataset.slip === slip.id)?.querySelector('button')?.focus({preventScroll:true});
      }, 'tool-button');
      holder.dataset.slip = slip.id;
      choose.setAttribute('aria-pressed',String(this.sidebar.selectedSlip === slip.id));
      holder.append(this.redSlip(slip), choose); this.sidebar.slipTray.append(holder);
    }
    if (focused) [...this.sidebar.slipTray.querySelectorAll('.loose-slip')].find(node => node.dataset.slip === focused)?.querySelector('button')?.focus({preventScroll:true});
  }
};
})();
