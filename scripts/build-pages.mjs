/* SPDX-License-Identifier: AGPL-3.0-only */
import { cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, 'dist');
mkdirSync(output, { recursive: true });

// Publish only browser assets. Backend source, dependencies, and local config
// must never become part of the Pages upload or its file-count budget.
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && (/\.(?:html|js|css|mp3|opus)$/.test(entry.name) || ['_headers', 'manifest.json'].includes(entry.name))) {
    cpSync(join(root, entry.name), join(output, entry.name));
  }
}
for (const directory of ['css', 'icons', 'vendor']) {
  cpSync(join(root, directory), join(output, directory), { recursive: true });
}
writeFileSync(join(output, 'version.json'), JSON.stringify({ v: String(Date.now()) }) + '\n');
console.log('Pages assets built in dist/');
