import type { OwnerShare } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { faceDeletionUrl } from './share-row';

const base = { url: 'https://snap.action.in.th/s/bangkok-run', token: 'aB3dE5fG7hJ9kL1mN3pQ5r' };

describe('faceDeletionUrl', () => {
  it('is the delete-my-face page of the slug, on the share link’s origin', () => {
    const share: Pick<OwnerShare, 'url' | 'slug' | 'token'> = { ...base, slug: 'bangkok-run' };
    expect(faceDeletionUrl(share)).toBe('https://snap.action.in.th/s/bangkok-run/delete-my-face');
    expect(faceDeletionUrl({ ...base, slug: 'งานวิ่ง' })).toBe(
      `https://snap.action.in.th/s/${encodeURIComponent('งานวิ่ง')}/delete-my-face`,
    );
  });

  it('uses the token while the share has no slug', () => {
    expect(faceDeletionUrl({ ...base, slug: null })).toBe(
      `https://snap.action.in.th/s/${base.token}/delete-my-face`,
    );
  });
});
