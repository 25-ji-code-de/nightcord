/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** ChatNavigation: navigation component; ui supplies shared presentation context. */
class ChatNavigation {
  constructor(ui) { this.ui = ui; }

  /**
   * 设置移动端菜单
   */
  setupMobileMenu() {
    const sidebar = document.querySelector('.sidebar');
    const chatHeader = document.querySelector('.chat-header');
    const toggle = document.querySelector('.sidebar-toggle');
    if (!sidebar || !chatHeader || !toggle) return;
    const main = this.ui.elements.main;
    const scrim = document.querySelector('.navigation-scrim');
    const members = document.querySelector('#navigation-members');
    const profile = this.ui.elements.navigationProfile;
    const mobileWidth = window.matchMedia('(max-width: 768px)');
    const iosLandscape = window.matchMedia('(max-width: 1024px) and (pointer: coarse)');
    const mobile = { get matches() {
      return mobileWidth.matches || (document.documentElement.dataset.iosLayout === 'on' && iosLandscape.matches);
    } };
    const toggleSelector = 'button[aria-controls="member-sidebar"]';
    const drawerToggles = () => main.querySelectorAll(toggleSelector);
    const focusToggle = () => [...drawerToggles()].find(node => node.getClientRects().length)?.focus({ preventScroll: true });
    let membersCollapsed = false;
    const sync = () => {
      const drawerOpen = mobile.matches && sidebar.classList.contains('show');
      const open = !mobile.matches || drawerOpen;
      sidebar.inert = !open;
      sidebar.classList.toggle('members-collapsed', !mobile.matches && membersCollapsed && !this.ui.mentionPickerOpen);
      main.inert = drawerOpen;
      if (scrim) scrim.hidden = !drawerOpen;
      for (const button of drawerToggles()) button.setAttribute('aria-expanded', String(open));
      if (members) {
        const visible = mobile.matches ? drawerOpen : !membersCollapsed;
        members.setAttribute('aria-expanded', String(visible));
        members.setAttribute('aria-label', mobile.matches ? '关闭导航' : visible ? '收起成员列表' : '展开成员列表');
      }
    };
    const close = () => { sidebar.classList.remove('show'); sync(); };
    main.addEventListener('click', event => {
      if (!event.target.closest?.(toggleSelector)) return;
      sidebar.classList.toggle('show');
      sync();
      if (sidebar.classList.contains('show')) document.querySelector('#navigation-chat')?.focus({ preventScroll: true });
    });
    const updateMobileLayout = () => {
      const focusInside = sidebar.contains(document.activeElement);
      const focusOnToggle = document.activeElement?.matches(toggleSelector);
      close();
      if (mobile.matches && focusInside) focusToggle();
      else if (!mobile.matches && focusOnToggle) document.querySelector('#navigation-chat')?.focus({ preventScroll: true });
    };
    mobileWidth.addEventListener('change', updateMobileLayout);
    iosLandscape.addEventListener('change', updateMobileLayout);
    // A settings modal replaces the phone drawer; its scrim must not remain
    // behind the dialog and keep the chat dimmed/inert after dismissal.
    window.addEventListener('nightcord:ios-layout-change', close);
    window.addEventListener('nightcord:settings-open', () => {
      if (mobile.matches) close();
    });
    scrim?.addEventListener('click', () => { close(); focusToggle(); });
    members?.addEventListener('click', () => {
      this.ui.closeMentionPicker({ restoreFocus: false });
      if (mobile.matches) { close(); focusToggle(); }
      else { membersCollapsed = !membersCollapsed; sync(); }
    });
    const chat = () => {
      this.ui.closeMentionPicker({ restoreFocus: false });
      if (mobile.matches) close();
      this.ui.isAtBottom = true;
      this.ui.elements.chatlog.scrollTop = this.ui.elements.chatlog.scrollHeight;
      if (mobile.matches) toggle.focus({ preventScroll: true });
      else this.ui.elements.chatInput.focus({ preventScroll: true });
    };
    document.querySelector('#navigation-chat')?.addEventListener('click', chat);
    document.querySelector('#navigation-channel')?.addEventListener('click', chat);
    profile?.addEventListener('click', () => {
      if (this.ui.currentUser) this.ui.profileUI.open(this.ui.currentUser);
    });
    this.ui.elements.navigationProfileInfo?.addEventListener('click', () => {
      if (this.ui.currentUser) this.ui.profileUI.open(this.ui.currentUser);
    });
    document.querySelector('#navigation-mentions')?.addEventListener('click', () => {
      if (this.ui.mentionPickerOpen) this.ui.closeMentionPicker();
      else this.ui.openMentionPicker();
    });
    // Sidebar panels need the drawer on phones and an uncollapsed rail on desktop.
    this.ui.revealNavigation = () => {
      if (mobile.matches) sidebar.classList.add('show');
      else membersCollapsed = false;
      sync();
    };
    this.ui.closeNavigationDrawer = close;
    this.ui.isNavigationDrawerOpen = () => mobile.matches && sidebar.classList.contains('show');
    this.ui.syncNavigation = sync;
    this.ui.setupMentionPicker();
    sync();

    // 点击侧边栏外部区域关闭侧边栏
    document.addEventListener('click', (e) => {
      if (e.target.closest('dialog')) return;
      if (sidebar.classList.contains('show')) {
        // 检查点击是否在侧边栏外部且不是头部按钮
        if (!sidebar.contains(e.target) && !e.target.closest('.chat-header')) {
          close();
        }
      }
    });

    // Selecting the channel closes navigation; profile cards keep their trigger
    // available so keyboard focus can return to the member after dismissal.
    sidebar.addEventListener('click', (event) => {
      if (mobile.matches && event.target.closest('.channel')) close();
    });
    document.addEventListener('keydown', (event) => {
      if (!mobile.matches || !sidebar.classList.contains('show') || document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') {
        close();
        focusToggle();
      } else if (event.key === 'Tab') {
        const controls = [...sidebar.querySelectorAll('button:not(:disabled), a[href], [tabindex="0"]')]
          .filter(element => element.getClientRects().length);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    });
  }
}
