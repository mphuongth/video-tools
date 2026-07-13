# Video Tools

Local tools for editing and processing screen recordings and other video files.

## Tools

- `Video Zoom Editor`: add manual zooms and text overlays to QuickTime, OBS, Loom, `.mov`, or `.mp4` recordings, then export an H.264 MP4.

## Requirements

- Node.js 18+
- `pnpm`
- `ffmpeg`
- `ffprobe`

Text overlays are rendered with [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas) (prebuilt, cross-platform — no Swift or native build step).

## Run

```bash
pnpm install
pnpm video-zoom-editor
```

Open `http://127.0.0.1:4320` for the Video Tools landing page. The editor lives at `http://127.0.0.1:4320/tools/video-zoom-editor`.

## Deploy

The editor exports MP4s server-side, so it needs a host that runs Node **and** ships `ffmpeg` — a static host (GitHub Pages, plain Vercel) cannot export. The repo ships a `Dockerfile` (Debian + `ffmpeg` + fonts) for any container host.

- **Render** — push the repo, then `New +` → `Blueprint` and pick this repo. `render.yaml` configures a free Docker web service with a `/api/capabilities` health check.
- **Railway / Fly.io / any Docker host** — build the `Dockerfile`. The server binds `0.0.0.0` and honors the injected `PORT`.

```bash
docker build -t video-tools .
docker run -p 4320:4320 video-tools   # http://127.0.0.1:4320
```

## Structure

```text
tools/
  video-zoom-editor/
```
