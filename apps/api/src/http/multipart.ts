import { fileExtension, SELFIE_FIELD_NAME, SELFIE_MIME_TYPES } from '@shotx/shared';
import busboy from 'busboy';
import type { Request } from 'express';
import { ApiError } from './api-error';

export interface SelfieLimits {
  /** FACE_MAX_SELFIES. */
  maxSelfies: number;
  /** FACE_SEARCH_MAX_SELFIE_BYTES. */
  maxSelfieBytes: number;
  /** FACE_SEARCH_MAX_BODY_BYTES. */
  maxBodyBytes: number;
}

// The connection is closed after an early answer, so the client can't keep streaming a body the
// API refuses to read.
const CLOSE = { Connection: 'close' };

const tooLarge = () =>
  new ApiError('PAYLOAD_TOO_LARGE', 'Request body too large', undefined, CLOSE);

const invalid = (message: string) =>
  new ApiError(
    'VALIDATION_FAILED',
    'Request validation failed',
    { issues: [{ path: ['body', SELFIE_FIELD_NAME], message }] },
    CLOSE,
  );

/** The longest a refused upload's connection stays open after the answer. */
const DISCARD_MAX_MS = 5_000;

/**
 * Discards (never buffers) what is left of a refused body, up to `limit` more bytes, and closes the
 * connection without losing the answer. Node closes a `Connection: close` response's socket at
 * once (destroySoon); with request bytes still unread, the kernel then sends a reset, which can
 * destroy the error response before the client reads it. So for this request only, closing just
 * sends FIN (the HTTP server's sockets are half-open capable), the rest of the body keeps being
 * read and dropped, and the socket is destroyed when the client finishes or gives up (`end`),
 * after `limit` more bytes, or after DISCARD_MAX_MS, whichever comes first.
 */
function discardRest(req: Request, limit: number): void {
  const socket = req.socket as Request['socket'] & { destroySoon?: () => void };
  if (typeof socket.destroySoon === 'function') socket.destroySoon = () => socket.end();
  const destroy = () => socket.destroy();
  socket.once('end', destroy);
  setTimeout(destroy, DISCARD_MAX_MS).unref();
  let discarded = 0;
  req.on('data', (chunk: Buffer) => {
    discarded += chunk.length;
    if (discarded > limit) destroy();
  });
  req.resume();
}

/** True when the bytes start like a JPEG or PNG of the declared type. */
export function selfieMagicMatches(mime: string, bytes: Buffer): boolean {
  if (mime === 'image/jpeg')
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') {
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return false;
}

/**
 * Reads the selfies of `POST /s/:token/face-search` and `.../face-deletion` from a
 * multipart/form-data body, streaming, in memory only. Limits are enforced while reading:
 * the body is abandoned (and the connection closed) as soon as it passes `maxBodyBytes`
 * (PAYLOAD_TOO_LARGE, also when no Content-Length was sent), a part passes `maxSelfieBytes`
 * (PAYLOAD_TOO_LARGE) or there are more than `maxSelfies` parts (VALIDATION_FAILED). Only parts
 * named `selfie` with a JPEG or PNG type and matching magic bytes are accepted
 * (UNSUPPORTED_FILE_TYPE otherwise). Nothing about the bytes is ever logged or put in an error.
 */
export function readSelfies(req: Request, limits: SelfieLimits): Promise<Buffer[]> {
  const contentType = req.headers['content-type'] ?? '';
  if (!/^multipart\/form-data\s*;/i.test(contentType)) {
    return Promise.reject(invalid('must be multipart/form-data'));
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limits.maxBodyBytes) {
    discardRest(req, limits.maxBodyBytes);
    return Promise.reject(tooLarge());
  }

  return new Promise<Buffer[]>((resolve, reject) => {
    const selfies: Buffer[] = [];
    let pending = 0;
    let closed = false;
    let settled = false;
    let received = 0;

    let parser: ReturnType<typeof busboy>;
    try {
      parser = busboy({
        headers: req.headers,
        limits: {
          files: limits.maxSelfies,
          parts: limits.maxSelfies,
          fields: 0,
          fileSize: limits.maxSelfieBytes,
          headerPairs: 16,
        },
      });
    } catch {
      reject(invalid('is not a valid multipart body'));
      return;
    }

    const cleanup = () => {
      req.off('data', onData);
      req.off('aborted', onAborted);
      req.off('error', onAborted);
      req.unpipe(parser);
    };
    const fail = (error: ApiError) => {
      if (settled) return;
      settled = true;
      cleanup();
      for (const s of selfies) s.fill(0);
      selfies.length = 0;
      // The parser is only detached (busboy's destroy throws "Unexpected end of file"
      // synchronously mid-part); the rest of the body is discarded, bounded.
      parser.removeAllListeners();
      parser.on('error', () => undefined);
      discardRest(req, limits.maxBodyBytes);
      reject(error);
    };
    const finish = () => {
      if (settled || !closed || pending > 0) return;
      settled = true;
      cleanup();
      if (selfies.length === 0) {
        reject(invalid(`needs 1 to ${limits.maxSelfies} parts`));
        return;
      }
      resolve(selfies);
    };
    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > limits.maxBodyBytes) fail(tooLarge());
    };
    const onAborted = () => fail(invalid('request body ended early'));

    parser.on('file', (name, stream, info) => {
      if (settled) {
        stream.resume();
        return;
      }
      if (name !== SELFIE_FIELD_NAME) {
        stream.resume();
        fail(invalid(`only "${SELFIE_FIELD_NAME}" parts are accepted`));
        return;
      }
      if (!(SELFIE_MIME_TYPES as readonly string[]).includes(info.mimeType)) {
        stream.resume();
        fail(
          new ApiError(
            'UNSUPPORTED_FILE_TYPE',
            'Selfies must be JPEG or PNG',
            { extension: fileExtension(info.filename ?? ''), hint: null },
            CLOSE,
          ),
        );
        return;
      }
      pending++;
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        chunks.push(chunk);
      });
      stream.on('limit', () => fail(tooLarge()));
      stream.on('end', () => {
        pending--;
        if (settled) return;
        if (stream.truncated) {
          fail(tooLarge());
          return;
        }
        const bytes = Buffer.concat(chunks, size);
        for (const c of chunks) c.fill(0);
        if (!selfieMagicMatches(info.mimeType, bytes)) {
          bytes.fill(0);
          fail(
            new ApiError(
              'UNSUPPORTED_FILE_TYPE',
              'Selfies must be JPEG or PNG',
              { extension: fileExtension(info.filename ?? ''), hint: null },
              CLOSE,
            ),
          );
          return;
        }
        selfies.push(bytes);
        finish();
      });
    });
    parser.on('field', () => fail(invalid(`only "${SELFIE_FIELD_NAME}" file parts are accepted`)));
    parser.on('fieldsLimit', () =>
      fail(invalid(`only "${SELFIE_FIELD_NAME}" file parts are accepted`)),
    );
    parser.on('filesLimit', () => fail(invalid(`at most ${limits.maxSelfies} parts`)));
    parser.on('partsLimit', () => fail(invalid(`at most ${limits.maxSelfies} parts`)));
    parser.on('error', () => fail(invalid('is not a valid multipart body')));
    parser.on('close', () => {
      closed = true;
      finish();
    });

    req.on('data', onData);
    req.on('aborted', onAborted);
    req.on('error', onAborted);
    req.pipe(parser);
  });
}
