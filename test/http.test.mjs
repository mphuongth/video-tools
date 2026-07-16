import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeFileName, replaceExtension } from '../lib/http.mjs';

test('sanitizeFileName strips path separators so an upload cannot escape the temp dir', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('/absolute/path/clip.mov'), 'clip.mov');
  assert.equal(sanitizeFileName('nested\\windows\\clip.mp4'), 'nested_windows_clip.mp4');
});

test('sanitizeFileName keeps ordinary names and drops unusual characters', () => {
  assert.equal(sanitizeFileName('My Recording (final).mov'), 'My Recording (final).mov');
  assert.equal(sanitizeFileName('screen*cast?.mp4'), 'screen_cast_.mp4');
});

test('sanitizeFileName never returns an empty name', () => {
  assert.equal(sanitizeFileName(''), 'file');
  assert.equal(sanitizeFileName(null), 'file');
  assert.equal(sanitizeFileName('   '), 'file'); // trims to empty, then falls back
});

test('sanitizeFileName replaces unusual characters rather than dropping them', () => {
  assert.equal(sanitizeFileName('***'), '___'); // still safe — no separators survive
});

test('sanitizeFileName caps the length', () => {
  const long = `${'a'.repeat(500)}.mov`;
  assert.ok(sanitizeFileName(long).length <= 160);
});

test('replaceExtension swaps the suffix and sanitizes at the same time', () => {
  assert.equal(replaceExtension('clip.mov', '.compressed.mp4'), 'clip.compressed.mp4');
  assert.equal(replaceExtension('../secret.mov', '.edited.mp4'), 'secret.edited.mp4');
  assert.equal(replaceExtension('no-extension', '.mp4'), 'no-extension.mp4');
});
