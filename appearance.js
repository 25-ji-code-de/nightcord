/* SPDX-License-Identifier: AGPL-3.0-only */
(() => {
  'use strict';

  const key = 'nightcord-palette';
  const memberListKey = 'nightcord-member-list';
  const palettes = { 'gray-purple': { name: '灰紫', canvas: '#50476a' }, indigo: { name: '靛蓝', canvas: '#3d4070' } };
  const memberLists = { current: '新版', classic: '旧版' };
  const normalize = value => Object.hasOwn(palettes, value) ? value : 'gray-purple';
  const normalizeMemberList = value => Object.hasOwn(memberLists, value) ? value : 'classic';
  const read = (storageKey = key, validate = normalize) => {
    try { return validate(localStorage.getItem(storageKey)); }
    catch { return validate(null); }
  };
  const apply = value => {
    const palette = normalize(value);
    document.documentElement.dataset.palette = palette;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palettes[palette].canvas);
    return palette;
  };

  // Run before styles and the first paint, including when storage is blocked.
  apply(read());
  const applyMemberList = value => {
    const memberList = normalizeMemberList(value);
    document.documentElement.dataset.memberList = memberList;
    return memberList;
  };
  applyMemberList(read(memberListKey, normalizeMemberList));

  document.addEventListener('DOMContentLoaded', () => {
    const trigger = document.querySelector('#navigation-settings');
    const dialog = document.querySelector('#appearance-settings-template')?.content.querySelector('dialog').cloneNode(true);
    if (!trigger || !dialog) return;
    const options = [...dialog.querySelectorAll('input[name="nightcord-palette"]')];
    const memberListOptions = [...dialog.querySelectorAll('input[name="nightcord-member-list"]')];
    const status = dialog.querySelector('#palette-status');
    const sync = palette => options.forEach(option => { option.checked = option.value === palette; });
    const syncMemberList = value => memberListOptions.forEach(option => { option.checked = option.value === value; });
    let previousFocus;
    sync(document.documentElement.dataset.palette);
    syncMemberList(document.documentElement.dataset.memberList);

    trigger.addEventListener('click', () => {
      if (dialog.open) return;
      previousFocus = document.activeElement;
      document.body.appendChild(dialog);
      dialog.showModal();
      options.find(option => option.checked)?.focus({ preventScroll: true });
    });
    dialog.querySelector('.settings-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dialog.close();
        return;
      }
      if (event.key !== 'Tab') return;
      // A native radio group contributes only the selected option to Tab order.
      const first = dialog.querySelector('.settings-close');
      const last = memberListOptions.find(option => option.checked);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    let startedOutside = false;
    const outside = event => {
      const bounds = dialog.getBoundingClientRect();
      return event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom);
    };
    dialog.addEventListener('pointerdown', event => { startedOutside = outside(event); });
    dialog.addEventListener('click', event => { if (startedOutside && outside(event)) dialog.close(); });
    dialog.addEventListener('close', () => {
      dialog.remove();
      const target = previousFocus?.isConnected && !previousFocus.closest('[inert]')
        ? previousFocus : document.querySelector('.sidebar-toggle');
      target?.focus({ preventScroll: true });
    });
    for (const option of options) {
      option.addEventListener('change', () => {
        if (!option.checked) return;
        const palette = apply(option.value);
        try {
          localStorage.setItem(key, palette);
          status.textContent = `已切换为 ${palettes[palette].name} 配色，已自动保存。`;
        } catch {
          status.textContent = `已切换为 ${palettes[palette].name} 配色；此浏览器无法保存，刷新后会恢复默认。`;
        }
      });
    }
    for (const option of memberListOptions) {
      option.addEventListener('change', () => {
        if (!option.checked) return;
        const memberList = applyMemberList(option.value);
        try {
          localStorage.setItem(memberListKey, memberList);
          status.textContent = `成员列表已切换为${memberLists[memberList]}，已自动保存。`;
        } catch {
          status.textContent = `成员列表已切换为${memberLists[memberList]}；此浏览器无法保存，刷新后会恢复默认。`;
        }
      });
    }
    window.addEventListener('storage', event => {
      if (event.key === key || event.key === null) {
        const palette = apply(read());
        sync(palette);
        status.textContent = `当前配色：${palettes[palette].name}。`;
      }
      if (event.key === memberListKey || event.key === null) {
        const memberList = applyMemberList(read(memberListKey, normalizeMemberList));
        syncMemberList(memberList);
        status.textContent = `成员列表：${memberLists[memberList]}。`;
      }
    });
  }, { once: true });
})();
