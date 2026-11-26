/* SPDX-License-Identifier: AGPL-3.0-only */
(function () {
  'use strict';
  const supported = 'serviceWorker' in navigator && window.isSecureContext;
  let registration, installPrompt, activating = false, push, status = '', busy = false;
  const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const node = id => document.getElementById(id);
  function render() {
    if (typeof nightcord !== 'undefined') nightcord.ui?.alerts?.view.refresh();
    if (!node('pwa-status')) return;
    node('pwa-status').textContent = status;
    node('pwa-install').hidden = !installPrompt || installed();
    node('pwa-install-description').textContent = installed() ? '当前正以独立应用模式运行。'
      : ios() ? '在 Safari 中，点击“共享”→“添加到主屏幕”。若使用 iOS/iPadOS 16.4 或更高版本，请先从主屏幕打开应用，以启用推送通知。'
      : installPrompt ? '安装完成后，您可以直接从桌面或主屏幕打开 Nightcord。' : '请使用浏览器菜单中的“安装应用”或“添加到主屏幕”选项。具体可用性取决于您所使用的浏览器。';
    const enabled = !!push?.state;
    node('pwa-push-enable').textContent = enabled ? '禁用推送通知' : '启用推送通知';
    node('pwa-push-enable').disabled = busy || push?.busy || (!enabled && (!push?.supported() || !push?.user || !push?.config?.enabled));
    node('pwa-push-pause').hidden = !enabled;
    node('pwa-push-pause').textContent = push?.state?.pausedUntil > Date.now() ? '恢复推送通知' : '暂停一小时';
    node('pwa-push-description').textContent = !supported ? '当前环境不支持后台推送通知，请使用 HTTPS 协议及兼容的浏览器。'
      : ios() && !installed() ? '请先将应用添加到主屏幕，然后从主屏幕打开 Nightcord。'
      : !push?.supported() ? '您当前的浏览器不支持 Web 推送。'
      : !push.user ? '请使用您的 SEKAI Pass 登录，以启用推送通知。'
      : Notification.permission === 'denied' ? '通知权限已被拦截，请在浏览器的站点设置中允许通知。'
      : !push.config?.enabled ? '后台推送通知当前不可用，请稍后再试。'
      : enabled ? (push.state.pausedUntil > Date.now() ? '推送通知已暂停，暂停结束后将自动恢复。' : '已启用私信推送。聊天室推送可在“消息提醒”中分别开启。')
      : '点击“启用推送通知”后，浏览器将请求发送通知的权限。';
    for (const id of ['pwa-install', 'pwa-push-pause', 'pwa-storage', 'pwa-update']) node(id).disabled = busy;
    node('pwa-push-pause').disabled = busy || push?.busy;
    node('pwa-storage').hidden = !navigator.storage?.persist;
    node('pwa-update').hidden = !supported;
    node('pwa-status').setAttribute('aria-busy', String(busy));
  }
  async function action(work) {
    if (busy) return;
    busy = true; status = '正在处理……'; render();
    try { status = await work() || '已保存。'; }
    catch (error) { status = error.message || '操作无法完成，请稍后再试。'; }
    finally { busy = false; render(); }
  }
  function updateReady() {
    if (!registration?.waiting) return;
    window.dispatchEvent(new Event('nightcord:update-ready'));
    status = '新版本已就绪。请保存尚未发送的内容，然后点击“更新并重新打开”。';
    if (node('pwa-update')) node('pwa-update').textContent = '更新并重新打开';
    render();
  }
  window.NightcordPWA = {
    async activatePendingUpdate() {
      if (activating) return;
      let current = registration;
      try { current ||= await navigator.serviceWorker?.getRegistration(); } catch { /* Fall back to a normal reload. */ }
      if (current?.waiting) {
        activating = true;
        let reloaded = false;
        const reload = () => { if (!reloaded) { reloaded = true; location.reload(); } };
        navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
        setTimeout(reload, 3000);
        try { current.waiting.postMessage({ type: 'SKIP_WAITING' }); } catch { reload(); }
      } else location.reload();
    },
    logout: () => push?.logout(),
  };
  let ready = Promise.resolve(null);
  if (supported) {
    ready = navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(async value => {
      registration = value;
      value.addEventListener('updatefound', () => value.installing?.addEventListener('statechange', updateReady));
      updateReady();
      let timer;
      try {
        return await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Service worker activation timed out')), 15000);
        })]);
      } finally { clearTimeout(timer); }
    }).catch(error => { status = '离线组件暂时不可用，请连接互联网后再试。'; render(); console.warn('[PWA] registration failed', error); return null; });
    if (typeof nightcord !== 'undefined') push = new PushNotifications(nightcord, ready, render);
  }
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; render(); });
  window.addEventListener('appinstalled', () => { installPrompt = null; render(); });
  matchMedia('(display-mode: standalone)').addEventListener('change', render);
  function mount() {
    if (push && !push.config && navigator.onLine) void push.initialize();
    const root = node('settings-pwa');
    if (!root || root.dataset.mounted) { render(); return; }
    root.dataset.mounted = 'true';
    node('pwa-install').addEventListener('click', () => action(async () => {
      const prompt = installPrompt; installPrompt = null;
      if (!prompt) return '请通过浏览器菜单进行安装。';
      await prompt.prompt(); const choice = await prompt.userChoice;
      return choice.outcome === 'accepted' ? '安装已启动，请等待浏览器完成后续流程。' : '安装已取消，您稍后仍可通过浏览器菜单进行安装。';
    }));
    node('pwa-push-enable').addEventListener('click', () => action(async () => {
      if (push.state) { await push.disable(); return '已禁用此设备上的全部推送通知。'; }
      await push.enable(); return '已启用私信推送通知。';
    }));
    node('pwa-push-pause').addEventListener('click', () => action(async () => { await push.pause(); return '“勿扰”设置已同步。'; }));
    node('pwa-storage').addEventListener('click', () => action(async () =>
      await navigator.storage.persist() ? '您的浏览器允许保留本地数据，但仍建议您定期导出重要的聊天记录。' : '浏览器目前未获准长期保留本地数据，请在安装应用程序后重试。'));
    node('pwa-update').addEventListener('click', () => action(async () => {
      if (registration?.waiting) { await window.NightcordPWA.activatePendingUpdate(); return '正在更新……'; }
      if (!navigator.onLine) return '当前处于离线状态，请连接互联网以检查更新。';
      if (!registration) throw new Error('离线组件尚未就绪，请稍后再试。');
      await registration.update(); window.dispatchEvent(new Event('nightcord:check-update'));
      return registration.waiting ? '新版本已就绪，更新前请保存尚未发送的内容。' : '系统已检查更新，若有新版本可用，页面上会显示相应的提示。';
    }));
    render();
  }
  window.addEventListener('nightcord:settings-open', mount);
  let offlineBanner;
  function connection() {
    if (!offlineBanner) {
      offlineBanner = document.createElement('div'); offlineBanner.className = 'pwa-offline'; offlineBanner.setAttribute('role', 'status');
      offlineBanner.textContent = '当前处于离线状态 · 恢复连接后，消息将会同步。'; document.body.append(offlineBanner);
    }
    offlineBanner.hidden = navigator.onLine; render();
  }
  window.addEventListener('online', () => { connection(); if (push && !push.config) void push.initialize(); });
  window.addEventListener('offline', connection);
  document.addEventListener('DOMContentLoaded', () => { mount(); connection(); });
})();
