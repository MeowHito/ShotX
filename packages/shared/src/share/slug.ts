import { z } from 'zod';
import type { ShareTargetType } from '../domain';
import { cryptoRandomBytes, isShareToken, type RandomBytes } from './token';

/**
 * Readable share URLs (ADR 0011 decision 3): `/s/{slug}`, the event (folder or file) name as a
 * slug, with a short random suffix only when the slug is taken. Old `/s/{token}` links keep
 * working: every public share route takes a *ref*, which is a token or a slug (parseShareRef).
 *
 * Rules of a slug (isShareSlug; `shares_slug_valid` checks what SQL can):
 * - NFC, lowercase (String.prototype.toLowerCase), segments of Unicode letters, marks and digits
 *   (`\p{L}\p{M}\p{N}`: Thai, Chinese, Latin, ...) joined by single `-`;
 * - at most SHARE_SLUG_MAX_LENGTH code points (a base of SHARE_SLUG_BASE_MAX_LENGTH plus the
 *   suffix);
 * - never token-shaped (22 ASCII letters or digits, isShareToken): such a base always gets the
 *   suffix, so a ref is a token or a slug, never both, and lookups need no fallback.
 *
 * A slug is generated once, by the API, when the share is created (shareSlugCandidate), and never
 * changes: renaming the folder keeps the link. Slugs are unique over all shares of every
 * photographer, revoked and expired ones included (`shares_slug_unique`): a revoked share's slug is
 * never handed to another share, so an old link can't start showing someone else's event.
 *
 * Case-insensitive: slugs are stored in canonical form (lowercase, NFC) and a ref is canonicalized
 * the same way before the lookup (normalizeShareSlug), so `/s/Bangkok-Run` finds `bangkok-run`.
 */

/** Longest base slug (before the suffix), in code points. */
export const SHARE_SLUG_BASE_MAX_LENGTH = 60;

/** Characters of the random suffix: lowercase base36 (CSPRNG, unbiased). */
export const SHARE_SLUG_SUFFIX_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
export const SHARE_SLUG_SUFFIX_LENGTH = 6;

/** Longest slug: base + `-` + suffix, in code points (`shares_slug_valid` uses it). */
export const SHARE_SLUG_MAX_LENGTH = SHARE_SLUG_BASE_MAX_LENGTH + 1 + SHARE_SLUG_SUFFIX_LENGTH;

/** The base when nothing usable is left of the name (emoji only, punctuation only, empty). */
export const SHARE_SLUG_FALLBACK = 'event';

/**
 * Inserts the API tries before giving up (INTERNAL_ERROR): the base, then suffixed candidates. A
 * unique violation on `shares_slug_unique` means "taken": retry with the next candidate.
 */
export const SHARE_SLUG_MAX_ATTEMPTS = 5;

/**
 * First path segments the web app uses for its own pages and files (ADR 0015: share pages live at
 * the site root, `/{slug}`). The API never generates these as slugs (shareSlugCandidate adds the
 * suffix); a share that already holds one keeps its `/s/{slug}` link (shareRefPath).
 */
export const SHARE_SLUG_RESERVED: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'auth',
  'bff',
  'change-password',
  'healthz',
  'login',
  'logout',
  'mediapipe',
  'pricing',
  's',
  'studio',
]);

/** True when a slug can't be served at the site root (SHARE_SLUG_RESERVED). */
export function isReservedShareSlug(slug: string): boolean {
  return SHARE_SLUG_RESERVED.has(slug);
}

const SLUG_PATTERN = /^[\p{L}\p{M}\p{N}]+(?:-[\p{L}\p{M}\p{N}]+)*$/u;
const SUFFIX_PATTERN = new RegExp(`^[0-9a-z]{${SHARE_SLUG_SUFFIX_LENGTH}}$`);
/** Variation selectors and enclosing marks (keycaps): parts of emoji, not of words. */
const EMOJI_MARKS = /[︀-️\u{E0100}-\u{E01EF}\p{Me}]/gu;
const NOT_WORD = /[^\p{L}\p{M}\p{N}]+/gu;
/** Combining marks left without a base character (at the start of a segment). */
const ORPHAN_MARKS = /(^|-)\p{M}+/gu;

const codePoints = (s: string) => [...s].length;

/** Lowercase, then NFC (lowercasing can denormalize, e.g. U+0130). */
function canonical(s: string): string {
  return s.normalize('NFC').toLowerCase().normalize('NFC');
}

/** True for a slug in canonical form that the API could have stored. */
export function isShareSlug(value: string): boolean {
  const length = codePoints(value);
  return (
    length >= 1 &&
    length <= SHARE_SLUG_MAX_LENGTH &&
    SLUG_PATTERN.test(value) &&
    value === canonical(value) &&
    !isShareToken(value)
  );
}

/** A slug in canonical form (responses; never used to parse refs, see parseShareRef). */
export const shareSlugSchema = z.string().refine(isShareSlug, { error: 'must be a share slug' });

/** Truncates to at most `max` code points on a grapheme boundary, preferring a `-` boundary. */
function truncate(slug: string, max: number): string {
  if (codePoints(slug) <= max) return slug;
  let out = '';
  let used = 0;
  for (const { segment } of new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(slug)) {
    const n = codePoints(segment);
    if (used + n > max) break;
    out += segment;
    used += n;
  }
  // Cut at the last word boundary when it keeps at least half the room (English reads better).
  const dash = out.lastIndexOf('-');
  if (dash > 0 && codePoints(out.slice(0, dash)) >= max / 2) out = out.slice(0, dash);
  return out.replace(/-+$/u, '');
}

/**
 * The base slug of an event name: canonical lowercase, emoji parts dropped, every run of
 * characters other than letters, marks and digits (spaces, punctuation, symbols, emoji) turned
 * into one `-`, dashes trimmed, at most SHARE_SLUG_BASE_MAX_LENGTH code points (cut between
 * graphemes, so a Thai vowel or tone mark is never separated from its consonant). Nothing left:
 * SHARE_SLUG_FALLBACK. Pure and deterministic.
 *
 * The result may be token-shaped (e.g. a 22-letter ASCII name) and so not a valid slug on its
 * own; shareSlugCandidate adds the suffix then.
 *
 *   slugifyEventName('Bangkok Marathon 2026!')  -> 'bangkok-marathon-2026'
 *   slugifyEventName('งานวิ่ง กรุงเทพ 2026')        -> 'งานวิ่ง-กรุงเทพ-2026'
 *   slugifyEventName('🎉🎉')                     -> 'event'
 */
export function slugifyEventName(name: string): string {
  const slug = canonical(name)
    .replace(EMOJI_MARKS, '')
    .replace(NOT_WORD, '-')
    .replace(ORPHAN_MARKS, '$1')
    .replace(/-{2,}/gu, '-')
    .replace(/^-+|-+$/gu, '');
  const cut = truncate(slug, SHARE_SLUG_BASE_MAX_LENGTH);
  return cut === '' ? SHARE_SLUG_FALLBACK : cut;
}

/** File extension stripped for file shares: `.` + 1–8 ASCII letters or digits at the end. */
const FILE_EXTENSION = /\.[0-9A-Za-z]{1,8}$/;

/**
 * The name a share's slug is made from: the folder's name, or the file's name without its
 * extension (`IMG_1234.JPG` -> `IMG_1234`). Migration 0012's backfill applies the same rule.
 */
export function shareSlugSourceName(targetType: ShareTargetType, name: string): string {
  if (targetType !== 'file') return name;
  const stem = name.replace(FILE_EXTENSION, '');
  return stem === '' ? name : stem;
}

/** A random suffix: SHARE_SLUG_SUFFIX_LENGTH lowercase base36 characters from a CSPRNG. */
export function generateShareSlugSuffix(randomBytes: RandomBytes = cryptoRandomBytes): string {
  const alphabet = SHARE_SLUG_SUFFIX_ALPHABET.length;
  // Rejection sampling: bytes >= 252 (7 x 36) would bias the first characters.
  const limit = Math.floor(256 / alphabet) * alphabet;
  let out = '';
  while (out.length < SHARE_SLUG_SUFFIX_LENGTH) {
    for (const byte of randomBytes(16)) {
      if (byte >= limit) continue;
      out += SHARE_SLUG_SUFFIX_ALPHABET[byte % alphabet];
      if (out.length === SHARE_SLUG_SUFFIX_LENGTH) break;
    }
  }
  return out;
}

/** `{base}-{suffix}`. The base must come from slugifyEventName; the suffix must be well-formed. */
export function withShareSlugSuffix(base: string, suffix: string): string {
  if (!SUFFIX_PATTERN.test(suffix)) throw new RangeError('Not a share slug suffix');
  const slug = `${base}-${suffix}`;
  if (!isShareSlug(slug)) throw new RangeError('Not a share slug base');
  return slug;
}

/**
 * The slug to try on insert attempt `attempt` (0-based, below SHARE_SLUG_MAX_ATTEMPTS): the base
 * itself first (when it is a valid slug, i.e. not token-shaped, and not reserved), then the base with a new random
 * suffix each time.
 */
export function shareSlugCandidate(
  base: string,
  attempt: number,
  randomBytes: RandomBytes = cryptoRandomBytes,
): string {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= SHARE_SLUG_MAX_ATTEMPTS) {
    throw new RangeError('attempt out of range');
  }
  if (attempt === 0 && isShareSlug(base) && !isReservedShareSlug(base)) return base;
  return withShareSlugSuffix(base, generateShareSlugSuffix(randomBytes));
}

/** Canonical form of a slug ref, or null when it can't be a slug (then the answer is NOT_FOUND). */
export function normalizeShareSlug(raw: string): string | null {
  // Cheap bound before normalizing attacker-chosen input (4 UTF-16 units per code point at most
  // matters only for pathological input).
  if (raw.length === 0 || raw.length > 4 * SHARE_SLUG_MAX_LENGTH) return null;
  const slug = canonical(raw);
  return isShareSlug(slug) ? slug : null;
}

export type ShareRef = { kind: 'token'; token: string } | { kind: 'slug'; slug: string };

/**
 * How the API reads the `:token` path parameter of every public share route (it carries a ref,
 * the name stays for compatibility):
 * 1. a value that is still percent-encoded (contains `%`; slugs never do) is decoded once;
 * 2. token-shaped (isShareToken, case-sensitive) -> look up `shares.token`;
 * 3. else canonicalized (normalizeShareSlug) -> look up `shares.slug` (unique index);
 * 4. else null -> NOT_FOUND, exactly like an unknown token or slug (never VALIDATION_FAILED).
 * Because slugs are never token-shaped, at most one lookup runs.
 */
export function parseShareRef(raw: string): ShareRef | null {
  let value = raw;
  if (value.includes('%')) {
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  if (isShareToken(value)) return { kind: 'token', token: value };
  const slug = normalizeShareSlug(value);
  return slug === null ? null : { kind: 'slug', slug };
}

/**
 * The `:token` path parameter of public share routes: a ref (token or slug). Deliberately loose:
 * the API answers NOT_FOUND for anything parseShareRef rejects.
 */
export const shareRefSchema = z.string().min(1).max(1024);

/** The ref a share is linked by: its slug when it has one, else its token. */
export function shareRefOf(share: { slug: string | null; token: string }): string {
  return share.slug ?? share.token;
}

/**
 * Path of a share page for a ref, percent-encoded: `/{ref}` at the site root (ADR 0015), or
 * `/s/{ref}` for a slug the web app's own pages already use (SHARE_SLUG_RESERVED). Old `/s/{ref}`
 * links redirect to the root path.
 */
export function shareRefPath(ref: string): string {
  if (!isShareToken(ref) && !isShareSlug(ref)) throw new RangeError('Not a share ref');
  const encoded = encodeURIComponent(ref);
  return isReservedShareSlug(ref) ? `/s/${encoded}` : `/${encoded}`;
}

/** The public path of a share: `/{slug}` (ADR 0011, 0015), or `/{token}` while it has no slug. */
export function sharePublicPath(share: { slug: string | null; token: string }): string {
  return shareRefPath(shareRefOf(share));
}

/** Absolute public link, e.g. `https://example.com/bangkok-run`. */
export function sharePublicUrl(
  publicBaseUrl: string,
  share: { slug: string | null; token: string },
): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}${sharePublicPath(share)}`;
}

/**
 * Path of the unlinked "ขอลบใบหน้าของฉัน" page (ADR 0011 decision 2): `/{ref}/delete-my-face`.
 * Nothing on the share page, in the consent text or in the footer links to it; the company sends
 * it to a person who asks for deletion.
 */
export function shareFaceDeletionPagePath(ref: string): string {
  return `${shareRefPath(ref)}/delete-my-face`;
}

/** `X-Robots-Tag` / robots meta of every share page (ADR 0011 risk 3: slugs are guessable). */
export const SHARE_PAGE_ROBOTS = 'noindex, nofollow';
