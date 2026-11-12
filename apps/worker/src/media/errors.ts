/**
 * The original can't be decoded (corrupt, truncated, an unsupported codec, over the pixel limit).
 * Retrying won't help: the worker fails the file instead.
 */
export class MediaDecodeError extends Error {
  override readonly name = 'MediaDecodeError';
}

/**
 * The bytes decode, but as another format than the one verified (a design image re-PUT with the
 * still-valid presigned URL after the magic-byte check, ADR 0013). Retrying won't help.
 */
export class MediaFormatMismatchError extends Error {
  override readonly name = 'MediaFormatMismatchError';
  constructor(
    readonly expected: string,
    readonly actual: string | undefined,
  ) {
    super(`Image format ${actual ?? 'unknown'} is not the verified ${expected}`);
  }
}

// Resource exhaustion is the machine's fault, not the file's: retry those.
const TRANSIENT = /ENOSPC|ENOMEM|EMFILE|No space left|out of memory|Cannot allocate memory/i;

export function isTransientMediaFailure(message: string): boolean {
  return TRANSIENT.test(message);
}
