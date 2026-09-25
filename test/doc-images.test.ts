// Checks the screenshots under docs/images, which README.md and the docs pages show: every image a page
// references exists, and every PNG stays small and carries no metadata chunk (text, EXIF or time)
// that could hold a local path, a user name or anything else not visible in the picture itself.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const imagesDir = path.join(root, 'docs', 'images');
const MAX_BYTES = 500 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** README.md plus every docs/*.md page, as repository-relative paths. */
function pages(): string[] {
  const docs = readdirSync(path.join(root, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`);
  return ['README.md', ...docs];
}

/** The local targets of every Markdown image (`![alt](target)`) in `markdown`. */
function imageTargets(markdown: string): string[] {
  return [...markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((match) => match[1] ?? '')
    .filter((target) => !/^[a-z]+:/i.test(target));
}

/** The chunk types of a PNG file, in order; throws when the file is not a well-formed PNG. */
function pngChunkTypes(file: string): string[] {
  const bytes = readFileSync(file);
  assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE), `${file} is not a PNG`);
  const types: string[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length, `${file}: truncated chunk at byte ${offset}`);
    const length = bytes.readUInt32BE(offset);
    types.push(bytes.toString('latin1', offset + 4, offset + 8));
    offset += 12 + length;
  }
  assert.equal(offset, bytes.length, `${file}: chunk lengths do not add up to the file size`);
  return types;
}

const screenshots = existsSync(imagesDir) ? readdirSync(imagesDir).filter((name) => name.endsWith('.png')) : [];

test('every image referenced from README.md and docs/*.md exists', () => {
  let checked = 0;
  for (const page of pages()) {
    for (const target of imageTargets(readFileSync(path.join(root, page), 'utf8'))) {
      const file = path.join(root, path.dirname(page), decodeURIComponent(target));
      assert.ok(existsSync(file), `${page} shows ${target}, which does not exist`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, 'sanity: the pages show at least one image');
});

test('README.md shows a dashboard screenshot from docs/images', () => {
  const targets = imageTargets(readFileSync(path.join(root, 'README.md'), 'utf8'));
  assert.ok(
    targets.some((target) => target.startsWith('docs/images/') && target.endsWith('.png')),
    'README.md has no docs/images screenshot',
  );
});

test('docs/images holds the overview and substitution-drawer shots at 1440 and 390, dark and light', () => {
  for (const view of ['overview', 'drawer-substitution']) {
    for (const width of ['1440', '390']) {
      for (const theme of ['dark', 'light']) {
        const name = `${view}-${width}-${theme}.png`;
        assert.ok(screenshots.includes(name), `docs/images/${name} is missing`);
      }
    }
  }
});

test('every docs/images PNG is under 500 KB and carries no metadata chunk', () => {
  assert.ok(screenshots.length > 0, 'sanity: docs/images has screenshots');
  for (const name of screenshots) {
    const file = path.join(imagesDir, name);
    const size = statSync(file).size;
    assert.ok(size < MAX_BYTES, `docs/images/${name} is ${size} bytes, over 500 KB`);
    const extra = pngChunkTypes(file).filter((type) => !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type));
    assert.deepEqual(extra, [], `docs/images/${name} carries metadata chunks: ${extra.join(', ')}`);
  }
});
