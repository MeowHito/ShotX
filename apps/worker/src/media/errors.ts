/**
 * The original can't be decoded (corrupt, truncated, an unsupported codec, over the pixel limit).
 * Retrying won't help: the worker fails the file instead.
 */
export class MediaDecodeError extends Error {
  override readonly name = 'MediaDecodeError';
}

// Resource exhaustion is the machine's fault, not the file's: retry those.
const TRANSIENT = /ENOSPC|ENOMEM|EMFILE|No space left|out of memory|Cannot allocate memory/i;

export function isTransientMediaFailure(message: string): boolean {
  return TRANSIENT.test(message);
}
