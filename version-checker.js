(function () {
  let currentVersion = null;
  let updateBar = null;

  async function check() {
    try {
      const res = await fetch('/version.json?_=' + Date.now());
      const { v } = await res.json();

      if (!currentVersion) {
        currentVersion = v;
        return;
      }

      if (v !== currentVersion) {
        showUpdateBar();
      }
    } catch (e) {}
  }

  function showUpdateBar() {
    if (updateBar) return; // 已经在显示了

    updateBar = document.createElement('div');
    updateBar.className = 'sekai-update-toast';

    // Accessibility attributes
    updateBar.setAttribute('role', 'alert');
    updateBar.setAttribute('aria-live', 'polite');
    updateBar.setAttribute('aria-label', 'Update notification');

    updateBar.innerHTML = `
      <div class="sekai-update-content">
        <svg class="sekai-update-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="23 4 23 10 17 10"></polyline>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
        </svg>
        <span>新版本可用 / Update Available</span>
      </div>
      <div class="sekai-update-actions">
        <button onclick="location.reload()" class="sekai-update-btn" aria-label="Update now">
          Update
        </button>
        <button onclick="this.parentElement.parentElement.remove()" class="sekai-update-btn-dismiss" aria-label="Dismiss">
          <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
    `;

    document.body.appendChild(updateBar);
  }

  // 每 15 秒检查
  setInterval(check, 15000);

  // 用户切回页面时立即检查
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check();
  });

  check();
})();
