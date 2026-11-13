import { describe, expect, it } from 'vitest';
import { mediaJobPriority } from './bullmq-queue';

describe('media job priority (design images first)', () => {
  it('leaves design.asset unprioritized so it runs before event photos', () => {
    expect(
      mediaJobPriority('media', { kind: 'design.asset', assetId: 'a', photographerId: 'p' }),
    ).toEqual({});
    expect(mediaJobPriority('media', { kind: 'original.completed', fileId: 'f' })).toEqual({
      priority: 1,
    });
    expect(mediaJobPriority('faces', { type: 'index.file', fileId: 'f' })).toEqual({});
    expect(mediaJobPriority('zip', { kind: 'zip', jobId: 'z' })).toEqual({});
  });
});
