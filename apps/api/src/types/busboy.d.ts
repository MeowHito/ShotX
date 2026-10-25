// Minimal types for busboy 1.x (no @types package is installed). Only what http/multipart.ts uses.
declare module 'busboy' {
  import type { IncomingHttpHeaders } from 'node:http';
  import type { Readable, Writable } from 'node:stream';

  interface Limits {
    fieldNameSize?: number;
    fieldSize?: number;
    fields?: number;
    fileSize?: number;
    files?: number;
    parts?: number;
    headerPairs?: number;
  }

  interface Config {
    headers: IncomingHttpHeaders;
    limits?: Limits;
    preservePath?: boolean;
  }

  interface FileInfo {
    filename: string | undefined;
    encoding: string;
    mimeType: string;
  }

  interface FileStream extends Readable {
    truncated: boolean;
  }

  interface Busboy extends Writable {
    on(event: 'file', listener: (name: string, stream: FileStream, info: FileInfo) => void): this;
    on(event: 'field', listener: (name: string, value: string) => void): this;
    on(event: 'filesLimit' | 'fieldsLimit' | 'partsLimit' | 'close', listener: () => void): this;
    on(event: 'error', listener: (error: unknown) => void): this;
  }

  function busboy(config: Config): Busboy;
  export default busboy;
}
