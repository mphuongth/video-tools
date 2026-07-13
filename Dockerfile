# Runs the Video Zoom Editor server with real ffmpeg so MP4 export works.
FROM node:20-slim

# ffmpeg/ffprobe for rendering; fonts + fontconfig for the canvas text overlays.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ffmpeg \
       fonts-dejavu-core \
       fontconfig \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package.json pnpm-lock.yaml ./
RUN corepack enable \
  && pnpm install --prod --frozen-lockfile

COPY . .

ENV NODE_ENV=production
# Render/Railway/Fly inject PORT; the server binds 0.0.0.0 when PORT is set.
EXPOSE 4320
CMD ["node", "tools/video-zoom-editor/server.mjs"]
