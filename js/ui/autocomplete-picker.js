/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** AutocompletePicker: pickerView component; autocomplete supplies shared presentation context. */
class AutocompletePicker {
  constructor(autocomplete) { this.autocomplete = autocomplete; }

  showStickerList(query) {
    const stickers = this.autocomplete.getStickers();
    if (!stickers || stickers.length === 0) {
      this.autocomplete.hideList();
      return;
    }

    if (!query) {
      this.showPicker(stickers, 'sticker');
      return;
    }

    const lowerQuery = query.toLowerCase();
    let matches = [];
    const underscoreIndex = lowerQuery.indexOf('_');

    if (underscoreIndex !== -1) {
      const categoryQuery = lowerQuery.substring(0, underscoreIndex);
      const termQuery = lowerQuery.substring(underscoreIndex + 1);

      matches = stickers.filter(s => {
        if (s.category.toLowerCase() !== categoryQuery) return false;
        if (!termQuery) return true;
        return s.searchKey.includes(termQuery) || s.label.includes(termQuery);
      });
    } else {
      matches = stickers.filter(s => {
        if (!lowerQuery) return true;
        return s.searchKey.includes(lowerQuery) || s.label.includes(lowerQuery);
      });
    }

    const maxResults = underscoreIndex !== -1 ? 500 : 100;
    matches = matches.slice(0, maxResults);

    /*
     * 贴纸数据来自远端 JSON（sticker.nightcord.de5.net/autocomplete.json）。
     * 是我们自己的基础设施，但仍然是**跨网络来的数据** —— 它不该有能力
     * 决定这一页的标记。
     */
    this.renderItems(matches, (s) => `
      <div class="mention-item sticker-autocomplete-item" data-code="${escapeHtml(s.code)}">
        <img src="${escapeHtml(s.url)}" class="sticker-preview" loading="lazy" alt="" />
        <div class="sticker-info">
           <div class="sticker-label">${escapeHtml(s.label)}</div>
           <div class="sticker-desc">${escapeHtml(this.getCategoryLabel(s.category))}</div>
        </div>
      </div>
    `, (item) => this.autocomplete.completeSticker(item.dataset.code));
  }

  showEmojiList(query) {
    const emojis = this.autocomplete.getEmojis();
    if (!emojis || emojis.length === 0) {
      this.autocomplete.hideList();
      return;
    }

    if (!query) {
      this.showPicker(emojis, 'emoji');
      return;
    }

    const lowerQuery = query.toLocaleLowerCase();
    const matches = emojis
      .filter((emoji) => emoji.shortcode.toLocaleLowerCase().includes(lowerQuery))
      .sort((a, b) => {
        const aStarts = a.shortcode.toLocaleLowerCase().startsWith(lowerQuery);
        const bStarts = b.shortcode.toLocaleLowerCase().startsWith(lowerQuery);
        if (aStarts !== bStarts) return aStarts ? -1 : 1;
        return a.shortcode.localeCompare(b.shortcode);
      })
      .slice(0, 100);

    this.renderItems(matches, (emoji) => `
      <div class="mention-item emoji-autocomplete-item" data-shortcode="${escapeHtml(emoji.shortcode)}">
        <img src="${escapeHtml(emoji.url)}" class="emoji-preview" loading="lazy" alt="" />
        <div class="sticker-info">
          <div class="sticker-label">:${escapeHtml(emoji.shortcode)}:</div>
          <div class="sticker-desc">${escapeHtml(this.getCategoryLabel(emoji.category))}</div>
        </div>
      </div>
    `, (item) => this.autocomplete.completeEmoji(item.dataset.shortcode));
  }

  getCategoryLabel(category) {
    const labels = {
      'smileys_&_emotion': '表情',
      'people_&_body': '人物',
      'animals_&_nature': '自然',
      'food_&_drink': '食物',
      'travel_&_places': '地点',
      activities: '活动',
      objects: '物品',
      symbols: '符号',
      flags: '旗帜',
      bilibili: '哔哩哔哩',
      lark: '飞书',
      rednote: '小红书',
      tieba: '贴吧',
      ick: '星乃一歌',
      saki: '天马咲希',
      hnm: '望月穗波',
      shiho: '日野森志步',
      mnr: '花里实乃理',
      hrk: '桐谷遥',
      airi: '桃井爱莉',
      szk: '日野森雫',
      khn: '小豆泽心羽',
      an: '白石杏',
      akt: '东云彰人',
      toya: '青柳冬弥',
      tks: '天马司',
      emu: '凤笑梦',
      nene: '草薙宁宁',
      rui: '神代类',
      knd: '宵崎奏',
      mfy: '朝比奈真冬',
      ena: '东云绘名',
      mzk: '晓山瑞希',
      miku: '初音未来',
      rin: '镜音铃',
      len: '镜音连',
      luka: '巡音流歌',
      meiko: 'MEIKO',
      kaito: 'KAITO',
      text: '文字'
    };
    return labels[category] || String(category).replaceAll('_', ' ');
  }

  showPicker(items, type) {
    if (!this.autocomplete.list || items.length === 0) {
      this.autocomplete.hideList();
      return;
    }

    const categories = [...new Set(items.map((item) => item.category))];
    if (type === 'emoji') {
      const categoryOrder = [
        'smileys_&_emotion', 'people_&_body', 'animals_&_nature',
        'food_&_drink', 'travel_&_places', 'activities', 'objects',
        'symbols', 'flags', 'bilibili', 'lark', 'rednote', 'tieba'
      ];
      const orderOf = (category) => {
        const index = categoryOrder.indexOf(category);
        return index === -1 ? categoryOrder.length : index;
      };
      categories.sort((a, b) => orderOf(a) - orderOf(b));
    } else if (type === 'sticker') {
      const categoryOrder = [
        'ick', 'saki', 'hnm', 'shiho',
        'mnr', 'hrk', 'airi', 'szk',
        'khn', 'an', 'akt', 'toya',
        'tks', 'emu', 'nene', 'rui',
        'knd', 'mfy', 'ena', 'mzk',
        'miku', 'rin', 'len', 'luka', 'meiko', 'kaito',
        'text'
      ];
      const orderOf = (category) => {
        const index = categoryOrder.indexOf(category);
        return index === -1 ? categoryOrder.length : index;
      };
      categories.sort((a, b) => orderOf(a) - orderOf(b));
    }
    this.autocomplete.pickerCategories = this.autocomplete.pickerCategories || {};
    let activeCategory = this.autocomplete.pickerCategories[type];
    if (!categories.includes(activeCategory)) activeCategory = categories[0];
    this.autocomplete.pickerCategories[type] = activeCategory;

    const panelId = `${this.autocomplete.list.id || 'autocomplete'}-panel`;
    const categoryButtons = categories.map((category, index) => `
      <button type="button" class="picker-category${category === activeCategory ? ' active' : ''}"
              id="${panelId}-tab-${index}" aria-controls="${panelId}" tabindex="${category === activeCategory ? '0' : '-1'}"
              data-category="${escapeHtml(category)}" role="tab"
              aria-selected="${category === activeCategory ? 'true' : 'false'}">
        ${escapeHtml(this.getCategoryLabel(category))}
      </button>
    `).join('');

    this.autocomplete.list.classList.add('picker-mode');
    this.autocomplete.list.innerHTML = `
      <div class="picker-categories" role="tablist" aria-label="${type === 'emoji' ? '表情分类' : '贴纸分类'}">${categoryButtons}</div>
      <div class="picker-grid" role="tabpanel" id="${panelId}" aria-labelledby="${panelId}-tab-${categories.indexOf(activeCategory)}"></div>
    `;

    const grid = this.autocomplete.list.querySelector('.picker-grid');
    const tabs = this.autocomplete.list.querySelectorAll('.picker-category');
    tabs.forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const category = button.dataset.category;
        if (category === this.autocomplete.pickerCategories[type]) return;
        this.autocomplete.pickerCategories[type] = category;
        tabs.forEach((tab) => {
          tab.classList.toggle('active', tab === button);
          tab.setAttribute('aria-selected', String(tab === button));
          tab.tabIndex = tab === button ? 0 : -1;
        });
        grid.setAttribute('aria-labelledby', button.id);
        this.renderPickerGrid(grid, items, type, category);
      });
      button.addEventListener('keydown', event => {
        const index = Array.from(tabs).indexOf(button);
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else return;
        event.preventDefault();
        tabs[next].focus();
        tabs[next].click();
      });
    });
    grid.addEventListener('click', (event) => {
      const button = event.target.closest('.picker-grid-item');
      if (!button) return;
      if (type === 'emoji') this.autocomplete.completeEmoji(button.dataset.shortcode);
      else this.autocomplete.completeSticker(button.dataset.code);
    });

    this.renderPickerGrid(grid, items, type, activeCategory);
    this.autocomplete.list.classList.remove('hidden');
    this.autocomplete.syncExpanded();
    if (activeCategory !== categories[0]) {
      this.autocomplete.list.querySelector('.picker-category.active').scrollIntoView({
        block: 'nearest', inline: 'nearest', container: 'nearest'
      });
    }
  }

  renderPickerGrid(grid, items, type, category) {
    const isEmoji = type === 'emoji';
    const categoryItems = items.filter((item) => item.category === category);
    grid.innerHTML = categoryItems.map((item, index) => {
      const value = isEmoji ? item.shortcode : item.code;
      const label = isEmoji ? item.shortcode : item.label;
      const dataAttribute = isEmoji ? 'data-shortcode' : 'data-code';
      const title = isEmoji ? `:${value}:` : `[${value}]`;
      return `
        <button type="button" class="picker-grid-item${index === 0 ? ' active' : ''}"
                ${dataAttribute}="${escapeHtml(value)}" title="${escapeHtml(title)}"
                aria-label="${escapeHtml(title)}">
          <img src="${escapeHtml(item.url)}" loading="lazy" alt="" />
          <span>${escapeHtml(label)}</span>
        </button>
      `;
    }).join('');
    grid.scrollTop = 0;
    this.autocomplete.autocompleteIndex = 0;
  }

  renderItems(items, templateFn, clickHandler) {
    if (!this.autocomplete.list) return;
    if (items.length === 0) {
      this.autocomplete.hideList();
      return;
    }

    this.autocomplete.list.classList.remove('picker-mode');
    this.autocomplete.list.innerHTML = items.map((item, index) => {
      let html = templateFn(item);
      if (index === 0) html = html.replace('class="', 'class="active ');
      return html;
    }).join('');

    this.autocomplete.list.querySelectorAll('.mention-item').forEach(item => {
      item.setAttribute('role', 'button');
      item.tabIndex = 0;
      item.addEventListener('click', () => clickHandler(item));
      item.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        clickHandler(item);
      });
    });

    this.autocomplete.list.classList.remove('hidden');
    this.autocomplete.syncExpanded();
    this.autocomplete.autocompleteIndex = 0;
  }
}
