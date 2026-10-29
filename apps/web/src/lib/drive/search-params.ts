import {
  DRIVE_SEARCH_QUERY_MAX_LENGTH,
  idSchema,
  MEDIA_KINDS,
  type MediaKind,
  type SearchDriveQuery,
} from '@shotx/shared';

/**
 * The studio search as URL parameters (`/studio/search?q=…&type=image&takenFrom=2026-01-01…`):
 * plain text plus filters. Dates are calendar days (YYYY-MM-DD) in Asia/Bangkok; toSearchQuery
 * turns them into the instants GET /drive/search takes ([from, to), so "to" covers its whole day).
 */
export interface DriveSearch {
  q: string;
  type: MediaKind | null;
  takenFrom: string | null;
  takenTo: string | null;
  uploadedFrom: string | null;
  uploadedTo: string | null;
  /** Only inside this folder (and its subfolders). */
  folderId: string | null;
}

export const SEARCH_PATH = '/studio/search';
export const MAX_QUERY_LENGTH = DRIVE_SEARCH_QUERY_MAX_LENGTH;

/** Asia/Bangkok has no daylight saving time: every day starts at 00:00 +07:00. */
const BANGKOK_OFFSET = '+07:00';

export const EMPTY_SEARCH: DriveSearch = {
  q: '',
  type: null,
  takenFrom: null,
  takenTo: null,
  uploadedFrom: null,
  uploadedTo: null,
  folderId: null,
};

/** A real calendar day as YYYY-MM-DD, or null. */
export function calendarDay(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

/** True when both ends are set and the start is after the end. */
export function rangeInvalid(from: string | null, to: string | null): boolean {
  return from !== null && to !== null && from > to;
}

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

function get(params: Params, name: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(name) ?? undefined;
  const value = params[name];
  return typeof value === 'string' ? value : undefined;
}

/** Reads a search from URL parameters, dropping anything malformed. */
export function parseSearch(params: Params): DriveSearch {
  const type = get(params, 'type');
  const folder = get(params, 'folder');
  return {
    q: (get(params, 'q') ?? '').trim().slice(0, MAX_QUERY_LENGTH),
    type: (MEDIA_KINDS as readonly string[]).includes(type ?? '') ? (type as MediaKind) : null,
    takenFrom: calendarDay(get(params, 'takenFrom')),
    takenTo: calendarDay(get(params, 'takenTo')),
    uploadedFrom: calendarDay(get(params, 'uploadedFrom')),
    uploadedTo: calendarDay(get(params, 'uploadedTo')),
    folderId: folder !== undefined && idSchema.safeParse(folder).success ? folder : null,
  };
}

/** The search page URL for a search (only the parameters that are set). */
export function searchHref(search: DriveSearch): string {
  const query = new URLSearchParams();
  const q = search.q.trim().slice(0, MAX_QUERY_LENGTH);
  if (q !== '') query.set('q', q);
  if (search.type !== null) query.set('type', search.type);
  for (const key of ['takenFrom', 'takenTo', 'uploadedFrom', 'uploadedTo'] as const) {
    const day = calendarDay(search[key]);
    if (day !== null) query.set(key, day);
  }
  if (search.folderId !== null) query.set('folder', search.folderId);
  const qs = query.toString();
  return qs === '' ? SEARCH_PATH : `${SEARCH_PATH}?${qs}`;
}

/** How many filters (not the text) are set: the badge on the filter button. */
export function filterCount(search: DriveSearch): number {
  return [
    search.type,
    search.takenFrom ?? search.takenTo,
    search.uploadedFrom ?? search.uploadedTo,
    search.folderId,
  ].filter((v) => v !== null).length;
}

function dayStart(day: string): string {
  return new Date(`${day}T00:00:00${BANGKOK_OFFSET}`).toISOString();
}

function nextDayStart(day: string): string {
  const start = new Date(`${day}T00:00:00${BANGKOK_OFFSET}`);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

/**
 * The GET /drive/search query of a search, or null when it has no criterion (the API needs at
 * least one) or an inverted date range.
 */
export function toSearchQuery(search: DriveSearch): SearchDriveQuery | null {
  if (rangeInvalid(search.takenFrom, search.takenTo)) return null;
  if (rangeInvalid(search.uploadedFrom, search.uploadedTo)) return null;
  const q = search.q.trim();
  const query: SearchDriveQuery = {
    ...(q !== '' ? { q } : {}),
    type: search.type ?? 'any',
    ...(search.takenFrom !== null ? { takenFrom: dayStart(search.takenFrom) } : {}),
    ...(search.takenTo !== null ? { takenTo: nextDayStart(search.takenTo) } : {}),
    ...(search.uploadedFrom !== null ? { uploadedFrom: dayStart(search.uploadedFrom) } : {}),
    ...(search.uploadedTo !== null ? { uploadedTo: nextDayStart(search.uploadedTo) } : {}),
    ...(search.folderId !== null ? { folderId: search.folderId } : {}),
  };
  const hasCriterion = q !== '' || search.type !== null || filterCount(search) > 0;
  return hasCriterion ? query : null;
}
