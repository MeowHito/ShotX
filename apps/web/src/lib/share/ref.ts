import { parseShareRef } from '@shotx/shared';

/**
 * The ref a share page URL names (ADR 0011, 0015: `/{slug}` or `/{token}`), as the API
 * looks it up: the token, or the canonical slug (decoded once, lowercase NFC), or null for
 * anything that can't be a share (the page answers 404 without asking the API). The API client
 * percent-encodes it once.
 */
export function shareRefFromPath(raw: string): string | null {
  const parsed = parseShareRef(raw);
  if (parsed === null) return null;
  return parsed.kind === 'token' ? parsed.token : parsed.slug;
}
