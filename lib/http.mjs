import { Readable } from 'node:stream';
import path from 'node:path';

/** Thrown when the caller sent something invalid; the server turns it into a 400. */
export class UserInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserInputError';
    this.statusCode = 400;
  }
}

/** Reads a multipart upload using the platform's own parser, so no dependency is needed. */
export async function readMultipartFormData(req) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      headers.set(key, value.join(', '));
    } else if (value) {
      headers.set(key, value);
    }
  }

  const request = new Request('http://video-tools.local/upload', {
    method: req.method,
    headers,
    body: Readable.toWeb(req),
    duplex: 'half',
  });

  return request.formData();
}

/** Upload names are caller-controlled, so strip anything that could escape the temp directory. */
export function sanitizeFileName(fileName) {
  const baseName = path.basename(String(fileName || 'file')).replace(/[^\w .@()-]/g, '_').trim();
  return baseName.slice(0, 160) || 'file';
}

export function replaceExtension(fileName, extension) {
  const parsed = path.parse(sanitizeFileName(fileName));
  return `${parsed.name || 'file'}${extension}`;
}

export function send(res, statusCode, body, contentType) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendJson(res, statusCode, payload) {
  return send(res, statusCode, `${JSON.stringify(payload, null, 2)}\n`, 'application/json; charset=utf-8');
}

export function sendDownload(res, statusCode, body, contentType, filename, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
    ...headers,
  });
  res.end(body);
}
