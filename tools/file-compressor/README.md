# File Compressor

Re-encodes a video so it lands near a target size — enough to get a screen recording under the
25 MiB limit on a GitHub issue, a pull request, or a chat thread, without hand-tuning ffmpeg flags.

Non-video files are gzipped in the browser with `CompressionStream`; that path never touches the
server.

## Use it

In the browser, from the Video Tools landing page or directly at `/tools/file-compressor`.

Headless:

```bash
pnpm compress demo.mov                      # target 25 MiB
pnpm compress demo.mov --target 8           # target 8 MiB
pnpm compress demo.mov --out /tmp/small.mp4 # choose the output path
```

The input is never modified. Output defaults to `<name>.compressed.mp4` next to the input.

## How the target size is hit

`buildVideoCompressionArgs` turns the target size into a bitrate: `targetBytes * 8 * 0.9 / duration`,
minus 96 kbit/s for audio. The 0.9 leaves headroom for container overhead and rate-control overshoot,
so the output lands slightly under target rather than slightly over — the direction that matters when
a hard limit is the whole point.

Floors of 360 kbit/s (total) and 250 kbit/s (video) stop a long video from being crushed into
something unwatchable, which means **a long enough video can exceed its target**. Video is also
scaled to at most 1280px wide and encoded as H.264/AAC.

## API

```js
import { compressVideo } from './compressor.mjs';

const { outputBytes, durationSeconds } = await compressVideo({
  inputPath: 'demo.mov',
  outputPath: 'demo.compressed.mp4',
  targetBytes: 8 * 1024 * 1024,
});
```
