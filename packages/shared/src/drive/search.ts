import { driveNameKey } from './names';

// Pure helpers of `GET /drive/search` (Wave 7). The query runs per owner: `owner_id = $1` first
// (files_owner_idx / folders_owner_idx), then the name condition, which the trigram GIN indexes
// of migration 0008 (`files_name_trgm_idx`, `folders_name_trgm_idx`, on
// `lower(name COLLATE "C") gin_trgm_ops`) can serve for 3+ characters:
//
//   lower(name COLLATE "C") LIKE $pattern ESCAPE '\'    with $pattern = driveSearchPattern(q)
//
// Matching is "name contains q", ignoring ASCII case exactly as sibling uniqueness does
// (driveNameKey; PostgreSQL's lower() under the C collation folds A-Z only, the same on every
// server). Thai has no case and matches as typed (NFC). Shorter queries, and scripts whose
// characters the server's ctype doesn't treat as word characters (pg_trgm extracts no trigrams
// for them), fall back to scanning the owner's rows: results are the same, only slower.

/** The search text as the name keys are compared: NFC, trimmed, ASCII A-Z lowercased. */
export function driveSearchKey(q: string): string {
  return driveNameKey(q.normalize('NFC').trim());
}

/**
 * The LIKE pattern for "name contains q": `%` + the search key with `\`, `%` and `_` escaped +
 * `%`. Use with `ESCAPE '\'`.
 */
export function driveSearchPattern(q: string): string {
  return `%${driveSearchKey(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
