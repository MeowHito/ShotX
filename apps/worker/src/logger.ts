/**
 * Structured JSON logs, one object per line on stdout (CloudWatch via the awslogs driver).
 *
 * No PII and no image bytes: log ids (file, photographer, message), counts, sizes and error
 * names. Never log S3 keys of originals (they contain the uploaded file name), file names,
 * emails or message bodies. {@link errorFields} scrubs keys from error messages as a last line of
 * defence.
 */
export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Readonly<Record<string, LogValue>>;
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface JsonLoggerOptions {
  write?: (line: string) => void;
  minLevel?: LogLevel;
  now?: () => number;
  base?: LogFields;
}

export function createJsonLogger(options: JsonLoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const minLevel = LEVEL_ORDER[options.minLevel ?? 'info'];
  const now = options.now ?? Date.now;
  const make = (base: LogFields): Logger => {
    const log = (level: LogLevel, msg: string, fields?: LogFields) => {
      if (LEVEL_ORDER[level] < minLevel) return;
      write(
        JSON.stringify({ time: new Date(now()).toISOString(), level, msg, ...base, ...fields }),
      );
    };
    return {
      debug: (msg, fields) => log('debug', msg, fields),
      info: (msg, fields) => log('info', msg, fields),
      warn: (msg, fields) => log('warn', msg, fields),
      error: (msg, fields) => log('error', msg, fields),
      child: (fields) => make({ ...base, ...fields }),
    };
  };
  return make(options.base ?? {});
}

/** A logger that drops everything (tests). */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

/** A logger that keeps entries in memory (tests). */
export function memoryLogger(): Logger & {
  entries: Array<{ level: LogLevel; msg: string; fields: Record<string, LogValue> }>;
} {
  const entries: Array<{ level: LogLevel; msg: string; fields: Record<string, LogValue> }> = [];
  const make = (base: LogFields): Logger => {
    const log = (level: LogLevel) => (msg: string, fields?: LogFields) =>
      entries.push({ level, msg, fields: { ...base, ...fields } });
    return {
      debug: log('debug'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
      child: (fields) => make({ ...base, ...fields }),
    };
  };
  return Object.assign(make({}), { entries });
}

// originals/{photographerId}/{fileId}/{name}: the name segment may be personal data.
const ORIGINAL_KEY = /originals\/[^\s"'`]+/g;
const MAX_MESSAGE_LENGTH = 300;

/** Loggable fields of an error: its name, code and a scrubbed, truncated message. */
export function errorFields(error: unknown): Record<string, LogValue> {
  if (!(error instanceof Error)) return { errorName: typeof error };
  const code = (error as { code?: unknown }).code;
  return {
    errorName: error.name,
    errorCode: typeof code === 'string' ? code : undefined,
    errorMessage: error.message
      .replace(ORIGINAL_KEY, 'originals/<redacted>')
      .slice(0, MAX_MESSAGE_LENGTH),
  };
}
