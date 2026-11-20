/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** SidebarHelpView: helpView component; sidebar supplies shared presentation context. */
const SidebarHelpView = (() => {
const { HELP, element, helpEntry, externalLink, field } = SidebarHelpers;
return class SidebarHelpView {
  constructor(sidebar) { this.sidebar = sidebar; }

  buildHelp() {
    this.sidebar.content.append(element('p', 'tools-description', '关于 Nightcord，你可能想知道的事。'));
    const search = field('搜索帮助', 'search', 'tools-help-query', this.sidebar.content);
    search.placeholder = '搜索帮助内容';
    const results = element('div', 'tools-help'); results.id = 'tools-help-results'; search.setAttribute('aria-controls', results.id);
    const repo = 'https://github.com/25-ji-code-de/nightcord';
    const legalDocs = 'https://docs.nightcord.de5.net/legal/complete';
    const legalLinks = element('p', 'tools-links');
    legalLinks.append(
      externalLink('用户协议', `${legalDocs}/terms-nightcord`),
      externalLink('隐私政策', `${legalDocs}/privacy-nightcord`),
      externalLink('版权声明', `${repo}/blob/main/README.md#版权声明`),
      externalLink('开源许可', `${repo}/blob/main/LICENSE`),
    );
    const contact = element('p');
    contact.append('如果您是权利人，认为站内内容侵犯了您的权益，请通过 ', externalLink('GitHub Issues', `${repo}/issues`), ' 联系维护者，并附上相关内容的位置。');
    const entries = HELP.map(([title, text]) => helpEntry(title, element('p', '', text)));
    const disclaimer = helpEntry('免责声明',
        element('p', '', 'Nightcord 是受《Project SEKAI》启发的非官方、非商业粉丝作品，与 SEGA、Colorful Palette、Crypton Future Media 等权利方无官方关联。'),
        element('p', '', '角色、贴纸、音乐和音效等游戏素材的版权归各自权利人所有。若要转载或商用这些素材，请遵守权利方的授权要求。AGPL-3.0-only 开源许可仅适用于 Nightcord 的原创代码。'),
        element('p', '', '本服务按现状提供。有关服务中断、数据丢失等情形的责任限制及例外，请参阅「法律条款」中的用户协议。'),
        contact,
        element('p', 'tools-legal-note', '使用本网站即表示您已阅读并同意上述条款。'),
    );
    disclaimer.dataset.keywords = 'Disclaimer';
    entries.push(helpEntry('法律条款', legalLinks), disclaimer);
    const render = () => {
      const query = search.value.trim().toLocaleLowerCase();
      results.replaceChildren();
      for (const detail of entries) {
        const searchable = [detail.textContent, detail.dataset.keywords].join(' ').toLocaleLowerCase();
        if (!searchable.includes(query)) continue;
        detail.open = !!query;
        results.append(detail);
      }
      if (!results.children.length) results.append(element('p', 'tools-empty', '没有匹配的帮助内容。'));
    };
    search.addEventListener('input', render); this.sidebar.content.append(results); render();
    const links = element('p', 'tools-links');
    links.append(externalLink('项目文档', `${repo}#readme`), externalLink('反馈问题', `${repo}/issues`));
    this.sidebar.content.append(links);
  }
};
})();
