import { connect } from 'node:net';

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Sends an HTTP/1.1 POST over a raw socket and parses whatever response arrives, even when the
 * server closes the connection while the body is still being sent (fetch would fail with EPIPE
 * there). `body` is written as given, or in chunked encoding when `chunked` is set (no
 * Content-Length, as HTTP/2 clients may send).
 */
export function rawPost(
  baseUrl: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer | { chunks: Iterable<Buffer> },
): Promise<RawResponse> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    let data = Buffer.alloc(0);
    const done = () => {
      const text = data.toString('latin1');
      const end = text.indexOf('\r\n\r\n');
      const statusLine = /^HTTP\/1\.1 (\d{3})/.exec(text);
      if (end < 0 || statusLine === null) {
        reject(new Error('No HTTP response received'));
        return;
      }
      const head = text.slice(0, end).split('\r\n').slice(1);
      const parsed: Record<string, string> = {};
      for (const line of head) {
        const i = line.indexOf(':');
        parsed[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
      }
      const raw = data.subarray(end + 4).toString('utf8');
      resolve({
        status: Number(statusLine[1]),
        headers: parsed,
        body: raw === '' ? undefined : (JSON.parse(raw) as unknown),
      });
    };
    socket.on('data', (d: Buffer) => (data = Buffer.concat([data, d])));
    socket.on('close', done);
    socket.on('error', () => undefined);
    const chunked = !Buffer.isBuffer(body);
    const lines = [`POST ${path} HTTP/1.1`, `Host: ${url.host}`, 'Connection: close'];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    lines.push(chunked ? 'Transfer-Encoding: chunked' : `Content-Length: ${body.length}`);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    const iterator: Iterator<Buffer> = Buffer.isBuffer(body)
      ? (function* () {
          for (let i = 0; i < body.length; i += 64 * 1024) yield body.subarray(i, i + 64 * 1024);
        })()
      : body.chunks[Symbol.iterator]();
    // One chunk per event-loop turn, so the response is noticed as soon as it arrives.
    const pump = () => {
      // Like a browser: stop sending once the server has answered.
      if (socket.destroyed || data.length > 0) return;
      const next = iterator.next();
      if (next.done === true) {
        if (chunked) socket.write('0\r\n\r\n');
        return;
      }
      const ok = socket.write(
        chunked
          ? Buffer.concat([
              Buffer.from(`${next.value.length.toString(16)}\r\n`),
              next.value,
              Buffer.from('\r\n'),
            ])
          : next.value,
      );
      if (ok) setImmediate(pump);
      else socket.once('drain', pump);
    };
    pump();
  });
}

/** The bytes and Content-Type of a FormData body, as fetch would send them. */
export async function encodeForm(form: FormData): Promise<{ body: Buffer; contentType: string }> {
  const response = new Response(form);
  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? '',
  };
}
