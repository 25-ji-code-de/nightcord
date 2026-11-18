/* SPDX-License-Identifier: AGPL-3.0-only */
window.bindComposerFormat = function (ui, limit) {
  const input = ui.elements.chatInput;
  const trigger = document.getElementById('formatBtn');
  const panel = document.getElementById('formatPanel');
  if (!input || !trigger || !panel) return;

  const home = panel.querySelector('[data-home]');
  const title = panel.querySelector('h2');
  const back = panel.querySelector('[data-back]');
  const form = panel.querySelector('form');
  const fields = form.elements;
  const trueColor = panel.querySelector('.format-truecolor');
  const tooltip = trueColor.querySelector('[role="tooltip"]');
  const error = panel.querySelector('[role="status"]');
  const marks = { bold: '**', italic: '*', strike: '~~', spoiler: '||', inline: '`' };
  let editor, start, end, draft;

  function showError(message = '') {
    error.textContent = message;
    error.hidden = !message;
  }

  function close(focus) {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    focus?.focus({ preventScroll: true });
  }

  function showHome() {
    editor = null;
    form.hidden = back.hidden = true;
    home.hidden = false;
    title.textContent = trigger.title;
    showError();
  }

  trigger.addEventListener('click', () => {
    if (!panel.hidden) return close(trigger);
    draft = input.value;
    start = input.selectionStart;
    end = input.selectionEnd;
    ui.autocomplete?.hideList();
    ui.elements.fileUploadMenu?.classList.add('hidden');
    showHome();
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    home.querySelector('button').focus({ preventScroll: true });
  });

  function dismissOutside(event) {
    if (!panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target)) close();
  }
  document.addEventListener('pointerdown', dismissOutside, true);
  document.addEventListener('focusin', dismissOutside);
  for (const event of ['pointerenter', 'focusin']) {
    trueColor.addEventListener(event, () => { delete trueColor.dataset.dismissed; });
  }
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    if (getComputedStyle(tooltip).visibility === 'visible' && trueColor.getClientRects().length) {
      trueColor.dataset.dismissed = '';
      return;
    }
    close(trigger);
  });
  panel.querySelector('[data-close]').addEventListener('click', () => close(trigger));
  back.addEventListener('click', () => {
    const previous = editor;
    showHome();
    home.querySelector('[data-editor="' + previous + '"]').focus();
  });

  function insert(text, caret = text.length) {
    // Upload completion can replace a placeholder while the panel has focus.
    if (input.value !== draft) return showError('草稿已更新，请重新选择插入位置。');
    if (draft.length - (end - start) + text.length > limit) {
      return showError('插入后会超过 ' + limit + ' 字符，草稿未修改。');
    }
    input.setRangeText(text, start, end, 'end');
    input.setSelectionRange(start + caret, start + caret);
    close(input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  home.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const selection = draft.slice(start, end);
    const mark = button.dataset.mark;
    if (mark === 'quote') {
      // A quote must start on a fresh line, and not absorb the rest of the draft.
      const lead = start && draft[start - 1] !== '\n' ? '\n' : '';
      const tail = end < draft.length && draft[end] !== '\n' ? '\n' : '';
      const quote = lead + '> ' + selection.replaceAll('\n', '\n> ');
      return insert(quote + tail, quote.length);
    }
    if (mark) {
      const delimiter = marks[mark];
      const text = selection ? selection.split('\n').map(line =>
        line ? delimiter + line + delimiter : ''
      ).join('\n') : delimiter + delimiter;
      return insert(text, selection ? text.length : delimiter.length);
    }

    editor = button.dataset.editor;
    form.reset();
    form.querySelector('details').open = false;
    showError();
    home.hidden = true;
    back.hidden = form.hidden = false;
    title.textContent = button.textContent.trim();
    updateFields();
    panel.querySelector('[data-content-label]').textContent = editor === 'code' ? '代码' : '文字';
    if (editor === 'link') {
      const isUrl = /^https?:\/\//i.test(selection);
      fields.url.value = isUrl ? selection : '';
      fields.caption.value = isUrl ? '' : selection;
      (isUrl ? fields.caption : fields.url).focus();
    } else if (editor === 'media') {
      fields.resource.value = selection.trim();
      fields.resource.focus();
    } else {
      fields.content.value = selection;
      fields.content.focus();
    }
  });

  function updateFields() {
    const active = editor === 'media' ? [editor, fields.kind.value] : [editor];
    for (const group of form.querySelectorAll('[data-for]')) {
      group.hidden = !group.dataset.for.split(' ').some(kind => active.includes(kind));
      for (const field of group.querySelectorAll('input, textarea, select')) field.disabled = group.hidden;
    }
    form.querySelector('details').hidden = editor === 'media' && fields.kind.value === 'sticker';
    fields.accent.disabled = editor !== 'link' || !fields.tint.checked;
  }

  fields.kind.addEventListener('change', updateFields);
  fields.tint.addEventListener('change', () => { fields.accent.disabled = !fields.tint.checked; });
  form.addEventListener('input', () => showError());
  form.addEventListener('submit', event => {
    event.preventDefault();
    const options = [];
    const add = (key, value) => {
      if (value) options.push({ key, value: encodeURIComponent(value), encode: false });
    };
    let type, payload;
    if (editor === 'link') {
      type = 'Embed';
      payload = fields.url.value.trim();
      if (!URL.canParse(payload) || !['http:', 'https:'].includes(new URL(payload).protocol)) {
        fields.url.focus();
        return showError('请输入 http 或 https 网址。');
      }
      add('title', fields.caption.value);
      add('desc', fields.description.value);
      add('domain', fields.source.value);
      if (fields.tint.checked) add('color', fields.accent.value.slice(1));
    } else if (editor === 'color') {
      type = 'Format';
      payload = fields.content.value;
      add('color', fields.ink.value.slice(1));
      if (fields.preserve.checked) add('preserve', 'true');
      if (fields.spoiler.checked) add('spoiler', 'true');
    } else if (editor === 'code') {
      type = 'Code';
      payload = fields.content.value;
      add('lang', fields.lang.value.trim());
      add('name', fields.codeName.value);
      if (fields.collapse.checked) add('collapse', 'true');
    } else if (editor === 'media') {
      const kind = fields.kind.value;
      payload = fields.resource.value.trim();
      const webUrl = /^https?:\/\//i.test(payload) && URL.canParse(payload);
      const storageKey = /^[\w-]+(?:\/[\w.-]+)*$/.test(payload);
      if (!webUrl && !storageKey) return showError('请填写完整的 http、https 网址或已上传的资源 ID。');
      if (kind === 'image') {
        type = 'Image';
        if (!!fields.width.value !== !!fields.height.value) return showError('图片宽度和高度需要一起填写。');
        add('alt', fields.alt.value);
        add('w', fields.width.value);
        add('h', fields.height.value);
        if (fields.hideImage.checked) add('spoiler', 'true');
      } else if (kind === 'sticker') {
        type = 'Stamp';
        add('custom', 'true');
      } else {
        type = 'Files';
        if (kind === 'file') {
          add('name', fields.filename.value);
          add('size', fields.size.value);
        } else {
          const extension = payload.split(/[?#]/)[0].split('.').pop().toLowerCase();
          const audioTypes = new Map(Object.entries({
            mp3: 'mpeg', m4a: 'mp4', oga: 'ogg', aac: 'aac', wav: 'wav',
            flac: 'flac', ogg: 'ogg', opus: 'opus', webm: 'webm',
          }));
          add('type', 'audio/' + (audioTypes.get(extension) || 'mpeg'));
          add('duration', fields.duration.value);
          if (kind === 'music') {
            add('title', fields.track.value);
            add('artist', fields.artist.value);
          }
        }
      }
    } else return;

    // Keep ordinary payloads readable. Encode delimiters and stamp shorthand
    // that the existing send path would otherwise rewrite inside a code sample.
    if (/[>\r\n]|\[stamp_?\d+\]/i.test(payload)) {
      add('enc', 'base64');
      payload = ui.sekaiRenderer.base64EncodeUtf8(payload);
    }
    // No clipping: insert() checks the actual encoded token against the whole draft.
    insert(ui._buildSekaiV2Token(type, options, payload, Infinity));
  });
};
