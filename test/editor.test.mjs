import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeProject, validateProject } from '../tools/video-zoom-editor/editor.mjs';

/** normalize then validate, the way the server does before handing work to ffmpeg. */
function check(rawProject) {
  return validateProject(normalizeProject(rawProject));
}

test('normalizeProject fills defaults and ignores non-array input', () => {
  const project = normalizeProject({ zooms: 'nope', texts: undefined });
  assert.deepEqual(project.zooms, []);
  assert.deepEqual(project.texts, []);
});

test('normalizeProject assigns ids and a default scale to bare zooms', () => {
  const { zooms } = normalizeProject({ zooms: [{ start: 0, end: 2, x: 0.5, y: 0.5 }] });
  assert.equal(zooms[0].id, 'z1');
  assert.equal(zooms[0].scale, 1.8);
});

test('validateProject accepts a well-formed project', () => {
  assert.doesNotThrow(() =>
    check({
      zooms: [{ start: 0, end: 2, x: 0.5, y: 0.5, scale: 2 }],
      texts: [{ start: 1, end: 3, x: 0.5, y: 0.5, text: 'hello', fontSize: 42 }],
    }),
  );
});

test('validateProject rejects an inverted time range', () => {
  assert.throws(() => check({ zooms: [{ start: 3, end: 1, x: 0.5, y: 0.5, scale: 2 }] }), /invalid time range/i);
});

test('validateProject rejects an out-of-bounds scale', () => {
  assert.throws(() => check({ zooms: [{ start: 0, end: 2, x: 0.5, y: 0.5, scale: 9 }] }), /scale/i);
  assert.throws(() => check({ zooms: [{ start: 0, end: 2, x: 0.5, y: 0.5, scale: 1 }] }), /scale/i);
});

test('validateProject rejects a position outside the frame', () => {
  assert.throws(() => check({ zooms: [{ start: 0, end: 2, x: 1.5, y: 0.5, scale: 2 }] }), /position/i);
});

test('validateProject rejects overlapping zooms', () => {
  assert.throws(
    () =>
      check({
        zooms: [
          { start: 0, end: 3, x: 0.5, y: 0.5, scale: 2 },
          { start: 2, end: 5, x: 0.5, y: 0.5, scale: 2 },
        ],
      }),
    /overlap/i,
  );
});

test('validateProject rejects empty text and out-of-range font size', () => {
  assert.throws(() => check({ texts: [{ start: 0, end: 2, x: 0.5, y: 0.5, text: '   ' }] }), /empty/i);
  assert.throws(
    () => check({ texts: [{ start: 0, end: 2, x: 0.5, y: 0.5, text: 'hi', fontSize: 999 }] }),
    /font size/i,
  );
});
