# Video Tools

Local tools for editing and processing screen recordings and other video files.

## Tools

- `Video Zoom Editor`: add manual zooms and text overlays to QuickTime, OBS, Loom, `.mov`, or `.mp4` recordings, then export an H.264 MP4.
- `File Compressor`: re-encode a recording down to a target size, so it clears GitHub's 25 MiB upload limit. Non-video files are gzipped in the browser.

## Requirements

- Node.js 18+
- `pnpm`
- `ffmpeg`
- `ffprobe`

Text overlays are rendered with [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas) (prebuilt, cross-platform — no Swift or native build step).

## Run

```bash
pnpm install
pnpm start
```

One server hosts every tool. Open `http://127.0.0.1:4320` for the landing page; the tools live at
`/tools/video-zoom-editor` and `/tools/file-compressor`.

The compressor also runs headless:

```bash
pnpm compress demo.mov --target 8    # target 8 MiB; defaults to 25
```

## Live demo

<https://mphuongth.github.io/video-tools/> — GitHub Pages, so there is no `ffmpeg` behind it.

The editor is still worth opening: loading a recording, drawing zooms, adding text, and previewing all run in the browser, and only Export is disabled. The compressor still gzips non-video files, but cannot transcode video. Both tools say so on the page. To actually export or compress video, run it locally.

## Deploy

Running locally is the intended way to use these tools, and deploying is optional.

Both tools shell out to `ffmpeg` server-side, so a real deploy needs a host that runs Node **and** ships `ffmpeg` — a static host (GitHub Pages, plain Vercel) can serve the pages but cannot export or compress. The repo ships a `Dockerfile` (Debian + `ffmpeg` + fonts) for any container host.

Be aware that transcoding is CPU-bound: export on a small free instance is slow enough to be annoying, and a local run will beat it every time. Deploy for access, not for speed.

- **Render** — push the repo, then `New +` → `Blueprint` and pick this repo. `render.yaml` configures a free Docker web service with a `/api/capabilities` health check.
- **Railway / Fly.io / any Docker host** — build the `Dockerfile`. The server binds `0.0.0.0` and honors the injected `PORT`.

```bash
docker build -t video-tools .
docker run -p 4320:4320 video-tools   # http://127.0.0.1:4320
```

## Structure

One HTTP server at the root serves the landing page, both tool pages, and the shared
`/api/capabilities` check. Each tool is a plain module — paths in, path out — with no knowledge of
HTTP, so it can be driven from the server, a CLI, or a test.

```text
server.mjs                     landing, tool pages, assets, API routes
lib/
  ffmpeg.mjs                   ffmpeg/ffprobe capability detection
  http.mjs                     multipart, responses, filename safety
tools/
  video-zoom-editor/           index.html + editor.mjs  → exportEditedVideo()
  file-compressor/             index.html + compressor.mjs → compressVideo()
```
