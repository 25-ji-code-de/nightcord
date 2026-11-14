/* SPDX-License-Identifier: AGPL-3.0-only */
// Edit the geometric SVG sources in icons/navigation, then run this script.
// Inline copies inherit currentColor and need no runtime asset requests.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const icons = new Map();
for (const name of ['house', 'search', 'plane', 'at', 'envelope', 'chevrons', 'check', 'help', 'gear', 'text', 'speaker', 'offline', 'camera', 'mic', 'mic-off']) {
  const source = readFileSync(join(root, 'icons/navigation', `${name}.svg`), 'utf8');
  const [, attributes, content] = source.match(/^<svg\s+([^>]+)>([\s\S]*?)<\/svg>\s*$/);
  icons.set(name, {
    attributes: attributes.replace(/\s*xmlns="[^"]*"/, '').trim(),
    body: content.replace(/<title>[\s\S]*?<\/title>/, '').trim(),
  });
}

function inline(name, existing = '') {
  const { attributes, body } = icons.get(name);
  const layout = [...existing.matchAll(/(?:^|\s)(?:class|width|height)="[^"]*"/g)].map(match => match[0].trim());
  return `<svg ${layout.length ? layout.join(' ') + ' ' : ''}${attributes} aria-hidden="true" focusable="false" data-navigation-icon="${name}">${body}</svg>`;
}

function sync(source, memberIcons = false) {
  return source.replace(/<svg\b([^>]*\bdata-(?:reference|navigation)-icon="([^"]+)"[^>]*)>[\s\S]*?<\/svg>/g, (svg, attributes, name) => {
    if (name === 'mic-state') return svg;
    const className = attributes.match(/(?:^|\s)class="[^"]*"/)?.[0] || '';
    const size = memberIcons ? name === 'camera' ? 'width="18" height="16"' : 'width="14" height="16"' : '';
    return inline(name, `${className} ${size}`);
  });
}

const htmlPath = join(root, 'index.html');
let html = readFileSync(htmlPath, 'utf8');
// Keep both microphone states in the account icon; the existing CSS selects
// the state, so switching never changes the icon's bounds or fetches an asset.
html = html.replace(/<svg\b[^>]*\bclass="sidebar-microphone[^"]*"[^>]*>[\s\S]*?<\/svg>/, () => {
  const { attributes } = icons.get('mic-off');
  const on = icons.get('mic');
  const [, weight] = on.attributes.match(/\bstroke-width="([^"]+)"/);
  return `<svg class="sidebar-microphone" ${attributes} aria-hidden="true" focusable="false" data-navigation-icon="mic-state">${icons.get('mic-off').body}${on.body.replace('<path ', `<path stroke-width="${weight}" `)}</svg>`;
});
html = sync(html);

const uiPath = join(root, 'ui-manager.js');
let ui = sync(readFileSync(uiPath, 'utf8'), true);
// Upgrade the previous unmarked muted icon once. Future runs sync its marker.
ui = ui.replace(/(:\s*')<svg width="14" height="16" viewBox="0 0 16 24"[^>]*>[\s\S]*?<\/svg>(')/, (_, start, end) => `${start}${inline('mic-off', 'width="14" height="16"')}${end}`);

writeFileSync(htmlPath, html);
writeFileSync(uiPath, ui);
console.log('Navigation SVG sources synchronized to index.html and ui-manager.js.');
