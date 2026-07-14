#!/usr/bin/env node

import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { detectCapabilities } from './lib/ffmpeg.mjs';
import {
  readMultipartFormData,
  replaceExtension,
  sanitizeFileName,
  send,
  sendDownload,
  sendJson,
} from './lib/http.mjs';
import { exportEditedVideo } from './tools/video-zoom-editor/editor.mjs';
import { compressVideo, normalizeTargetMiB } from './tools/file-compressor/compressor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Honor the app's own env vars first; fall back to the platform PORT (Render,
// Railway, Fly, …) and bind on all interfaces when running on such a host.
const PORT = Number(process.env.VIDEO_TOOLS_PORT || process.env.VIDEO_ZOOM_EDITOR_PORT || process.env.PORT || 4320);
const HOST = process.env.VIDEO_TOOLS_HOST || process.env.VIDEO_ZOOM_EDITOR_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const LANDING_HTML_PATH = path.join(__dirname, 'index.html');
const ASSETS_DIR = path.join(__dirname, 'assets');
const TOOLS_DIR = path.join(__dirname, 'tools');

/** One page and one API route per tool; the shared server owns everything else. */
const TOOLS = [
  { slug: 'video-zoom-editor', title: 'Video Zoom Editor' },
  { slug: 'file-compressor', title: 'File Compressor' },
];

const ASSET_CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

async function main() {
  const server = createServer(handleRequest);
  server.listen(PORT, HOST, () => {
    process.stdout.write(`Video tools: http://${HOST}:${PORT}\n`);
    for (const tool of TOOLS) {
      process.stdout.write(`  ${tool.title}: http://${HOST}:${PORT}/tools/${tool.slug}\n`);
    }
  });
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, await readFile(LANDING_HTML_PATH, 'utf8'), 'text/html; charset=utf-8');
    }

    const tool = TOOLS.find(
      (candidate) =>
        url.pathname === `/tools/${candidate.slug}` || url.pathname === `/tools/${candidate.slug}/`,
    );
    if (req.method === 'GET' && tool) {
      const html = await readFile(path.join(TOOLS_DIR, tool.slug, 'index.html'), 'utf8');
      return send(res, 200, html, 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
      return sendAsset(res, url.pathname);
    }

    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      return send(res, 204, '', 'image/x-icon');
    }

    // Shared: both tools stand on the same ffmpeg binaries. Also the deploy health check.
    if (req.method === 'GET' && url.pathname === '/api/capabilities') {
      return sendJson(res, 200, await detectCapabilities());
    }

    if (req.method === 'POST' && url.pathname === '/api/export') {
      return exportUpload(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/compress-video') {
      return compressUpload(req, res);
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unexpected server error.' });
  }
}

/** Serves files under assets/ only — a traversal outside it is a 404, not a leak. */
async function sendAsset(res, pathname) {
  const requested = path.join(ASSETS_DIR, decodeURIComponent(pathname.slice('/assets/'.length)));
  const resolved = path.resolve(requested);
  if (resolved !== ASSETS_DIR && !resolved.startsWith(`${ASSETS_DIR}${path.sep}`)) {
    return sendJson(res, 404, { error: 'Not found' });
  }

  const contentType = ASSET_CONTENT_TYPES[path.extname(resolved).toLowerCase()];
  if (!contentType) return sendJson(res, 404, { error: 'Not found' });

  try {
    return send(res, 200, await readFile(resolved), contentType);
  } catch {
    return sendJson(res, 404, { error: 'Not found' });
  }
}

/** Zoom editor: video + project JSON in, edited MP4 back. */
async function exportUpload(req, res) {
  return withUploadedVideo(req, res, {
    field: 'video',
    fallbackName: 'recording.mov',
    outputSuffix: '.edited.mp4',
    tempPrefix: 'video-zoom-editor-',
    failure: 'Video export failed.',
    run: ({ inputPath, outputPath, tempDir, formData }) =>
      exportEditedVideo({
        inputPath,
        outputPath,
        tempDir,
        rawProject: String(formData.get('project') || '{}'),
      }),
  });
}

/** File compressor: video + target size in, a smaller MP4 back. */
async function compressUpload(req, res) {
  return withUploadedVideo(req, res, {
    field: 'file',
    fallbackName: 'video.mov',
    outputSuffix: '.compressed.mp4',
    tempPrefix: 'file-compressor-',
    failure: 'Video compression failed.',
    run: ({ inputPath, outputPath, formData }) => {
      const targetMiB = normalizeTargetMiB(formData.get('targetMiB'));
      return compressVideo({
        inputPath,
        outputPath,
        targetBytes: targetMiB * 1024 * 1024,
      }).then((result) => ({ ...result, extraHeaders: { 'X-Target-MiB': String(targetMiB) } }));
    },
  });
}

/**
 * The upload dance both tools share: parse multipart, stage the file on disk,
 * hand the tool plain paths, stream the result back, and always clear the temp
 * directory — including when ffmpeg fails halfway through.
 */
async function withUploadedVideo(req, res, { field, fallbackName, outputSuffix, tempPrefix, failure, run }) {
  let tempDir = '';

  try {
    const formData = await readMultipartFormData(req);
    const file = formData.get(field);
    if (!file || typeof file.arrayBuffer !== 'function') {
      return sendJson(res, 400, { error: 'Missing video file.' });
    }

    const originalName = sanitizeFileName(file.name || fallbackName);
    const outputName = replaceExtension(originalName, outputSuffix);

    tempDir = await mkdtemp(path.join(os.tmpdir(), tempPrefix));
    const inputPath = path.join(tempDir, originalName);
    await writeFile(inputPath, Buffer.from(await file.arrayBuffer()));

    const result = await run({
      inputPath,
      outputPath: path.join(tempDir, outputName),
      tempDir,
      formData,
    });

    return sendDownload(res, 200, await readFile(result.outputPath), 'video/mp4', outputName, {
      'X-Original-Filename': originalName,
      'X-Output-Filename': outputName,
      'X-Output-Size': String(result.outputBytes),
      'X-Video-Duration-Seconds': String(result.durationSeconds),
      ...(result.extraHeaders || {}),
    });
  } catch (error) {
    return sendJson(res, error.statusCode || 500, {
      error: error.message || failure,
      ...(error.capabilities ? { capabilities: error.capabilities } : {}),
    });
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  process.stderr.write(`Video tools failed: ${error.message || error}\n`);
  process.exit(1);
});
