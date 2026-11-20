/* SPDX-License-Identifier: AGPL-3.0-only */
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
export const browserComponents = JSON.parse(readFileSync(new URL('browser-components.json', import.meta.url), 'utf8'));

// Isolated VM/browser fixtures load the same companion scripts as index.html.
export function readBrowserScript(file) {
  return [...(browserComponents[file] || []).map(readBrowserScript),
    readFileSync(new URL(file, root), 'utf8')].join('\n');
}

export function readBrowserStyle(file) {
  return readFileSync(new URL(file, root), 'utf8').replace(
    /@import url\("\/([^"\n]+)"\);/g, (_, path) => readBrowserStyle(path));
}
