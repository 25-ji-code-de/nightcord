/**
 * SEKAI Renderer - Structured Extensible Keyword for Advanced Interactions
 *
 * 负责解析和渲染 SEKAI 富文本语法，包括：
 * - 基础富媒体：[img:URL]、[file:ID|Name|Size]、[audio:ID|Duration]、[stamp:ID]
 * - 文本格式化：**粗体**、*斜体*、~~删除线~~、||黑幕||、`代码`、> 引用
 * - 高级交互：[re:timestamp]、[link:URL|Title]、[color:hex|text]
 *
 * @example
 * const renderer = new SekaiRenderer({
 *   stickerService: stickerService,
 *   aiPersonas: ['Nako', 'Asagi', 'Miku']
 * });
 *
 * const fragment = renderer.render('这是**粗体**和[img:https://example.com/photo.jpg]');
 */
class SekaiRenderer {
  /**
   * @param {Object} options - 配置选项
   * @param {StickerService} options.stickerService - Sticker 服务实例
   * @param {string} options.stickerDir - Sticker 目录 URL
   * @param {Array<string>} options.aiPersonas - AI 人设名称列表
   * @param {number} options.imageWidthThreshold - 图片宽度阈值（用于调整显示）
   */
  constructor(options = {}) {
    this.stickerService = options.stickerService;
    this.stickerDir = options.stickerDir || 'https://sticker.nightcord.de5.net/stickers';
    this.aiPersonas = options.aiPersonas || [];
    this.imageWidthThreshold = options.imageWidthThreshold || 400;
  }

  /**
   * 渲染文本为 DocumentFragment
   * @param {string} text - 原始文本
   * @returns {DocumentFragment} 渲染后的 DOM 片段
   */
  render(text) {
    if (!text) {
      return document.createDocumentFragment();
    }

    // 1. 标准化语法糖
    text = this.normalizeSyntaxSugar(text);

    // 2. 令牌化
    const tokens = this.tokenize(text);

    // 3. 判断是否是单个 sticker（用于控制显示尺寸）
    // 只有当整个消息就是一个 sticker 时才显示大尺寸
    const isSingleSticker = tokens.length === 1 &&
                           tokens[0].type === 'sekai' &&
                           tokens[0].sekaiType === 'stamp';

    // 4. 渲染令牌
    const fragment = document.createDocumentFragment();
    tokens.forEach(token => {
      const element = this.renderToken(token, { isSingleSticker });
      if (element) {
        fragment.appendChild(element);
      }
    });

    return fragment;
  }

  /**
   * 标准化语法糖
   * [stamp0000] → [stamp:0000]
   * 但保持其他格式如 [airi_xxx] 不变
   *
   * @param {string} text - 原始文本
   * @returns {string} 标准化后的文本
   */
  normalizeSyntaxSugar(text) {
    // [stamp0000] → [stamp:0000]
    // 只转换 stamp + 纯数字 的格式
    text = text.replace(/\[stamp(\d+)\]/gi, '[stamp:$1]');

    // [stamp_0000] → [stamp:0000]
    text = text.replace(/\[stamp_(\d+)\]/gi, '[stamp:$1]');

    // 其他 [xxx] 格式（如 [airi_xxx]、[category_name]）保持不变
    // 不进行任何转换，让 StickerService 处理

    return text;
  }

  /**
   * 检查是否是 AI 人设名称
   * @param {string} name - 名称
   * @returns {boolean}
   */
  isAIPersona(name) {
    return this.aiPersonas.includes(name);
  }

  /**
   * 令牌化：将文本分割为 SEKAI 令牌和纯文本块
   * @param {string} text - 文本
   * @returns {Array<Object>} 令牌数组
   */
  tokenize(text) {
    const tokens = [];

    // 匹配 [type:data] 或 [type:data|metadata]
    const sekaiRegex = /\[(\w+):([^\]]+)\]/g;
    let lastIndex = 0;
    let match;

    while ((match = sekaiRegex.exec(text)) !== null) {
      const startIndex = match.index;
      const fullMatch = match[0];
      const type = match[1];
      const data = match[2];

      // 添加之前的纯文本
      if (startIndex > lastIndex) {
        const textContent = text.slice(lastIndex, startIndex);
        if (textContent) {
          tokens.push({
            type: 'text',
            content: textContent
          });
        }
      }

      // 解析 data 和 metadata（用 | 分割）
      const parts = data.split('|');
      const mainData = parts[0];
      const metadata = parts.slice(1);

      // 添加 SEKAI 令牌
      tokens.push({
        type: 'sekai',
        sekaiType: type.toLowerCase(),
        data: mainData,
        metadata: metadata,
        raw: fullMatch
      });

      lastIndex = sekaiRegex.lastIndex;
    }

    // 添加最后的纯文本
    if (lastIndex < text.length) {
      const textContent = text.slice(lastIndex);
      if (textContent) {
        tokens.push({
          type: 'text',
          content: textContent
        });
      }
    }

    return tokens;
  }

  /**
   * 渲染单个令牌
   * @param {Object} token - 令牌对象
   * @param {Object} options - 渲染选项
   * @param {boolean} options.isSingleSticker - 是否是单个 sticker
   * @returns {Node|null} DOM 节点
   */
  renderToken(token, options = {}) {
    if (token.type === 'text') {
      return this.renderText(token.content);
    } else if (token.type === 'sekai') {
      return this.renderSekaiToken(token, options);
    }
    return null;
  }

  /**
   * 渲染纯文本（包含 sticker）
   * 将非 SEKAI 令牌的文本（如 [airi_xxx]）传递给 StickerService 处理
   * @param {string} text - 文本内容
   * @returns {DocumentFragment} 文本片段
   */
  renderText(text) {
    if (this.stickerService) {
      // 使用 StickerService 处理文本中的 sticker（如 [airi_xxx]、[category_name]）
      return this.stickerService.renderTextWithStickers(text);
    } else {
      // 降级：纯文本渲染（保留换行）
      const fragment = document.createDocumentFragment();
      const lines = text.split('\n');
      lines.forEach((line, index) => {
        if (line.length > 0) {
          fragment.appendChild(document.createTextNode(line));
        }
        if (index < lines.length - 1) {
          fragment.appendChild(document.createElement('br'));
        }
      });
      return fragment;
    }
  }

  /**
   * 渲染 SEKAI 令牌
   * @param {Object} token - SEKAI 令牌
   * @param {Object} options - 渲染选项
   * @returns {Node|null} DOM 节点
   */
  renderSekaiToken(token, options = {}) {
    const { sekaiType, data, metadata, raw } = token;

    switch (sekaiType) {
      case 'stamp':
        return this.renderStamp(data, options.isSingleSticker);

      case 'img':
        return this.renderImage(data, metadata[0]);

      case 'file':
        return this.renderFile(data, metadata[0], metadata[1]);

      case 'audio':
        return this.renderAudio(data, metadata[0]);

      case 'link':
        return this.renderLink(data, metadata[0], metadata[1]);

      case 'color':
        return this.renderColorText(data, metadata[0]);

      case 're':
        return this.renderReply(data, metadata[0]);

      default:
        // 未知类型，显示原始文本
        console.warn(`Unknown SEKAI type: ${sekaiType}`);
        return document.createTextNode(raw);
    }
  }

  /**
   * 渲染 Stamp/Sticker （SEKAI 格式：[stamp:ID]）
   * @param {string} id - Stamp ID（如 "0001"）
   * @param {boolean} isSingleSticker - 是否是单个 sticker（控制显示尺寸）
   * @returns {Node} DOM 节点
   */
  renderStamp(id, isSingleSticker = false) {
    if (this.stickerService) {
      // [stamp:0001] → 构造为 [stamp0001] 请求 stamp0001.png
      const stampName = `stamp${id}`;

      // 直接创建 img 元素，复制 StickerService 的逻辑
      const src = `${this.stickerDir}/${encodeURIComponent(stampName.toLowerCase())}.png`;
      const img = document.createElement('img');
      img.classList.add('sticker', 'sticker-loading');

      // 根据 isSingleSticker 决定样式类
      if (isSingleSticker) {
        img.classList.add('sticker-fixed');
      } else {
        img.classList.add('sticker-inline');
      }

      img.src = src;
      img.alt = `[${stampName}]`;
      img.title = stampName;
      img.loading = 'lazy';

      // onload 处理（复制自 StickerService）
      img.onload = () => {
        img.classList.remove('sticker-loading');
        try {
          if (img.naturalWidth > (this.stickerService ? this.stickerService.widthThreshold : 180)) {
            img.classList.remove('sticker-fixed');
            img.classList.add('sticker-narrow');
          }
        } catch (e) {
          console.warn('Failed to adjust sticker width', e);
        }
      };

      // onerror 处理
      img.onerror = () => {
        const replacement = document.createElement('span');
        replacement.className = 'sticker-broken';
        replacement.textContent = img.alt || '';
        try {
          img.replaceWith(replacement);
        } catch (e) {
          console.warn('Failed to replace broken sticker image', e);
        }
      };

      return img;
    } else {
      // 降级：显示原始文本
      return document.createTextNode(`[stamp:${id}]`);
    }
  }

  /**
   * 渲染图片
   * @param {string} url - 图片 URL
   * @param {string} alt - Alt 文本（可选）
   * @returns {HTMLImageElement} 图片元素
   */
  renderImage(url, alt = '') {
    const img = document.createElement('img');
    img.src = url;
    img.alt = alt || url;
    img.title = alt || url;
    img.loading = 'lazy';
    img.classList.add('sekai-image', 'sekai-image-loading');

    img.onload = () => {
      img.classList.remove('sekai-image-loading');
      // 根据宽度调整样式
      if (img.naturalWidth > this.imageWidthThreshold) {
        img.classList.add('sekai-image-large');
      } else {
        img.classList.add('sekai-image-small');
      }
    };

    img.onerror = () => {
      img.classList.remove('sekai-image-loading');
      img.classList.add('sekai-image-error');
      // 显示 alt 文本
      const span = document.createElement('span');
      span.className = 'sekai-image-error-text';
      span.textContent = `[图片加载失败: ${alt || url}]`;
      img.replaceWith(span);
    };

    return img;
  }

  /**
   * 渲染文件卡片
   * @param {string} id - 文件 ID 或 URL
   * @param {string} filename - 文件名
   * @param {string} size - 文件大小
   * @returns {HTMLElement} 文件卡片元素
   */
  renderFile(id, filename = 'Unknown File', size = '') {
    // 使用现有的 message-file 样式（参考 index.html）
    const card = document.createElement('div');
    card.className = 'message-file';

    // 文件图标
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = this.getFileIcon(filename);
    card.appendChild(icon);

    // 文件信息
    const info = document.createElement('div');
    info.className = 'file-info';

    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = filename;
    info.appendChild(name);

    if (size) {
      const sizeEl = document.createElement('div');
      sizeEl.className = 'file-size';
      sizeEl.textContent = size;
      info.appendChild(sizeEl);
    }

    card.appendChild(info);

    // 下载按钮
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'file-download';
    downloadBtn.title = '下载';
    downloadBtn.textContent = '⬇️';
    downloadBtn.addEventListener('click', () => {
      window.open(id, '_blank');
    });
    card.appendChild(downloadBtn);

    return card;
  }

  /**
   * 根据文件名获取图标
   * @param {string} filename - 文件名
   * @returns {string} 图标 emoji
   */
  getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const iconMap = {
      'pdf': '📄',
      'doc': '📝', 'docx': '📝',
      'xls': '📊', 'xlsx': '📊',
      'ppt': '📊', 'pptx': '📊',
      'zip': '📦', 'rar': '📦', '7z': '📦',
      'mp3': '🎵', 'wav': '🎵', 'flac': '🎵',
      'mp4': '🎬', 'avi': '🎬', 'mov': '🎬',
      'jpg': '🖼️', 'jpeg': '🖼️', 'png': '🖼️', 'gif': '🖼️'
    };
    return iconMap[ext] || '📎';
  }

  /**
   * 渲染音频播放器
   * @param {string} id - 音频 ID 或 URL
   * @param {string} duration - 时长（可选）
   * @returns {HTMLElement} 音频播放器元素
   */
  renderAudio(id, duration = '') {
    const container = document.createElement('div');
    container.className = 'sekai-audio-container';

    const audio = document.createElement('audio');
    audio.src = id;
    audio.controls = true;
    audio.className = 'sekai-audio';
    container.appendChild(audio);

    if (duration) {
      const durationEl = document.createElement('span');
      durationEl.className = 'sekai-audio-duration';
      durationEl.textContent = duration;
      container.appendChild(durationEl);
    }

    return container;
  }

  /**
   * 渲染链接卡片
   * @param {string} url - 链接 URL
   * @param {string} title - 标题
   * @param {string} description - 描述（可选）
   * @returns {HTMLElement} 链接卡片元素
   */
  renderLink(url, title = '', description = '') {
    const card = document.createElement('a');
    card.href = url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    card.className = 'sekai-link-card';

    const titleEl = document.createElement('div');
    titleEl.className = 'sekai-link-title';
    titleEl.textContent = title || url;
    card.appendChild(titleEl);

    if (description) {
      const descEl = document.createElement('div');
      descEl.className = 'sekai-link-description';
      descEl.textContent = description;
      card.appendChild(descEl);
    }

    const urlEl = document.createElement('div');
    urlEl.className = 'sekai-link-url';
    urlEl.textContent = url;
    card.appendChild(urlEl);

    return card;
  }

  /**
   * 渲染彩色文字
   * @param {string} hex - 颜色 hex 值
   * @param {string} text - 文本内容
   * @returns {HTMLElement} 彩色文字元素
   */
  renderColorText(hex, text = '') {
    if (!text) {
      return document.createTextNode(`[color:${hex}]`);
    }

    // 标准化 hex（添加 # 前缀）
    let color = hex.trim();
    if (!color.startsWith('#')) {
      color = '#' + color;
    }

    // 验证 hex 格式（3 或 6 位）
    if (!/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(color)) {
      console.warn(`Invalid color hex: ${hex}`);
      return document.createTextNode(text);
    }

    const span = document.createElement('span');
    span.className = 'sekai-color-text';
    span.style.color = color;
    span.textContent = text;

    return span;
  }

  /**
   * 渲染回复引用
   * @param {string} timestamp - 原消息时间戳
   * @param {string} preview - 预览文本（可选）
   * @returns {HTMLElement} 回复引用元素
   */
  renderReply(timestamp, preview = '') {
    const card = document.createElement('div');
    card.className = 'sekai-reply-card';
    card.dataset.replyTo = timestamp;

    const icon = document.createElement('span');
    icon.className = 'sekai-reply-icon';
    icon.textContent = '↩️';
    card.appendChild(icon);

    const content = document.createElement('span');
    content.className = 'sekai-reply-content';
    content.textContent = preview || `回复 #${timestamp}`;
    card.appendChild(content);

    // TODO: 点击跳转到原消息
    card.addEventListener('click', () => {
      console.log(`Jump to message: ${timestamp}`);
      // 未来实现：查找并高亮原消息
    });

    return card;
  }
}

// 导出到全局（兼容非模块化环境）
window.SekaiRenderer = SekaiRenderer;
