/* SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (C) 2025 The 25-ji-code-de Team */
/** UploadView: uploads component; ui supplies shared presentation context. */
class UploadView {
  constructor(ui) { this.ui = ui; }

  setFileUploadMenuOpen(open) {
    this.ui.elements.fileUploadMenu?.classList.toggle('hidden', !open);
    this.ui.elements.attachmentBtn?.setAttribute('aria-expanded', String(open));
  }

  /**
   * 设置文件上传功能
   */
  setupFileUpload() {
    const { attachmentBtn, fileUploadMenu, imageInput, musicInput, fileInput, chatInput } = this.ui.elements;

    if (!attachmentBtn || !fileUploadMenu) {
      console.warn('文件上传初始化失败: 未找到必需的元素');
      return;
    }

    // 点击附件按钮显示/隐藏菜单
    attachmentBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.setFileUploadMenuOpen(fileUploadMenu.classList.contains('hidden'));
    });

    // 点击其他地方关闭菜单
    document.addEventListener('click', (e) => {
      if (!attachmentBtn.contains(e.target) && !fileUploadMenu.contains(e.target)) {
        this.setFileUploadMenuOpen(false);
      }
    });

    // 菜单项点击
    const menuItems = fileUploadMenu.querySelectorAll('.file-upload-menu-item');
    menuItems.forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const type = item.dataset.type;
        this.setFileUploadMenuOpen(false);

        if (type === 'image') {
          imageInput.click();
        } else if (type === 'music') {
          musicInput.click();
        } else if (type === 'file') {
          fileInput.click();
        }
      });
    });

    const dismissMenu = event => {
      if (event.key !== 'Escape' || event.isComposing || fileUploadMenu.classList.contains('hidden')) return;
      event.preventDefault();
      event.stopPropagation();
      this.setFileUploadMenuOpen(false);
      attachmentBtn.focus();
    };
    attachmentBtn.addEventListener('keydown', dismissMenu);
    fileUploadMenu.addEventListener('keydown', dismissMenu);

    // 拖拽上传支持
    const dropZone = document.body;
    let dragCounter = 0;

    // 创建拖拽覆盖层
    const overlay = document.createElement('div');
    overlay.className = 'drag-overlay hidden';
    overlay.innerHTML = `
      <div class="drag-message">
        <svg viewBox="0 0 24 24" width="64" height="64" fill="currentColor" aria-hidden="true" focusable="false"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>
        <span>释放文件以上传</span>
      </div>
    `;
    document.body.appendChild(overlay);
    const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');

    dropZone.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragCounter++;
      if (dragCounter === 1) {
        overlay.classList.remove('hidden');
        // 强制重绘以触发 transition
        overlay.offsetHeight;
        overlay.classList.add('visible');
      }
    });

    dropZone.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) {
        overlay.classList.remove('visible');
        setTimeout(() => { if (dragCounter === 0) overlay.classList.add('hidden'); }, 200);
      }
    });

    dropZone.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
    });

    dropZone.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragCounter = 0;
      overlay.classList.remove('visible');
      setTimeout(() => { if (dragCounter === 0) overlay.classList.add('hidden'); }, 200);

      const files = e.dataTransfer.files;
      if (files.length > 0) {
        const file = files[0];
        // 简单判断类型
        let type = 'file';
        if (file.type.startsWith('image/')) {
          type = 'image';
        } else if (file.type.startsWith('audio/')) {
          type = 'music';
        }
        this.ui.handleFileUpload(file, type);
      }
    });

    // 粘贴上传支持
    if (chatInput) {
      chatInput.addEventListener('paste', (e) => {
        const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
        if (!items) return;
        for (const item of items) {
          if (item.kind === 'file') {
            const file = item.getAsFile();
            if (!file) continue;
            e.preventDefault();
            let type = 'file';
            if (file.type.startsWith('image/')) {
              type = 'image';
            } else if (file.type.startsWith('audio/')) {
              type = 'music';
            }
            this.ui.handleFileUpload(file, type);
            return; // 只处理第一个文件
          }
        }
      });
    }

    // 文件选择处理
    imageInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this.ui.handleFileUpload(file, 'image');
      imageInput.value = ''; // 清空以允许重复选择同一文件
    });

    musicInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this.ui.handleFileUpload(file, 'music');
      musicInput.value = '';
    });

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this.ui.handleFileUpload(file, 'file');
      fileInput.value = ''; // 清空以允许重复选择同一文件
    });
  }

  /**
   * 处理文件上传
   * @param {File} file 要上传的文件
   * @param {string} uploadType 上传类型：'image' 或 'file'
   */
  _insertPlaceholder(chatInput, placeholder) {
    if (!chatInput) return false;

    const cursorPos = chatInput.selectionStart ?? chatInput.value.length;
    const selectionEnd = chatInput.selectionEnd ?? cursorPos;
    const textBefore = chatInput.value.substring(0, cursorPos);
    const textAfter = chatInput.value.substring(selectionEnd);

    chatInput.value = textBefore + placeholder + textAfter;

    const newPos = cursorPos + placeholder.length;
    chatInput.setSelectionRange(newPos, newPos);
    chatInput.focus();
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));

    return true;
  }

  _showUploadProgress(uploadProgress, uploadFilename, uploadPercent, uploadFill, filename) {
    uploadProgress.classList.remove('hidden');
    uploadFilename.textContent = filename;
    uploadPercent.textContent = '0%';
    uploadFill.style.width = '0%';
  }

  _replacePlaceholderInInput(chatInput, placeholder, fileMsg, placeholderInserted) {
    if (!chatInput) return;

    if (placeholderInserted && chatInput.value.includes(placeholder)) {
      const currentPos = chatInput.selectionStart;
      const placeholderIndex = chatInput.value.indexOf(placeholder);

      chatInput.value = chatInput.value.replace(placeholder, fileMsg);

      if (currentPos > placeholderIndex) {
        const extraChars = fileMsg.length - placeholder.length;
        const newPos = currentPos + extraChars;
        chatInput.setSelectionRange(newPos, newPos);
      } else {
        chatInput.setSelectionRange(currentPos, currentPos);
      }
    } else {
      const text = chatInput.value;
      chatInput.value = text + (text.length > 0 && !text.endsWith(' ') ? ' ' : '') + fileMsg;
      chatInput.scrollTop = chatInput.scrollHeight;
    }

    chatInput.focus();
    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  _removePlaceholder(chatInput, placeholder, placeholderInserted) {
    if (chatInput && placeholderInserted && chatInput.value.includes(placeholder)) {
      chatInput.value = chatInput.value.replace(placeholder, '');
      chatInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  async handleFileUpload(file, uploadType) {
    if (this.ui.managedChat) { this.ui.setConnectionStatus('用户房间暂不支持上传附件。'); return; }
    const room = this.ui.currentRoom;
    const { uploadProgress, uploadFilename, uploadPercent, uploadFill, chatInput } = this.ui.elements;

    // 验证文件大小：上传服务会按 direct / multipart / compat 选择端口。
    const maxSize = this.ui.fileUploadService.multipartMaxUploadBytes || FileUploadService.MULTIPART_MAX_UPLOAD_BYTES;
    if (!FileUploadService.validateSize(file, maxSize)) {
      this.ui.addChatMessage('系统', `文件过大，最大支持 ${FileUploadService.formatSize(maxSize)}`, Date.now(), this.ui.systemIcon, 'bg-red-600');
      return;
    }

    const placeholder = `[上传中: ${file.name}...]`;
    const placeholderInserted = this._insertPlaceholder(chatInput, placeholder);
    this._showUploadProgress(uploadProgress, uploadFilename, uploadPercent, uploadFill, file.name);

    try {
      // Pre-read image dimensions so v2 upload can store w/h in meta
      let extra = { kind: uploadType === 'image' ? 'image' : 'file' };
      if (uploadType === 'image') {
        try {
          const wh = await this.ui._readImageDimensions(file);
          if (wh) {
            extra.w = wh.w;
            extra.h = wh.h;
          }
        } catch (_) { /* ignore */ }
      }

      // 进度条是「假进度」：传输映射到 ~0–92%，等服务端落盘时缓爬到 99%，
      // 真正 2xx 后才到 100%。全程只显示百分比，不切换文案。
      const result = await this.ui.fileUploadService.upload(file, file.name, (percent) => {
        uploadPercent.textContent = `${percent}%`;
        uploadFill.style.width = `${percent}%`;
      }, extra);

      // 服务端已响应；拼 token 期间保持 100%，避免条先消失、输入框还是占位符
      uploadPercent.textContent = '100%';
      uploadFill.style.width = '100%';

      const id = result.uuid || result.key;
      const kind = result.kind || extra.kind || 'file';
      const fileUrl = this.ui.fileUploadService.getFileUrl(id, kind);
      const fileMsg = await this.ui._generateFileMessage(uploadType, fileUrl, file, result);

      if (this.ui.managedChat || this.ui.currentRoom !== room) return;
      this._replacePlaceholderInInput(chatInput, placeholder, fileMsg, placeholderInserted);
      uploadProgress.classList.add('hidden');

    } catch (error) {
      if (this.ui.managedChat || this.ui.currentRoom !== room) return;
      console.error('文件上传失败:', error);
      uploadProgress.classList.add('hidden');
      this.ui.addChatMessage('系统', `文件上传失败: ${error.message}`, Date.now(), this.ui.systemIcon, 'bg-red-600');
      this._removePlaceholder(chatInput, placeholder, placeholderInserted);
    }
  }
}
