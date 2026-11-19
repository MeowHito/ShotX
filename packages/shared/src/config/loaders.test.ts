import { describe, expect, it } from 'vitest';
import { loadBillingConfig } from './billing';
import { loadMediaConfig, loadShareDownloadCapConfig } from './media';
import { loadQueueUrls } from './queues';
import { loadRetentionConfig } from './retention';
import { loadShareConfig } from './share';
import { DRIVE_PAGE_SIZE_LIMIT, loadDriveConfig } from './drive';
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
      sessionTtlSeconds: 86_400,
      initPresignedParts: 8,
    });
  });

  it('reads overrides, including sizes above 2^31 bytes', () => {
    const config = loadUploadConfig({
      UPLOAD_MAX_IMAGE_BYTES: String(50 * MiB),
      UPLOAD_MAX_VIDEO_BYTES: String(20 * GiB),
      UPLOAD_PART_BYTES: String(64 * MiB),
      UPLOAD_PRESIGN_TTL_SECONDS: '900',
      UPLOAD_PART_CONCURRENCY: '6',
      UPLOAD_SESSION_TTL_SECONDS: '7200',
      UPLOAD_INIT_PRESIGNED_PARTS: '0',
    });
    expect(config).toEqual({
      maxBytes: { image: 50 * MiB, video: 20 * GiB },
      partBytes: 64 * MiB,
      presignTtlSeconds: 900,
      partConcurrency: 6,
      sessionTtlSeconds: 7200,
      initPresignedParts: 0,
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
    // The bucket aborts incomplete multipart uploads after 2 days; sessions must end before.
    ['UPLOAD_SESSION_TTL_SECONDS', String(36 * 3600 + 1)],
    ['UPLOAD_SESSION_TTL_SECONDS', '600'],
    ['UPLOAD_INIT_PRESIGNED_PARTS', '101'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => loadUploadConfig({ [key]: value })).toThrow(new RegExp(`at ${key}\\b`));
  });

  it('rejects part URLs that outlive the upload session', () => {
    expect(() =>
      loadUploadConfig({ UPLOAD_PRESIGN_TTL_SECONDS: '7200', UPLOAD_SESSION_TTL_SECONDS: '3600' }),
    ).toThrow(
      /UPLOAD_PRESIGN_TTL_SECONDS must be less than or equal to UPLOAD_SESSION_TTL_SECONDS/,
    );
  });
});

describe('loadDriveConfig', () => {
  it('uses the defaults', () => {
    expect(loadDriveConfig({})).toEqual({
      pageSize: 100,
      maxFolderDepth: 32,
      recentPageSize: 50,
      search: { pageSize: 50, maxResults: 1000 },
      copyRate: { limit: 120, windowSeconds: 60 },
      zipMaxActiveJobs: 3,
    });
    expect(
      loadDriveConfig({
        DRIVE_RECENT_PAGE_SIZE: '20',
        DRIVE_SEARCH_PAGE_SIZE: '25',
        DRIVE_SEARCH_MAX_RESULTS: '200',
        DRIVE_COPY_RATE_PER_USER: '10',
        DRIVE_COPY_RATE_WINDOW_SECONDS: '30',
        DRIVE_ZIP_MAX_ACTIVE_JOBS: '1',
      }),
    ).toMatchObject({
      recentPageSize: 20,
      search: { pageSize: 25, maxResults: 200 },
      copyRate: { limit: 10, windowSeconds: 30 },
      zipMaxActiveJobs: 1,
    });
    for (const [key, value] of [
      ['DRIVE_RECENT_PAGE_SIZE', '501'],
      ['DRIVE_SEARCH_MAX_RESULTS', '0'],
      ['DRIVE_ZIP_MAX_ACTIVE_JOBS', '101'],
    ] as const) {
      expect(() => loadDriveConfig({ [key]: value }), key).toThrow(new RegExp(key));
    }
  });

  it('reads overrides', () => {
    expect(loadDriveConfig({ DRIVE_PAGE_SIZE: '50', DRIVE_MAX_FOLDER_DEPTH: '10' })).toMatchObject({
      pageSize: 50,
      maxFolderDepth: 10,
    });
  });

  it.each([
    ['DRIVE_PAGE_SIZE', '0'],
    ['DRIVE_PAGE_SIZE', String(DRIVE_PAGE_SIZE_LIMIT + 1)],
    ['DRIVE_MAX_FOLDER_DEPTH', '0'],
    ['DRIVE_MAX_FOLDER_DEPTH', '101'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => loadDriveConfig({ [key]: value })).toThrow(new RegExp(`at ${key}\\b`));
  });
});

describe('loadMediaConfig', () => {
  it('uses the spec sizes', () => {
    expect(loadMediaConfig({})).toEqual({
      thumb: { longEdge: 400, webpQuality: 80 },
      preview: { longEdge: 2048, webpQuality: 80 },
      web: { longEdge: 2560, jpegQuality: 85, minJpegQuality: 70, maxBytes: 1_500_000 },
      poster: { jpegQuality: 85 },
      videoPreview: { height: 720, crf: 23 },
    });
  });

  it('rejects a thumbnail larger than the preview', () => {
    expect(() => loadMediaConfig({ MEDIA_THUMB_LONG_EDGE: '3000' })).toThrow(
      /MEDIA_THUMB_LONG_EDGE must be less than or equal to MEDIA_PREVIEW_LONG_EDGE/,
    );
  });

  it('caps web.jpg at 1.5 MB by default; 0 turns the cap off (ADR 0028)', () => {
    expect(loadShareDownloadCapConfig({})).toEqual({ imageMaxBytes: 1_500_000 });
    expect(loadShareDownloadCapConfig({ MEDIA_WEB_MAX_BYTES: '0' })).toEqual({ imageMaxBytes: 0 });
    expect(loadMediaConfig({ MEDIA_WEB_MAX_BYTES: '2000000' }).web.maxBytes).toBe(2_000_000);
    expect(() =>
      loadMediaConfig({ MEDIA_WEB_MIN_JPEG_QUALITY: '90', MEDIA_WEB_JPEG_QUALITY: '80' }),
    ).toThrow(/MEDIA_WEB_MIN_JPEG_QUALITY must be less than or equal to MEDIA_WEB_JPEG_QUALITY/);
  });

  it.each([
    ['MEDIA_WEB_JPEG_QUALITY', '101'],
    ['MEDIA_WEB_MAX_BYTES', '-1'],
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
      signedUrlExpiryBucketSeconds: 300,
      pageSize: 100,
      changesCacheSeconds: 5,
      faceOnlyGrantTtlSeconds: 86_400,
      unlockTtlSeconds: 86_400,
      anonIdMaxAgeDays: 365,
      viewerSessionTtlSeconds: 43_200,
      zip: { maxFiles: 500, maxBytes: 2 * GiB, resultTtlSeconds: 86_400 },
      rateLimits: {
        unlockPerIp: { limit: 10, windowSeconds: 900 },
        downloadPerViewer: { limit: 300, windowSeconds: 600 },
        zipCreatePerViewer: { limit: 10, windowSeconds: 3600 },
        printOrderPerViewer: { limit: 30, windowSeconds: 600 },
        feedbackPerViewer: { limit: 100, windowSeconds: 600 },
        slugResolvePerIp: { limit: 300, windowSeconds: 300 },
        notFoundPerIp: { limit: 30, windowSeconds: 600 },
      },
    });
  });

  it('reads the slug resolution and 404 limits per IP (ADR 0011 risk 3)', () => {
    const config = loadShareConfig({
      SHARE_SLUG_RESOLVE_RATE_PER_IP: '50',
      SHARE_SLUG_RESOLVE_RATE_PER_IP_WINDOW_SECONDS: '60',
      SHARE_NOT_FOUND_RATE_PER_IP: '5',
      SHARE_NOT_FOUND_RATE_PER_IP_WINDOW_SECONDS: '3600',
    });
    expect(config.rateLimits.slugResolvePerIp).toEqual({ limit: 50, windowSeconds: 60 });
    expect(config.rateLimits.notFoundPerIp).toEqual({ limit: 5, windowSeconds: 3600 });
    expect(() => loadShareConfig({ SHARE_NOT_FOUND_RATE_PER_IP: '0' })).toThrow();
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
    expect(config.zip).toEqual({ maxFiles: 1000, maxBytes: 8 * GiB, resultTtlSeconds: 86_400 });
  });

  it('reads the expiry bucket, viewer session, zip result TTL and rate limits', () => {
    const config = loadShareConfig({
      SIGNED_URL_EXPIRY_BUCKET_SECONDS: '60',
      VIEWER_SESSION_TTL_SECONDS: '3600',
      ZIP_RESULT_TTL_SECONDS: '7200',
      SHARE_UNLOCK_RATE_PER_IP: '5',
      SHARE_UNLOCK_RATE_PER_IP_WINDOW_SECONDS: '60',
      ZIP_CREATE_RATE_PER_VIEWER: '3',
    });
    expect(config.signedUrlExpiryBucketSeconds).toBe(60);
    expect(config.viewerSessionTtlSeconds).toBe(3600);
    expect(config.zip.resultTtlSeconds).toBe(7200);
    expect(config.rateLimits.unlockPerIp).toEqual({ limit: 5, windowSeconds: 60 });
    expect(config.rateLimits.zipCreatePerViewer.limit).toBe(3);
  });

  it('rejects an expiry bucket longer than the download TTL', () => {
    expect(() => loadShareConfig({ SIGNED_URL_EXPIRY_BUCKET_SECONDS: '900' })).toThrow(
      /SIGNED_URL_EXPIRY_BUCKET_SECONDS must be less than or equal to SIGNED_URL_DOWNLOAD_TTL_SECONDS/,
    );
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
    ['SIGNED_URL_EXPIRY_BUCKET_SECONDS', '0'],
    ['ZIP_RESULT_TTL_SECONDS', '259201'],
    ['VIEWER_SESSION_TTL_SECONDS', '60'],
    ['SHARE_UNLOCK_RATE_PER_IP', '0'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => loadShareConfig({ [key]: value })).toThrow(new RegExp(`at ${key}\\b`));
  });
});

describe('loadRetentionConfig', () => {
  it('uses the spec retention periods', () => {
    expect(loadRetentionConfig({})).toEqual({
      trashRetentionDays: 30,
      faceIndexExpiryDays: 90,
      authSessionRetentionDays: 7,
      subscription: {
        graceDays: 14,
        purgeAfterExpiryDays: 45,
        reminderDays: [14, 7, 1],
        purgeWarningDays: 7,
      },
    });
  });

  it('reads the auth session retention (0 = delete at expiry)', () => {
    expect(loadRetentionConfig({ AUTH_SESSION_RETENTION_DAYS: '0' }).authSessionRetentionDays).toBe(
      0,
    );
    expect(() => loadRetentionConfig({ AUTH_SESSION_RETENTION_DAYS: '366' })).toThrow(
      /AUTH_SESSION_RETENTION_DAYS/,
    );
  });

  it('keeps the purge warning before the purge', () => {
    expect(
      loadRetentionConfig({ SUBSCRIPTION_PURGE_WARNING_DAYS: '29' }).subscription.purgeWarningDays,
    ).toBe(29);
    expect(() =>
      loadRetentionConfig({
        SUBSCRIPTION_PURGE_AFTER_EXPIRY_DAYS: '30',
        SUBSCRIPTION_PURGE_WARNING_DAYS: '30',
      }),
    ).toThrow(/SUBSCRIPTION_PURGE_WARNING_DAYS/);
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
      egressAnomalyMinBytes: 10 * GiB,
      checkoutExpirySeconds: 900,
      minChargeSatang: 2_000,
      prorationDaysPerMonth: 30,
      renewal: { maxAttempts: 3, leadSeconds: 86_400 },
    });
  });

  it('reads overrides', () => {
    expect(
      loadBillingConfig({
        BILLING_PREPAID_MONTHS: '12,1',
        VAT_RATE_BASIS_POINTS: '1000',
        EGRESS_ANOMALY_MULTIPLIER: '12.5',
      }),
    ).toMatchObject({
      prepaidMonths: [1, 12],
      vatRateBasisPoints: 1000,
      egressAnomalyMultiplier: 12.5,
    });
  });

  it.each([
    ['BILLING_PREPAID_MONTHS', '0'],
    ['VAT_RATE_BASIS_POINTS', '7.5'],
    ['EGRESS_ANOMALY_MULTIPLIER', '0'],
    ['BILLING_CHECKOUT_EXPIRY_SECONDS', '60'],
    ['BILLING_PRORATION_DAYS_PER_MONTH', '27'],
    ['BILLING_RENEWAL_MAX_ATTEMPTS', '0'],
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
