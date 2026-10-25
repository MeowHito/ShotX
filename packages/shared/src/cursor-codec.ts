import type { z } from 'zod';

/** Largest encoded cursor accepted in a query string. */
export const CURSOR_MAX_LENGTH = 2048;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Keyset cursors are opaque to clients: base64url(JSON) of a value validated by `schema`. The web
 * app passes `nextCursor` back unchanged and never builds or parses one.
 */
export function encodeOpaqueCursor<S extends z.ZodType>(schema: S, value: z.input<S>): string {
  const valid = schema.parse(value);
  return toBase64Url(new TextEncoder().encode(JSON.stringify(valid)));
}

/** The cursor, or null when `text` is not one `schema` accepts. Never throws. */
export function decodeOpaqueCursor<S extends z.ZodType>(
  schema: S,
  text: string,
): z.output<S> | null {
  if (text.length === 0 || text.length > CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(text)) {
    return null;
  }
  try {
    const json: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(text)),
    );
    const result = schema.safeParse(json);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
