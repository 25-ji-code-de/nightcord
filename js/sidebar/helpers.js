/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
const SidebarHelpers = (() => {
const TITLES = { search: '搜索', inbox: '收件箱', tasks: '任务', help: '帮助' };
const PAGE_SIZE = 50;
const HELP = [
  ['搜索聊天记录', '输入关键词进行搜索；您可以按发送者或日期进行筛选，点击搜索结果即可跳转至原始消息。搜索范围涵盖当前聊天窗口中已加载的聊天记录（包括保存在您浏览器本地的数据），但不包含尚未加载的服务器端记录。您可以使用 Ctrl / ⌘ + K 快捷键快速打开搜索功能。'],
  ['收件箱与回复、@ 提及', '收件箱会汇总当前聊天室中回复你、提及你或“@everyone”的消息，可按类型或未读筛选。你发送的消息以及 AI 的回复不包含在内。同一条消息即使既回复又提及你，也只收录一次。仅打开收件箱不会清除未读计数；点击消息可标为已读，也可手动调整。已读状态保存在当前浏览器。'],
  ['提醒、声音与关注', '未查看最新消息时，新消息会显示可跳转的悬浮卡片，连续消息合并计数。设置中的“声音与免打扰”调整总音量、静音和暂停；“消息提醒”分别设置新消息、回复和提及的提醒与声音；“成员动态与关注”管理上线、下线提醒和关注列表。各类音效可在对应分类中试听，暂停不影响收件箱记录。设置与关注按当前身份和聊天室保存，锁屏或关闭网页后暂不推送。'],
  ['管理我的任务', '点击“添加任务”打开录入终端，选择“黑单 · 任务”或“红单 · 贴条”，核对内容后交印。黑单取出上轨后开始计时，送入打卡钟结束本段；取回后可再次开工或收入抽屉。红单可拖到任务上，也可选中后点击“贴在这里”，并支持取下重贴。拖动横杆、横向滑动或转动两侧滚轮可查看其他任务。任务与工时记录在同一张卡上，累计工时保留已结束的各段。数据按房间和身份保存在当前浏览器，清除站点数据会删除这些内容。'],
  ['发送消息、表情与附件', '按“回车键”（Enter）发送消息，按“Shift + 回车键”换行；每条消息最多可包含 256 个字符。输入“@”可选择成员或 AI，输入“::”可选择表情符号。使用输入框旁边的附件按钮，可以上传图片、音乐或文件。点击消息上的回复按钮，即可引用原消息。'],
  ['账号和成员资料', '点击成员的头像或昵称，即可查看其个人资料。您可以通过点击侧边栏底部的个人头像来修改访客昵称，也可以前往“SEKAI Pass”编辑您的账户详情。访客身份基于浏览器 Cookie；即使昵称相同，也会被视为不同的身份。'],
  ['语音聊天', '语音聊天功能目前可在测试房间及默认房间中使用，需登录 SEKAI Pass 账号。进入语音聊天后，您可以控制麦克风、收听他人发言或退出通话；请务必授予浏览器访问麦克风的权限。侧边栏中的摄像头图标目前仅用于显示状态。'],
  ['外观与导航', '点击齿轮图标可进入设置界面。“外观与布局”集中调整配色、成员列表、圆角和 iOS 适配；电脑端可通过左侧分类进入声音与免打扰、消息提醒或成员动态与关注。使用双箭头图标可展开或收起成员列表；选择“首页”（Home）则可返回至聊天界面的底部。搜索、收件箱、任务和帮助等功能会在主内容区域内打开；您可以按下 Esc 键或点击“返回聊天”选项以退出当前页面。'],
  ['连接或保存失败', '如果连接中断，系统会自动尝试恢复。若您无法发送数据，请等待连接恢复；如果登录会话已过期，请重新登录。若收到无法保存数据的提示，请检查网站存储功能是否已被禁用，或存储空间是否已满；任何未保存的任务或“已读”状态更新，仅在当前页面会话期间有效。'],
  ['私信', '私信由站点开放后可用，双方需要登录 SEKAI Pass。点击成员资料卡中的“发私信”，先发送一条介绍，待对方接受后继续交流。“拒收消息”会阻止对方发送，并在发送时提示对方；“隐藏会话”只隐藏内容和提醒，新消息仍会保存，恢复显示后可查看。历史、已读和隐藏状态跨设备同步，正文与草稿不保存到浏览器本地，草稿刷新后消失。普通聊天室消息仍对房间成员可见。'],
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


return { TITLES, PAGE_SIZE, HELP, element, button, helpEntry, externalLink, field, messageKey, validDate, timestamp, pad, localDate, localTime, durationText, listOf, safeText, punch, resume, imprint, taskIcon, clockDial, ticketNumber, timeCard, onRail };
})();
