#!/usr/bin/env node

import { createServer } from 'node:http';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

const execFile = promisify(execFileCb);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Honor the app's own env vars first; fall back to the platform PORT (Render,
// Railway, Fly, …) and bind on all interfaces when running on such a host.
const PORT = Number(process.env.VIDEO_ZOOM_EDITOR_PORT || process.env.PORT || 4320);
const HOST = process.env.VIDEO_ZOOM_EDITOR_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');
const LANDING_HTML_PATH = path.resolve(__dirname, '../../index.html');
const PREVIEW_IMAGE_PATH = path.resolve(__dirname, '../../assets/video-zoom-editor-preview.jpg');

class UserInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserInputError';
    this.statusCode = 400;
  }
}

async function main() {
  const server = createServer(handleRequest);
  server.listen(PORT, HOST, () => {
    process.stdout.write(`Video tools: http://${HOST}:${PORT}\n`);
  });
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, await readFile(LANDING_HTML_PATH, 'utf8'), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && (url.pathname === '/tools/video-zoom-editor' || url.pathname === '/tools/video-zoom-editor/')) {
      return send(res, 200, await readFile(INDEX_HTML_PATH, 'utf8'), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname === '/assets/video-zoom-editor-preview.jpg') {
      return send(res, 200, await readFile(PREVIEW_IMAGE_PATH), 'image/jpeg');
    }

    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      return send(res, 204, '', 'image/x-icon');
    }

    if (req.method === 'GET' && url.pathname === '/api/capabilities') {
      return sendJson(res, 200, await buildCapabilities());
    }

    if (req.method === 'POST' && url.pathname === '/api/export') {
      return exportVideo(req, res);
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || 'Unexpected server error.' });
  }
}

async function exportVideo(req, res) {
  let tempDir = '';

  try {
    const capabilities = await buildCapabilities();
    if (!capabilities.videoRendering) {
      return sendJson(res, 400, {
        error: 'Video export needs ffmpeg and ffprobe installed on this machine.',
        capabilities,
      });
    }

    const formData = await readMultipartFormData(req);
    const file = formData.get('video');
    if (!file || typeof file.arrayBuffer !== 'function') {
      return sendJson(res, 400, { error: 'Missing video file.' });
    }

    const rawProject = String(formData.get('project') || '{}');
    const project = normalizeProject(parseProjectJson(rawProject));
    validateProject(project);

    if (project.texts.length && !capabilities.pngTextFallback) {
      return sendJson(res, 400, {
        error: 'Text export needs Swift/AppKit fallback because this ffmpeg build has no drawtext filter.',
        capabilities,
      });
    }

    const originalName = sanitizeFileName(file.name || 'recording.mov');
    const outputName = replaceExtension(originalName, '.edited.mp4');

    tempDir = await mkdtemp(path.join(os.tmpdir(), 'video-zoom-editor-'));
    const inputPath = path.join(tempDir, originalName);
    const outputPath = path.join(tempDir, outputName);
    await writeFile(inputPath, Buffer.from(await file.arrayBuffer()));

    const metadata = await probeVideoMetadata(inputPath);
    validateProjectAgainstVideo(project, metadata.duration);

    const textInputs = [];
    for (const text of project.texts) {
      const imagePath = path.join(tempDir, `${text.id}.png`);
      await renderTextOverlay(text, imagePath, metadata.width);
      textInputs.push({ ...text, imagePath });
    }

    const args = buildFfmpegArgs(inputPath, outputPath, project, textInputs, metadata);
    await execFile('ffmpeg', args, {
      timeout: 30 * 60 * 1_000,
      maxBuffer: 40 * 1024 * 1024,
    });

    const [outputBuffer, outputStat] = await Promise.all([readFile(outputPath), stat(outputPath)]);
    return sendDownload(res, 200, outputBuffer, 'video/mp4', outputName, {
      'X-Original-Filename': originalName,
      'X-Output-Filename': outputName,
      'X-Output-Size': String(outputStat.size),
      'X-Video-Duration-Seconds': String(metadata.duration),
    });
  } catch (error) {
    return sendJson(res, error.statusCode || 500, { error: error.message || 'Video export failed.' });
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function parseProjectJson(rawProject) {
  try {
    return JSON.parse(rawProject);
  } catch {
    throw new UserInputError('Project JSON is invalid.');
  }
}

async function buildCapabilities() {
  const [ffmpeg, ffprobe] = await Promise.all([
    isCommandAvailable('ffmpeg', ['-version']),
    isCommandAvailable('ffprobe', ['-version']),
  ]);

  return {
    ffmpeg,
    ffprobe,
    videoRendering: ffmpeg && ffprobe,
    // Text overlays are drawn in-process with @napi-rs/canvas, so text export
    // works anywhere ffmpeg does — no drawtext filter or Swift toolchain needed.
    textRendering: true,
    pngTextFallback: true,
  };
}

async function isCommandAvailable(command, args) {
  try {
    await execFile(command, args, { timeout: 5_000, maxBuffer: 256 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function readMultipartFormData(req) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      headers.set(key, value.join(', '));
    } else if (value) {
      headers.set(key, value);
    }
  }

  const request = new Request('http://video-zoom-editor.local/export', {
    method: req.method,
    headers,
    body: Readable.toWeb(req),
    duplex: 'half',
  });

  return request.formData();
}

async function probeVideoMetadata(inputPath) {
  const { stdout } = await execFile(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,avg_frame_rate,r_frame_rate:format=duration',
      '-of',
      'json',
      inputPath,
    ],
    { timeout: 30_000, maxBuffer: 1024 * 1024 },
  );

  const parsed = JSON.parse(stdout || '{}');
  const stream = parsed?.streams?.[0] || {};
  const width = Number(stream.width);
  const height = Number(stream.height);
  const duration = Number(parsed?.format?.duration);
  const frameRate = parseFrameRate(stream.avg_frame_rate || stream.r_frame_rate) || 30;

  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error('Could not read video dimensions.');
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Could not read video duration.');
  }

  return {
    width: Math.round(width),
    height: Math.round(height),
    duration,
    frameRate,
  };
}

function parseFrameRate(raw) {
  const text = String(raw || '');
  if (!text || text === '0/0') return null;
  const [numerator, denominator] = text.split('/').map(Number);
  if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
    return clamp(numerator / denominator, 1, 120);
  }
  const value = Number(text);
  return Number.isFinite(value) ? clamp(value, 1, 120) : null;
}

function normalizeProject(rawProject) {
  return {
    zooms: Array.isArray(rawProject?.zooms) ? rawProject.zooms.map(normalizeZoom) : [],
    texts: Array.isArray(rawProject?.texts) ? rawProject.texts.map(normalizeText) : [],
  };
}

function normalizeZoom(raw, index) {
  return {
    id: sanitizeId(raw?.id || `z${index + 1}`, 'z'),
    start: roundTime(raw?.start),
    end: roundTime(raw?.end),
    x: roundRatio(raw?.x),
    y: roundRatio(raw?.y),
    scale: roundNumber(raw?.scale, 1.8),
  };
}

function normalizeText(raw, index) {
  return {
    id: sanitizeId(raw?.id || `t${index + 1}`, 't'),
    start: roundTime(raw?.start),
    end: roundTime(raw?.end),
    text: String(raw?.text || '').trim().slice(0, 280),
    x: roundRatio(raw?.x),
    y: roundRatio(raw?.y),
    fontSize: Math.round(roundNumber(raw?.fontSize, 42)),
  };
}

function validateProject(project) {
  for (const zoom of project.zooms) {
    assertTimeRange(zoom, `Zoom ${zoom.id}`);
    if (!Number.isFinite(zoom.x) || !Number.isFinite(zoom.y) || zoom.x < 0 || zoom.x > 1 || zoom.y < 0 || zoom.y > 1) {
      throw new UserInputError(`Zoom ${zoom.id} has an invalid position.`);
    }
    if (!Number.isFinite(zoom.scale) || zoom.scale <= 1 || zoom.scale > 4) {
      throw new UserInputError(`Zoom ${zoom.id} scale must be greater than 1 and no more than 4.`);
    }
  }

  const zooms = [...project.zooms].sort((a, b) => a.start - b.start);
  for (let index = 1; index < zooms.length; index += 1) {
    if (zooms[index].start < zooms[index - 1].end) {
      throw new UserInputError('Zoom events cannot overlap in v1.');
    }
  }

  for (const text of project.texts) {
    assertTimeRange(text, `Text ${text.id}`);
    if (!text.text) {
      throw new UserInputError(`Text ${text.id} is empty.`);
    }
    if (!Number.isFinite(text.x) || !Number.isFinite(text.y) || text.x < 0 || text.x > 1 || text.y < 0 || text.y > 1) {
      throw new UserInputError(`Text ${text.id} has an invalid position.`);
    }
    if (!Number.isFinite(text.fontSize) || text.fontSize < 12 || text.fontSize > 120) {
      throw new UserInputError(`Text ${text.id} font size must be between 12 and 120.`);
    }
  }
}

function validateProjectAgainstVideo(project, duration) {
  for (const event of [...project.zooms, ...project.texts]) {
    if (event.start > duration + 0.5) {
      throw new UserInputError(`Event ${event.id} starts after the video ends.`);
    }
  }
}

function assertTimeRange(event, label) {
  if (!Number.isFinite(event.start) || !Number.isFinite(event.end) || event.start < 0 || event.end <= event.start) {
    throw new UserInputError(`${label} has an invalid time range.`);
  }
}

// Render a text overlay to a PNG: white semibold, centered and word-wrapped,
// on a rounded translucent-dark chip — matching the on-screen .text-chip.
// Drawn in-process so it runs on any OS ffmpeg runs on (no Swift/AppKit).
async function renderTextOverlay(text, outputPath, videoWidth) {
  const fontSize = clamp(Number(text.fontSize) || 42, 12, 120);
  const maxWidth = clamp(Math.max(180, Math.min(980, videoWidth * 0.75)), 120, 1800);
  const paddingX = Math.max(16, fontSize * 0.48);
  const paddingY = Math.max(10, fontSize * 0.32);
  const lineHeight = fontSize * 1.25;
  const content = String(text.text || '').trim() || ' ';
  const font = `600 ${fontSize}px sans-serif`;

  const measure = createCanvas(8, 8).getContext('2d');
  measure.font = font;
  const lines = wrapText(measure, content, maxWidth - paddingX * 2);
  const textWidth = Math.max(1, ...lines.map((line) => measure.measureText(line).width));

  const width = Math.max(1, Math.ceil(textWidth + paddingX * 2));
  const height = Math.max(1, Math.ceil(lines.length * lineHeight + paddingY * 2));
  const radius = Math.min(18, height / 3);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(15, 15, 15, 0.78)';
  roundedRectPath(ctx, 0, 0, width, height, radius);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((line, index) => {
    ctx.fillText(line, width / 2, paddingY + lineHeight * (index + 0.5));
  });

  await writeFile(outputPath, canvas.toBuffer('image/png'));
}

function wrapText(ctx, content, maxWidth) {
  const lines = [];
  for (const rawLine of content.split('\n')) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let line = words[0];
    for (let index = 1; index < words.length; index += 1) {
      const candidate = `${line} ${words[index]}`;
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
      } else {
        lines.push(line);
        line = words[index];
      }
    }
    lines.push(line);
  }
  return lines.length ? lines : [' '];
}

function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function buildFfmpegArgs(inputPath, outputPath, project, textInputs, metadata) {
  const args = ['-y', '-i', inputPath];

  for (const text of textInputs) {
    args.push('-loop', '1', '-i', text.imagePath);
  }

  const filterGraph = buildFilterGraph(project, textInputs, metadata);
  args.push(
    '-filter_complex',
    filterGraph,
    '-map',
    '[vout]',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-movflags',
    '+faststart',
    outputPath,
  );

  return args;
}

function buildFilterGraph(project, textInputs, metadata) {
  const zoomFilter = buildZoomFilter(project.zooms, metadata);
  const filters = [`[0:v]${zoomFilter},format=rgba[vz0]`];
  let currentLabel = 'vz0';

  textInputs.forEach((text, index) => {
    const nextLabel = `vt${index}`;
    const inputIndex = index + 1;
    const xExpr = `min(max(0,main_w*${formatNumber(text.x)}-overlay_w/2),main_w-overlay_w)`;
    const yExpr = `min(max(0,main_h*${formatNumber(text.y)}-overlay_h/2),main_h-overlay_h)`;
    const enableExpr = `between(t,${formatNumber(text.start)},${formatNumber(text.end)})`;
    filters.push(
      `[${currentLabel}][${inputIndex}:v]overlay=x='${xExpr}':y='${yExpr}':enable='${enableExpr}':eof_action=pass:format=auto[${nextLabel}]`,
    );
    currentLabel = nextLabel;
  });

  filters.push(`[${currentLabel}]format=yuv420p[vout]`);
  return filters.join(';');
}

function buildZoomFilter(zooms, metadata) {
  const zoomExpression = buildZoomExpression(zooms);
  const xExpression = buildPanExpression(zooms, 'x', 'iw');
  const yExpression = buildPanExpression(zooms, 'y', 'ih');
  const size = `${metadata.width}x${metadata.height}`;
  const fps = formatNumber(metadata.frameRate, 6);

  return `zoompan=z='${zoomExpression}':x='${xExpression}':y='${yExpression}':d=1:s=${size}:fps=${fps}`;
}

function buildZoomExpression(zooms) {
  let expression = '1';
  for (const zoom of [...zooms].sort((a, b) => b.start - a.start)) {
    const scale = formatNumber(zoom.scale);
    const start = formatNumber(zoom.start);
    const end = formatNumber(zoom.end);
    const ramp = formatNumber(Math.min(0.34, Math.max(0.08, (zoom.end - zoom.start) / 2)));
    const up = cubicEaseExpression(`(time-${start})/${ramp}`);
    const down = cubicEaseExpression(`(${end}-time)/${ramp}`);
    const inside = `if(lte(time,${start}+${ramp}),1+(${scale}-1)*${up},if(gte(time,${end}-${ramp}),1+(${scale}-1)*${down},${scale}))`;
    expression = `if(between(time,${start},${end}),${inside},${expression})`;
  }
  return expression;
}

function buildPanExpression(zooms, coordinate, dimensionVariable) {
  let expression = '0';
  for (const zoom of [...zooms].sort((a, b) => b.start - a.start)) {
    const start = formatNumber(zoom.start);
    const end = formatNumber(zoom.end);
    const center = formatNumber(coordinate === 'x' ? zoom.x : zoom.y);
    const pan = `min(max(0,${dimensionVariable}*${center}-(${dimensionVariable}/zoom/2)),${dimensionVariable}-(${dimensionVariable}/zoom))`;
    expression = `if(between(time,${start},${end}),${pan},${expression})`;
  }
  return expression;
}

function cubicEaseExpression(rawProgress) {
  const progress = `min(max(${rawProgress},0),1)`;
  return `if(lt(${progress},0.5),4*${progress}*${progress}*${progress},1-pow(-2*${progress}+2,3)/2)`;
}

function roundTime(value) {
  return roundNumber(value, 0);
}

function roundRatio(value) {
  return roundNumber(value, 0.5);
}

function roundNumber(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(number * 1000) / 1000;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatNumber(value, precision = 3) {
  const factor = 10 ** precision;
  return String(Math.round(Number(value) * factor) / factor);
}

function sanitizeId(raw, fallbackPrefix) {
  const cleaned = String(raw || '').replace(/[^\w-]/g, '').slice(0, 32);
  if (cleaned) return cleaned;
  return `${fallbackPrefix}${createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 8)}`;
}

function sanitizeFileName(fileName) {
  const baseName = path.basename(String(fileName || 'file')).replace(/[^\w .@()-]/g, '_').trim();
  return baseName.slice(0, 160) || 'file';
}

function replaceExtension(fileName, extension) {
  const parsed = path.parse(sanitizeFileName(fileName));
  return `${parsed.name || 'file'}${extension}`;
}

function sendJson(res, statusCode, payload) {
  return send(res, statusCode, `${JSON.stringify(payload, null, 2)}\n`, 'application/json; charset=utf-8');
}

function sendDownload(res, statusCode, body, contentType, filename, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
    ...headers,
  });
  res.end(body);
}

function send(res, statusCode, body, contentType) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

main().catch((error) => {
  process.stderr.write(`Video zoom editor failed: ${error.message || error}\n`);
  process.exit(1);
});
