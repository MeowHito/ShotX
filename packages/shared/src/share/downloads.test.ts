import { describe, expect, it } from 'vitest';
import { type DownloadableFile, downloadObject, shareDownloadObject } from './downloads';

const CAP = 1_500_000;

const image = (sizeBytes: number): DownloadableFile => ({
  mediaKind: 'image',
  name: 'IMG_0001.png',
  s3Key: 'originals/p/f/IMG_0001.png',
  webKey: 'derived/p/f/web.jpg',
  previewKey: 'derived/p/f/preview.webp',
  sizeBytes,
  webSizeBytes: 400_000,
});

describe('shareDownloadObject (ADR 0028: viewers get images of at most 1.5 MB)', () => {
  it('serves web.jpg instead of an original over the cap', () => {
    expect(shareDownloadObject(image(CAP + 1), 'original', CAP)).toEqual({
      key: 'derived/p/f/web.jpg',
      fileName: 'IMG_0001.jpg',
      bytes: 400_000,
    });
  });

  it('keeps an original at or under the cap', () => {
    expect(shareDownloadObject(image(CAP), 'original', CAP)).toEqual(
      downloadObject(image(CAP), 'original'),
    );
  });

  it('leaves web downloads, videos and a cap of 0 alone', () => {
    expect(shareDownloadObject(image(CAP * 4), 'web', CAP)).toEqual(
      downloadObject(image(CAP * 4), 'web'),
    );
    const video: DownloadableFile = { ...image(CAP * 40), mediaKind: 'video', name: 'clip.mp4' };
    expect(shareDownloadObject(video, 'original', CAP)).toEqual(downloadObject(video, 'original'));
    expect(shareDownloadObject(image(CAP * 4), 'original', 0)).toEqual(
      downloadObject(image(CAP * 4), 'original'),
    );
  });
});
