import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/**
 * Both tools stand on the same two binaries, so capability detection lives here
 * rather than in either one. Missing binaries are a normal state on a fresh
 * machine, not a fault, so every flag is reported instead of thrown.
 */
export async function detectCapabilities() {
  const [ffmpeg, ffprobe] = await Promise.all([
    isCommandAvailable('ffmpeg'),
    isCommandAvailable('ffprobe'),
  ]);

  return {
    ffmpeg,
    ffprobe,
    // Zoom editor: renders the edit.
    videoRendering: ffmpeg && ffprobe,
    // File compressor: transcodes down to a target size.
    videoTranscoding: ffmpeg && ffprobe,
    // Text overlays are drawn in-process with @napi-rs/canvas, so text export
    // works anywhere ffmpeg does — no drawtext filter or Swift toolchain needed.
    textRendering: true,
    pngTextFallback: true,
  };
}

async function isCommandAvailable(command) {
  try {
    await execFile(command, ['-version'], { timeout: 5_000, maxBuffer: 256 * 1024 });
    return true;
  } catch {
    return false;
  }
}
