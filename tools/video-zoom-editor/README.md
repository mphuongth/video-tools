# Video Zoom Editor

Local post-production editor for screen recordings from QuickTime, OBS, Loom exports, or any `.mov`/`.mp4` file the browser can preview.

It lets you add manual zooms and text callouts after recording, then renders a final MP4 through `ffmpeg`.

## Run

One server hosts every tool in the repo:

```sh
pnpm install
pnpm start
```

Open:

```text
http://127.0.0.1:4320/tools/video-zoom-editor
```

Use a custom port if needed:

```sh
VIDEO_TOOLS_PORT=4321 pnpm start
```

The editor page also loads from a static host (see the live demo in the root README), but export needs this server, because that is where `ffmpeg` runs.

## Workflow

1. Open or drag in a video file.
2. Move the playhead to the moment you want to edit.
3. Use `Add Zoom`, then click the preview.
4. Use `Add Text`, then click the preview and edit the text in the side panel.
5. Adjust start/end/scale/position in the event list.
6. Click `Export MP4`.

## Requirements

- `ffmpeg`
- `ffprobe`

Zooms are rendered with the `ffmpeg` `zoompan` filter; text overlays are drawn to a PNG with [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas) (prebuilt, cross-platform) and composited over the video, so export works on macOS and Linux without a Swift toolchain.

The capabilities endpoint shows what is available:

```sh
curl -fsS http://127.0.0.1:4320/api/capabilities
```

## Notes

- Zoom events cannot overlap in v1.
- Text overlays can overlap.
- Export uploads the selected file to the local server process only.
- Large multi-GB recordings may need a future path-based workflow instead of browser upload.
