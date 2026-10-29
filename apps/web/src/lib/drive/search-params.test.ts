import { describe, expect, it } from 'vitest';
import {
  calendarDay,
  EMPTY_SEARCH,
  filterCount,
  parseSearch,
  searchHref,
  toSearchQuery,
} from './search-params';

const FOLDER = '0195f3a2-8d2f-7e5b-8c3a-4d5e6f7a8b9c';

describe('search parameters', () => {
  it('round-trips text and filters through the URL', () => {
    const search = {
      q: 'งานวิ่ง',
      type: 'video' as const,
      takenFrom: '2026-01-01',
      takenTo: '2026-01-31',
      uploadedFrom: null,
      uploadedTo: '2026-02-01',
      folderId: FOLDER,
    };
    const href = searchHref(search);
    expect(href.startsWith('/studio/search?')).toBe(true);
    expect(parseSearch(new URL(href, 'https://x').searchParams)).toEqual(search);
    expect(filterCount(search)).toBe(4);
    expect(searchHref(EMPTY_SEARCH)).toBe('/studio/search');
  });

  it('drops malformed values', () => {
    expect(
      parseSearch({ type: 'pdf', takenFrom: '2026-02-30', folder: '../x', q: ['a', 'b'] }),
    ).toEqual(EMPTY_SEARCH);
    expect(calendarDay('2026-13-01')).toBeNull();
    expect(calendarDay('2026-02-28')).toBe('2026-02-28');
    expect(parseSearch({ q: 'x'.repeat(500) }).q).toHaveLength(100);
  });

  it('maps Bangkok calendar days to the API instants, the end day included', () => {
    expect(
      toSearchQuery({ ...EMPTY_SEARCH, takenFrom: '2026-01-01', takenTo: '2026-01-31' }),
    ).toEqual({
      type: 'any',
      takenFrom: '2025-12-31T17:00:00.000Z',
      takenTo: '2026-01-31T17:00:00.000Z',
    });
    expect(toSearchQuery({ ...EMPTY_SEARCH, q: ' a ', type: 'image', folderId: FOLDER })).toEqual({
      q: 'a',
      type: 'image',
      folderId: FOLDER,
    });
  });

  it('asks nothing without a criterion or with an inverted range', () => {
    expect(toSearchQuery(EMPTY_SEARCH)).toBeNull();
    expect(toSearchQuery({ ...EMPTY_SEARCH, q: '   ' })).toBeNull();
    expect(
      toSearchQuery({ ...EMPTY_SEARCH, uploadedFrom: '2026-02-01', uploadedTo: '2026-01-01' }),
    ).toBeNull();
  });
});
