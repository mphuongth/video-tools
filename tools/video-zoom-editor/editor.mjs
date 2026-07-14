import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';

import { detectCapabilities } from '../../lib/ffmpeg.mjs';
import { UserInputError } from '../../lib/http.mjs';

const execFile = promisify(execFileCb);

/**
 * Renders a project's zooms and text overlays onto a video. Paths in, path out —
 * the caller owns the temp directory and the HTTP layer, so the server, a test,
 * and any future CLI all drive the same code.
 */
export async function exportEditedVideo({ inputPath, outputPath, tempDir, rawProject }) {
  const capabilities = await detectCapabilities();
  if (!capabilities.videoRendering) {
    throw capabilityError('Video export needs ffmpeg and ffprobe installed on this machine.', capabilities);
  }

  const project = normalizeProject(parseProjectJson(rawProject));
  validateProject(project);

  if (project.texts.length && !capabilities.pngTextFallback) {
    throw capabilityError(
      'Text export needs Swift/AppKit fallback because this ffmpeg build has no drawtext filter.',
      capabilities,
    );
  }

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

  const { size } = await stat(outputPath);
  return { outputPath, outputBytes: size, durationSeconds: metadata.duration };
}

/** Carries the capability flags, so the UI can say exactly which binary is missing. */
function capabilityError(message, capabilities) {
  const error = new UserInputError(message);
  error.capabilities = capabilities;
  return error;
}

function parseProjectJson(rawProject) {
  try {
    return JSON.parse(rawProject);
  } catch {
    throw new UserInputError('Project JSON is invalid.');
  }
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
