import { describe, expect, it } from 'vitest';
import { loadBillingConfig } from './billing';
import { loadMediaConfig } from './media';
import { loadQueueUrls } from './queues';
import { loadRetentionConfig } from './retention';
import { loadShareConfig } from './share';
import { loadUploadConfig } from './upload';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

describe('loadUploadConfig', () => {
  it('uses the defaults', () => {
    expect(loadUploadConfig({})).toEqual({
      maxBytes: { image: 100 * MiB, video: 5 * GiB },
      partBytes: 16 * MiB,
      presignTtlSeconds: 3600,
      partConcurrency: 4,
    });
  });

  it('reads overrides, including sizes above 2^31 bytes', () => {
    const config = loadUploadConfig({
      UPLOAD_MAX_IMAGE_BYTES: String(50 * MiB),
      UPLOAD_MAX_VIDEO_BYTES: String(20 * GiB),
      UPLOAD_PART_BYTES: String(64 * MiB),
      UPLOAD_PRESIGN_TTL_SECONDS: '900',
      UPLOAD_PART_CONCURRENCY: '6',
    });
    expect(config).toEqual({
      maxBytes: { image: 50 * MiB, video: 20 * GiB },
      partBytes: 64 * MiB,
      presignTtlSeconds: 900,
      partConcurrency: 6,
    });
  });

  it('rejects a part size that would need more than 10,000 parts', () => {
    expect(() =>
      loadUploadConfig({ UPLOAD_MAX_VIDEO_BYTES: String(50 * GiB), UPLOAD_PART_BYTES: '5242880' }),
    ).toThrow(/more than 10000 parts/);
  });

  it.each([
    ['UPLOAD_PART_BYTES', String(5 * MiB - 1)],
    ['UPLOAD_MAX_IMAGE_BYTES', String(2 * GiB)],
    ['UPLOAD_MAX_VIDEO_BYTES', '1.5'],
    ['UPLOAD_PRESIGN_TTL_SECONDS', '30'],
    ['UPLOAD_PART_CONCURRENCY', '0'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => loadUploadConfig({ [key]: value })).toThrow(new RegExp(`at ${key}\\b`));
  });
});

describe('loadMediaConfig', () => {
  it('uses the spec sizes', () => {
    expect(loadMediaConfig({})).toEqual({
      thumb: { longEdge: 400, webpQuality: 80 },
      preview: { longEdge: 2048, webpQuality: 80 },
      web: { longEdge: 2560, jpegQuality: 85 },
      poster: { jpegQuality: 85 },
      videoPreview: { height: 720, crf: 23 },
    });
  });

  it('rejects a thumbnail larger than the preview', () => {
    expect(() => loadMediaConfig({ MEDIA_THUMB_LONG_EDGE: '3000' })).toThrow(
      /MEDIA_THUMB_LONG_EDGE must be less than or equal to MEDIA_PREVIEW_LONG_EDGE/,
    );
  });

  it.each([
    ['MEDIA_WEB_JPEG_QUALITY', '101'],
    ['MEDIA_VIDEO_PREVIEW_HEIGHT', '100'],
    ['MEDIA_VIDEO_PREVIEW_CRF', '52'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => loadMediaConfig({ [key]: value })).toThrow(new RegExp(`at ${key}\\b`));
  });
});

describe('loadShareConfig', () => {
  it('uses the spec timings and the zip defaults', () => {
    expect(loadShareConfig({})).toEqual({
      signedUrlTtlSeconds: { view: 3600, download: 600 },
      pageSize: 100,
      faceOnlyGrantTtlSeconds: 86_400,
      unlockTtlSeconds: 86_400,
      anonIdMaxAgeDays: 365,
      zip: { maxFiles: 500, maxBytes: 2 * GiB },
    });
  });

  it('reads overrides', () => {
    const config = loadShareConfig({
      SIGNED_URL_VIEW_TTL_SECONDS: '7200',
      SIGNED_URL_DOWNLOAD_TTL_SECONDS: '300',
      SHARE_FACE_ONLY_GRANT_TTL_SECONDS: '3600',
      ZIP_MAX_FILES: '1000',
      ZIP_MAX_BYTES: String(8 * GiB),
    });
    expect(config.signedUrlTtlSeconds).toEqual({ view: 7200, download: 300 });
    expect(config.faceOnlyGrantTtlSeconds).toBe(3600);
    expect(config.zip).toEqual({ maxFiles: 1000, maxBytes: 8 * GiB });
  });

  it('rejects download URLs that outlive view URLs', () => {
    expect(() => loadShareConfig({ SIGNED_URL_DOWNLOAD_TTL_SECONDS: '7200' })).toThrow(
      /SIGNED_URL_DOWNLOAD_TTL_SECONDS must be less than or equal to SIGNED_URL_VIEW_TTL_SECONDS/,
    );
  });

  it.each([
    ['ZIP_MAX_FILES', '0'],
    ['ZIP_MAX_FILES', '10001'],
    ['ZIP_MAX_BYTES', '1024'],
    ['ANON_ID_MAX_AGE_DAYS', '401'],
    ['SHARE_PAGE_SIZE', '501'],
    ['SIGNED_URL_VIEW_TTL_SECONDS', '59'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => loadShareConfig({ [key]: value })).toThrow(new RegExp(`at ${key}\\b`));
  });
});

describe('loadRetentionConfig', () => {
  it('uses the spec retention periods', () => {
    expect(loadRetentionConfig({})).toEqual({
      trashRetentionDays: 30,
      faceIndexExpiryDays: 90,
      subscription: { graceDays: 14, purgeAfterExpiryDays: 45, reminderDays: [14, 7, 1] },
    });
  });

  it('accepts a purge delay from 30 to 60 days only', () => {
    for (const days of ['30', '60']) {
      expect(
        loadRetentionConfig({ SUBSCRIPTION_PURGE_AFTER_EXPIRY_DAYS: days }).subscription
          .purgeAfterExpiryDays,
      ).toBe(Number(days));
    }
    for (const days of ['29', '61']) {
      expect(() => loadRetentionConfig({ SUBSCRIPTION_PURGE_AFTER_EXPIRY_DAYS: days })).toThrow(
        /at SUBSCRIPTION_PURGE_AFTER_EXPIRY_DAYS\b/,
      );
    }
  });

  it('parses reminder days as a list and sorts it', () => {
    expect(
      loadRetentionConfig({ SUBSCRIPTION_REMINDER_DAYS: '1, 30,7' }).subscription.reminderDays,
    ).toEqual([30, 7, 1]);
  });

  it('treats an empty reminder list as unset', () => {
    expect(
      loadRetentionConfig({ SUBSCRIPTION_REMINDER_DAYS: '' }).subscription.reminderDays,
    ).toEqual([14, 7, 1]);
  });

  it.each(['7,7', '0', '61', 'x', '1,,2', '1.5'])(
    'rejects SUBSCRIPTION_REMINDER_DAYS=%j',
    (value) => {
      expect(() => loadRetentionConfig({ SUBSCRIPTION_REMINDER_DAYS: value })).toThrow(
        /SUBSCRIPTION_REMINDER_DAYS/,
      );
    },
  );
});

describe('loadBillingConfig', () => {
  it('uses the spec values', () => {
    expect(loadBillingConfig({})).toEqual({
      prepaidMonths: [1, 3, 6, 12],
      vatRateBasisPoints: 700,
      egressAnomalyMultiplier: 20,
    });
  });

  it('reads overrides', () => {
    expect(
      loadBillingConfig({
        BILLING_PREPAID_MONTHS: '12,1',
        VAT_RATE_BASIS_POINTS: '1000',
        EGRESS_ANOMALY_MULTIPLIER: '12.5',
      }),
    ).toEqual({ prepaidMonths: [1, 12], vatRateBasisPoints: 1000, egressAnomalyMultiplier: 12.5 });
  });

  it.each([
    ['BILLING_PREPAID_MONTHS', '0'],
    ['VAT_RATE_BASIS_POINTS', '7.5'],
    ['EGRESS_ANOMALY_MULTIPLIER', '0'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => loadBillingConfig({ [key]: value })).toThrow(new RegExp(`at ${key}\\b`));
  });
});

describe('loadQueueUrls', () => {
  const env = {
    MEDIA_QUEUE_URL: 'http://localhost:4566/queue/ap-southeast-1/000000000000/shotx-local-media',
    FACES_QUEUE_URL: 'http://localhost:4566/queue/ap-southeast-1/000000000000/shotx-local-faces',
    ZIP_QUEUE_URL: 'http://localhost:4566/queue/ap-southeast-1/000000000000/shotx-local-zip',
  };

  it('reads only the requested queues', () => {
    expect(loadQueueUrls(env, ['zip', 'faces'])).toEqual({
      zip: env.ZIP_QUEUE_URL,
      faces: env.FACES_QUEUE_URL,
    });
  });

  it('requires every requested queue', () => {
    expect(() => loadQueueUrls(env, ['media', 'jobs'])).toThrow(/at JOBS_QUEUE_URL\b/);
    expect(() => loadQueueUrls({ ...env, MEDIA_QUEUE_URL: 'not a url' }, ['media'])).toThrow(
      /at MEDIA_QUEUE_URL\b/,
    );
  });
});
