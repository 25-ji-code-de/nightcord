/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SekaiResources } from '../js/renderer/resources.js';
import { SekaiParser } from '../js/renderer/parser.js';
import { readBrowserScript } from '../scripts/browser-source.mjs';

const FileUploadService = new Function('window',
  readBrowserScript('file-upload-service.js') + '\nreturn window.FileUploadService;')({});
const resources = new SekaiResources();
const uploads = new FileUploadService();
const uuid = '79cf470e-6329-4332-b58f-56977f4979d3';
const base = 'https://r2.nightcord.de5.net';
const variants = [
  uuid,
  '79cf470e-6329-4332-b58f- 56977f4979d3',
  '79cf470e-6329-4332-b58f-%2056977f4979d3',
  ' 79cf470e-6329-4332-b58f-\t\u00a056977f4979d3 ',
];

for (const [name, resolve] of [
  ['rendered attachments', (id, kind) => resources.resolveResource(id, kind)],
  ['uploaded attachments', (id, kind) => uploads.getFileUrl(id, kind)],
]) {
  describe(name, () => {
    test('repairs whitespace in UUIDs and keeps the correct resource folder', () => {
      for (const id of variants) {
        for (const [kind, folder] of [['image', 'images'], ['file', 'files'], ['sticker', 'stickers']]) {
          assert.equal(resolve(id, kind), `${base}/${folder}/${uuid}`, `${kind}: ${id}`);
        }
      }
    });

    test('preserves spaces and encoding in legacy keys and invalid UUIDs', () => {
      for (const key of ['old/my photo.png', 'old/my%20photo.png', 'my photo.png',
        '79cf470e-6329-4332-b58f- 56977f4979d', `${uuid} extra`]) {
        assert.equal(resolve(key, 'image'), `${base}/${key}`);
      }
    });

    test('preserves absolute URLs, signed query strings, and data URLs', () => {
      for (const url of [`${base}/old/my%20photo.png?signature=keep%20this`,
        `https://other.example/${variants[2]}`,
        'data:image/png;base64,aGVsbG8=']) {
        assert.equal(resolve(url, 'image'), url);
      }
    });
  });
}

test('existing v1 and v2 image messages resolve to the original image without editing the message', () => {
  const parser = new SekaiParser();
  for (const id of variants.slice(1)) {
    for (const message of [`[img:${id}]`, `<$SEKAI:Image:w=3024;h=4032:${id}>`]) {
      const [token] = parser.tokenize(message);
      assert.equal(token.type, 'sekai');
      assert.equal(resources.resolveResource(token.data, 'image'), `${base}/images/${uuid}`);
      assert.equal(token.raw, message);
    }
  }
});
