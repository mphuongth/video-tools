import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTargetMiB, buildVideoCompressionArgs } from '../tools/file-compressor/compressor.mjs';

test('normalizeTargetMiB clamps into range, rounds, and falls back to the default', () => {
  assert.equal(normalizeTargetMiB(8), 8);
  assert.equal(normalizeTargetMiB('12'), 12);
  assert.equal(normalizeTargetMiB(0.4), 1); // a real value below the minimum clamps up
  assert.equal(normalizeTargetMiB(9999), 100); // above the maximum
  assert.equal(normalizeTargetMiB(7.6), 8); // rounded
  assert.equal(normalizeTargetMiB(undefined), 25); // default
  assert.equal(normalizeTargetMiB('not a number'), 25);
  assert.equal(normalizeTargetMiB(0), 25); // 0 reads as "unset", not as a floor to clamp
});

/** Pull the value that follows a flag out of the ffmpeg arg list. */
function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

test('buildVideoCompressionArgs derives a bitrate from the target size and duration', () => {
  const targetBytes = 25 * 1024 * 1024;
  const args = buildVideoCompressionArgs('in.mov', 'out.mp4', targetBytes, 60);
  const videoBitrate = Number(argValue(args, '-b:v'));

  // 25 MiB over 60s, with the 0.9 headroom factor and 96k audio removed.
  const expected = Math.floor((targetBytes * 8 * 0.9) / 60) - 96_000;
  assert.equal(videoBitrate, expected);
});

test('buildVideoCompressionArgs holds a bitrate floor so long clips stay watchable', () => {
  // A two-hour clip into 5 MiB would compute a tiny bitrate without the floor.
  // The effective floor is the 360k total-bitrate floor minus 96k audio = 264k;
  // the explicit 250k video floor never binds because the total floor is higher.
  const args = buildVideoCompressionArgs('in.mov', 'out.mp4', 5 * 1024 * 1024, 7200);
  assert.equal(Number(argValue(args, '-b:v')), 360_000 - 96_000);
});

test('buildVideoCompressionArgs keeps maxrate and bufsize consistent with the video bitrate', () => {
  const args = buildVideoCompressionArgs('in.mov', 'out.mp4', 25 * 1024 * 1024, 60);
  const videoBitrate = Number(argValue(args, '-b:v'));
  assert.equal(Number(argValue(args, '-maxrate')), Math.round(videoBitrate * 1.45));
  assert.equal(Number(argValue(args, '-bufsize')), Math.round(videoBitrate * 2.8));
});

test('buildVideoCompressionArgs produces a portable, upload-friendly encode', () => {
  const args = buildVideoCompressionArgs('in.mov', 'out.mp4', 25 * 1024 * 1024, 60);
  assert.equal(argValue(args, '-c:v'), 'libx264');
  assert.equal(argValue(args, '-pix_fmt'), 'yuv420p');
  assert.equal(argValue(args, '-vf'), "scale='min(1280,iw)':-2"); // never upscale
  assert.ok(args.includes('+faststart')); // streams before fully downloaded
  assert.equal(args.at(-1), 'out.mp4'); // output stays last
});
