# Video Zoom Editor

Local post-production editor for screen recordings from QuickTime, OBS, Loom exports, or any `.mov`/`.mp4` file the browser can preview.

It lets you add manual zooms and text callouts after recording, then renders a final MP4 through `ffmpeg`.

## Run

```sh
pnpm video-zoom-editor
```

Open:

```text
http://127.0.0.1:4320
```

Use a custom port if needed:

```sh
VIDEO_ZOOM_EDITOR_PORT=4321 pnpm video-zoom-editor
```

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
- macOS Swift toolchain for text PNG fallback when the local `ffmpeg` build does not include `drawtext`

The capabilities endpoint shows what is available:

```sh
curl -fsS http://127.0.0.1:4320/api/capabilities
```

## Notes

- Zoom events cannot overlap in v1.
- Text overlays can overlap.
- Export uploads the selected file to the local server process only.
- Large multi-GB recordings may need a future path-based workflow instead of browser upload.
