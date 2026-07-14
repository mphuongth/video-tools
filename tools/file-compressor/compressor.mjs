#!/usr/bin/env node

import { execFile as execFileCb } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { detectCapabilities } from '../../lib/ffmpeg.mjs';
import { replaceExtension, UserInputError } from '../../lib/http.mjs';

const execFile = promisify(execFileCb);
const ENTRY_URL = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';

const DEFAULT_TARGET_MIB = 25;
const MIN_TARGET_MIB = 1;
const MAX_TARGET_MIB = 100;
const COMPRESS_TIMEOUT_MS = 15 * 60 * 1_000;

/**
 * Re-encodes a video to land near `targetBytes`. Paths in, path out — the server,
 * the CLI, and tests all drive the same code.
 */
export async function compressVideo({ inputPath, outputPath, targetBytes, timeoutMs = COMPRESS_TIMEOUT_MS }) {
  const capabilities = await detectCapabilities();
  if (!capabilities.videoTranscoding) {
    const error = new UserInputError('Video compression needs ffmpeg and ffprobe installed on this machine.');
    error.capabilities = capabilities;
    throw error;
  }

  const durationSeconds = await probeVideoDuration(inputPath);
  const args = buildVideoCompressionArgs(inputPath, outputPath, targetBytes, durationSeconds);
  await execFile('ffmpeg', args, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });

  const { size } = await stat(outputPath);
  return { outputPath, outputBytes: size, durationSeconds };
}

export async function probeVideoDuration(inputPath) {
  const { stdout } = await execFile(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', inputPath],
    { timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout || '{}');
  const duration = Number(parsed?.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Could not read video duration.');
  }
  return duration;
}

/**
 * Turns a target size into a bitrate: the 0.9 factor leaves headroom for
 * container overhead and rate-control overshoot, and the floors keep a long
 * video from being crushed into something unwatchable to hit its target.
 */
export function buildVideoCompressionArgs(inputPath, outputPath, targetBytes, durationSeconds) {
  const targetBitsPerSecond = Math.max(360_000, Math.floor((targetBytes * 8 * 0.9) / durationSeconds));
  const audioBitsPerSecond = 96_000;
  const videoBitsPerSecond = Math.max(250_000, targetBitsPerSecond - audioBitsPerSecond);
  const maxrate = Math.round(videoBitsPerSecond * 1.45);
  const bufsize = Math.round(videoBitsPerSecond * 2.8);

  return [
    '-y',
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-vf',
    "scale='min(1280,iw)':-2",
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-b:v',
    String(videoBitsPerSecond),
    '-maxrate',
    String(maxrate),
    '-bufsize',
    String(bufsize),
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-movflags',
    '+faststart',
    outputPath,
  ];
}

export function normalizeTargetMiB(value) {
  const target = Number(value || DEFAULT_TARGET_MIB);
  if (!Number.isFinite(target)) return DEFAULT_TARGET_MIB;
  return Math.min(MAX_TARGET_MIB, Math.max(MIN_TARGET_MIB, Math.round(target)));
}

async function main() {
  const args = process.argv.slice(2);
  const inputArg = args.find((arg) => !arg.startsWith('-'));

  if (!inputArg || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      [
        'Usage: node tools/file-compressor/compressor.mjs <video> [--target <MiB>] [--out <path>]',
        '',
        `  --target  Target size in MiB (${MIN_TARGET_MIB}-${MAX_TARGET_MIB}, default ${DEFAULT_TARGET_MIB})`,
        '  --out     Output path (default: <name>.compressed.mp4 next to the input)',
        '',
      ].join('\n'),
    );
    return;
  }

  const targetMiB = normalizeTargetMiB(valueForFlag(args, '--target'));
  const inputPath = path.resolve(inputArg);
  const outputPath = path.resolve(
    valueForFlag(args, '--out') ||
      path.join(path.dirname(inputPath), replaceExtension(path.basename(inputPath), '.compressed.mp4')),
  );

  const { size: inputBytes } = await stat(inputPath);
  const result = await compressVideo({
    inputPath,
    outputPath,
    targetBytes: targetMiB * 1024 * 1024,
  });

  process.stdout.write(
    `${formatMiB(inputBytes)} -> ${formatMiB(result.outputBytes)} (target ${targetMiB} MiB)\n${result.outputPath}\n`,
  );
}

function valueForFlag(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? '' : args[index + 1] || '';
}

function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

if (ENTRY_URL === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
