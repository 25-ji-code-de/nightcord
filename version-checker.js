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
    updateBar.setAttribute('style',
      'position:fixed;top:0;left:0;right:0;z-index:99999;' +
      'background:#4f46e5;color:#fff;padding:10px;' +
      'text-align:center;font:14px/1.5 sans-serif'
    );
    updateBar.innerHTML =
      '🔄 有新版本 ' +
      '<button onclick="location.reload()" style="' +
      'margin-left:8px;padding:4px 16px;border:none;' +
      'border-radius:4px;background:#fff;color:#4f46e5;cursor:pointer' +
      '">点击更新</button>';

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
