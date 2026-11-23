/* SPDX-License-Identifier: AGPL-3.0-only */
(() => {
  'use strict';

  const key = 'nightcord-palette';
  const memberListKey = 'nightcord-member-list';
  const roundedCornersKey = 'nightcord-rounded-corners';
  const iosLayoutKey = 'nightcord-ios-layout';
  const palettes = {
    'gray-purple': { name: '灰紫', canvas: '#50476a' },
    indigo: { name: '靛蓝', canvas: '#3d4070' },
    'plum-orchid': { name: '兰紫', canvas: '#3f3352' }
  };
  const memberLists = { current: '新版', classic: '旧版' };
  const normalize = value => Object.hasOwn(palettes, value) ? value : 'gray-purple';
  const normalizeMemberList = value => Object.hasOwn(memberLists, value) ? value : 'classic';
  const normalizeRoundedCorners = value => value === 'off' ? 'off' : 'on';
  // iPadOS can identify as desktop Safari; touch-capable MacIntel is an iPad.
  const isIOSDevice = /iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const normalizeIOSLayout = value => value === 'on' || value === 'off' ? value : isIOSDevice ? 'on' : 'off';
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
  const applyRoundedCorners = value => {
    const roundedCorners = normalizeRoundedCorners(value);
    document.documentElement.dataset.roundedCorners = roundedCorners;
    return roundedCorners;
  };
  applyRoundedCorners(read(roundedCornersKey, normalizeRoundedCorners));

  const iosViewport = window.matchMedia('(max-width: 768px), (max-width: 1024px) and (pointer: coarse)');
  const viewportMeta = document.querySelector('meta[name="viewport"]');
  const defaultViewport = viewportMeta?.content || 'width=device-width, initial-scale=1.0';
  const syncIOSViewport = () => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    if (root.dataset.iosLayout !== 'on' || !iosViewport.matches || !viewport) {
      root.style.removeProperty('--nc-ios-viewport-height');
      delete root.dataset.iosKeyboard;
      return;
    }
    // Let dvh handle browser chrome. Only resize for an actual editing keyboard;
    // Safari's scroll/elastic offset must never translate the whole application.
    if (Math.abs(viewport.scale - 1) > .01) return;
    const editing = document.activeElement?.matches('textarea, input:not([type="checkbox"], [type="radio"], [type="range"], [type="button"], [type="submit"], [type="file"]), [contenteditable="true"]');
    const keyboardOpen = editing && window.innerHeight - viewport.height > 100;
    if (keyboardOpen) {
      const height = `${viewport.height}px`;
      if (root.style.getPropertyValue('--nc-ios-viewport-height') !== height) root.style.setProperty('--nc-ios-viewport-height', height);
      root.dataset.iosKeyboard = 'open';
    } else {
      root.style.removeProperty('--nc-ios-viewport-height');
      delete root.dataset.iosKeyboard;
    }
  };
  let viewportFrame = 0;
  const scheduleIOSViewport = () => {
    if (viewportFrame) return;
    viewportFrame = requestAnimationFrame(() => {
      viewportFrame = 0;
      syncIOSViewport();
    });
  };
  const applyIOSLayout = value => {
    const iosLayout = normalizeIOSLayout(value);
    document.documentElement.dataset.iosLayout = iosLayout;
    viewportMeta?.setAttribute('content', iosLayout === 'on' ? `${defaultViewport}, viewport-fit=cover` : defaultViewport);
    syncIOSViewport();
    window.dispatchEvent(new CustomEvent('nightcord:ios-layout-change'));
    return iosLayout;
  };
  applyIOSLayout(read(iosLayoutKey, normalizeIOSLayout));
  window.visualViewport?.addEventListener('resize', scheduleIOSViewport);
  window.addEventListener('resize', scheduleIOSViewport);
  iosViewport.addEventListener('change', scheduleIOSViewport);
  document.addEventListener('focusin', scheduleIOSViewport);
  document.addEventListener('focusout', scheduleIOSViewport);

  document.addEventListener('DOMContentLoaded', () => {
    const trigger = document.querySelector('#navigation-settings');
    const dialog = document.querySelector('#appearance-settings-template')?.content.querySelector('dialog').cloneNode(true);
    if (!trigger || !dialog) return;
    const options = [...dialog.querySelectorAll('input[name="nightcord-palette"]')];
    const memberListOptions = [...dialog.querySelectorAll('input[name="nightcord-member-list"]')];
    const roundedCornersToggle = dialog.querySelector('#rounded-corners-toggle');
    const iosLayoutToggle = dialog.querySelector('#ios-layout-toggle');
    const status = dialog.querySelector('#palette-status');
    const sidebar = dialog.querySelector('.settings-sidebar');
    const content = dialog.querySelector('.settings-content');
    const tabs = [...sidebar.querySelectorAll('[role="tab"]')];
    const pages = tabs.map(tab => dialog.querySelector(`#${tab.getAttribute('aria-controls')}`));
    const desktopSettings = window.matchMedia('(min-width: 769px) and (pointer: fine), (min-width: 1025px)');
    let selectedPage = 'appearance';
    const syncPages = () => {
      const desktop = desktopSettings.matches;
      const focused = document.activeElement;
      sidebar.hidden = !desktop;
      tabs.forEach((tab, index) => {
        const selected = tab.dataset.settingsPage === selectedPage;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        const page = pages[index];
        page.hidden = desktop && !selected;
        if (desktop) {
          page.setAttribute('role', 'tabpanel');
          page.setAttribute('aria-labelledby', tab.id);
        } else {
          page.removeAttribute('role');
          page.removeAttribute('aria-labelledby');
        }
      });
      // Resizing must never leave keyboard focus inside a hidden page or tab.
      if (dialog.open && focused?.closest('[hidden]')) {
        (desktop ? tabs.find(tab => tab.tabIndex === 0) : dialog.querySelector('.settings-close')).focus({ preventScroll: true });
      }
    };
    const selectPage = tab => {
      selectedPage = tab.dataset.settingsPage;
      syncPages();
      content.scrollTop = 0;
    };
    sidebar.addEventListener('click', event => {
      const tab = event.target.closest('[role="tab"]');
      if (tab) selectPage(tab);
    });
    sidebar.addEventListener('keydown', event => {
      const index = tabs.indexOf(event.target);
      if (index < 0) return;
      let next;
      if (event.key === 'ArrowDown') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowUp') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      selectPage(tabs[next]);
      tabs[next].focus({ preventScroll: true });
    });
    desktopSettings.addEventListener('change', syncPages);
    syncPages();
    const sync = palette => options.forEach(option => { option.checked = option.value === palette; });
    const syncMemberList = value => memberListOptions.forEach(option => { option.checked = option.value === value; });
    const syncRoundedCorners = value => { roundedCornersToggle.checked = value === 'on'; };
    const syncIOSLayout = value => { iosLayoutToggle.checked = value === 'on'; };
    let previousFocus;
    sync(document.documentElement.dataset.palette);
    syncMemberList(document.documentElement.dataset.memberList);
    syncRoundedCorners(document.documentElement.dataset.roundedCorners);
    syncIOSLayout(document.documentElement.dataset.iosLayout);

    trigger.addEventListener('click', () => {
      if (dialog.open) return;
      previousFocus = document.activeElement;
      document.body.appendChild(dialog);
      trigger.setAttribute('aria-controls', dialog.id);
      syncPages();
      dialog.showModal();
      window.dispatchEvent(new CustomEvent('nightcord:settings-open'));
      if (desktopSettings.matches) tabs.find(tab => tab.tabIndex === 0).focus({ preventScroll: true });
      else options.find(option => option.checked)?.focus({ preventScroll: true });
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
      const last = [...dialog.querySelectorAll('button, input, select, summary, a[href]')]
        .filter(element => !element.matches(':disabled') && element.tabIndex >= 0 && element.getClientRects().length).at(-1);
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
      trigger.removeAttribute('aria-controls');
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
    roundedCornersToggle.addEventListener('change', () => {
      const roundedCorners = applyRoundedCorners(roundedCornersToggle.checked ? 'on' : 'off');
      const message = roundedCorners === 'on' ? '已开启圆角' : '已关闭圆角，界面已切换为直角';
      try {
        localStorage.setItem(roundedCornersKey, roundedCorners);
        status.textContent = `${message}，已自动保存。`;
      } catch {
        status.textContent = `${message}；此浏览器无法保存，刷新后会恢复默认。`;
      }
    });
    iosLayoutToggle.addEventListener('change', () => {
      const iosLayout = applyIOSLayout(iosLayoutToggle.checked ? 'on' : 'off');
      const message = iosLayout === 'on' ? '已开启 iPhone / iOS 适配' : '已关闭 iPhone / iOS 适配';
      try {
        localStorage.setItem(iosLayoutKey, iosLayout);
        status.textContent = `${message}，已自动保存。`;
      } catch {
        status.textContent = `${message}；此浏览器无法保存，刷新后会恢复默认。`;
      }
    });
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
      if (event.key === roundedCornersKey || event.key === null) {
        const roundedCorners = applyRoundedCorners(read(roundedCornersKey, normalizeRoundedCorners));
        syncRoundedCorners(roundedCorners);
        status.textContent = roundedCorners === 'on' ? '圆角已开启。' : '圆角已关闭。';
      }
      if (event.key === iosLayoutKey || event.key === null) {
        const iosLayout = applyIOSLayout(read(iosLayoutKey, normalizeIOSLayout));
        syncIOSLayout(iosLayout);
        status.textContent = iosLayout === 'on' ? 'iPhone / iOS 适配已开启。' : 'iPhone / iOS 适配已关闭。';
      }
    });
  }, { once: true });
})();
