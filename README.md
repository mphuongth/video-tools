# Video Tools

Local tools for editing and processing screen recordings and other video files.

## Tools

- `Video Zoom Editor`: add manual zooms and text overlays to QuickTime, OBS, Loom, `.mov`, or `.mp4` recordings, then export an H.264 MP4.

## Requirements

- Node.js 18+
- `pnpm`
- `ffmpeg`
- `ffprobe`
- macOS Swift toolchain when the local `ffmpeg` build does not include `drawtext`

## Run

```bash
pnpm video-zoom-editor
```

Open `http://127.0.0.1:4320`.

## Structure

```text
tools/
  video-zoom-editor/
```
