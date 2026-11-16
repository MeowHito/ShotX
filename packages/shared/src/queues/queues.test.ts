import { describe, expect, expectTypeOf, it } from 'vitest';
import { derivedKey, originalKey } from '../s3-keys';
import {
  createdObjects,
  createdOriginals,
  isDesignAsset,
  isWebRerender,
  isFileCopy,
  isOriginalCompleted,
  isS3TestEvent,
  mediaOriginals,
  originalCompletedMessage,
  parseQueueMessage,
  queueJobName,
  QUEUE_MESSAGE_SCHEMAS,
  QUEUE_NAMES,
  QUEUE_URL_ENV,
  QUEUE_VISIBILITY_TIMEOUT_ENV,
  QueueMessageError,
  parseZipEntries,
  uniqueZipEntryNames,
  ZipEntriesError,
  zipEntryNameKey,
  SCHEDULED_JOB_TYPES,
  serializeQueueMessage,
  type FacesQueueMessage,
  type ScheduledJobMessage,
  type ZipEntry,
  type ZipQueueMessage,
} from './index';

const photographerId = '0195f3a2-7c1e-7d4a-9b2f-3c4d5e6f7a8b';
const fileId = '0195f3a2-8d2f-7e5b-8c3a-4d5e6f7a8b9c';
const otherFileId = '0195f3a2-8d2f-7e5b-8c3a-4d5e6f7a8b9d';
const jobId = '0195f3a2-9e3a-7f6c-9d4b-5e6f7a8b9cad';
const shareId = '0195f3a2-af4b-7a7d-8e5c-6f7a8b9cadbe';

/** A real-shaped S3 -> SQS ObjectCreated notification (event version 2.1). */
function s3Event(key: string, overrides: Record<string, unknown> = {}) {
  return {
    Records: [
      {
        eventVersion: '2.1',
        eventSource: 'aws:s3',
        awsRegion: 'ap-southeast-1',
        eventTime: '2026-10-25T05:12:31.123Z',
        eventName: 'ObjectCreated:CompleteMultipartUpload',
        userIdentity: { principalId: 'AWS:AROAEXAMPLEID:api-task' },
        requestParameters: { sourceIPAddress: '203.0.113.10' },
        responseElements: {
          'x-amz-request-id': 'C3D13FE58DE4C810',
          'x-amz-id-2': 'FMyUVURIY8/IgAtTv8xRjskZQpcIZ9KG4V5Wp6S7S/JRWeUWerMUE5JgHvANOjpD',
        },
        s3: {
          s3SchemaVersion: '1.0',
          configurationId: 'MediaPipeline',
          bucket: {
            name: 'shotx-prod-media',
            ownerIdentity: { principalId: 'A3NL1KOZZKEXAMPLE' },
            arn: 'arn:aws:s3:::shotx-prod-media',
          },
          object: {
            key,
            size: 18_734_112,
            eTag: '9b2cf535f27731c974343645a3985328-2',
            sequencer: '0066A1B2C3D4E5F601',
          },
        },
        ...overrides,
      },
    ],
  };
}

const testEvent = {
  Service: 'Amazon S3',
  Event: 's3:TestEvent',
  Time: '2026-10-25T05:00:00.000Z',
  Bucket: 'shotx-prod-media',
  RequestId: '5582815E1AEA5ADF',
  HostId: '8cLeGAmw098X5cv4Zkwcmo8vvZa3eH3eKxsPzbB9wrR+YstdA6Knx4Ip8EXAMPLE',
};

describe('queue names', () => {
  it('matches the queues and job types infra creates', () => {
    expect(QUEUE_NAMES).toEqual(['media', 'faces', 'zip', 'jobs']);
    expect(Object.keys(QUEUE_MESSAGE_SCHEMAS)).toEqual([...QUEUE_NAMES]);
    expect(QUEUE_URL_ENV).toEqual({
      media: 'MEDIA_QUEUE_URL',
      faces: 'FACES_QUEUE_URL',
      zip: 'ZIP_QUEUE_URL',
      jobs: 'JOBS_QUEUE_URL',
    });
    expect(QUEUE_VISIBILITY_TIMEOUT_ENV).toEqual({
      media: 'MEDIA_QUEUE_VISIBILITY_TIMEOUT_SECONDS',
      faces: 'FACES_QUEUE_VISIBILITY_TIMEOUT_SECONDS',
      zip: 'ZIP_QUEUE_VISIBILITY_TIMEOUT_SECONDS',
      jobs: 'JOBS_QUEUE_VISIBILITY_TIMEOUT_SECONDS',
    });
    expect(SCHEDULED_JOB_TYPES).toEqual([
      'stats.rollup.hourly',
      'subscriptions.transition.daily',
      'trash.purge.daily',
      'faces.expire.daily',
      'faces.reconcile.daily',
      'quota.reconcile.nightly',
      'media.sweep',
      'faces.sweep',
      'auth.sessions.purge.daily',
    ]);
  });
});

describe('media queue', () => {
  it('parses an ObjectCreated notification and decodes URL-encoded keys', () => {
    // As S3 encodes "originals/{p}/{f}/งานวิ่ง IMG+1 (2).jpg" in the event.
    const encoded =
      `originals/${photographerId}/${fileId}/` +
      '%E0%B8%87%E0%B8%B2%E0%B8%99%E0%B8%A7%E0%B8%B4%E0%B9%88%E0%B8%87+IMG%2B1+%282%29.jpg';
    const message = parseQueueMessage('media', JSON.stringify(s3Event(encoded)));
    expect(isS3TestEvent(message)).toBe(false);
    expect(createdObjects(message)).toEqual([
      {
        bucket: 'shotx-prod-media',
        key: originalKey({ photographerId, fileId, originalName: 'งานวิ่ง IMG+1 (2).jpg' }),
        size: 18_734_112,
        eTag: '9b2cf535f27731c974343645a3985328-2',
        sequencer: '0066A1B2C3D4E5F601',
        eventName: 'ObjectCreated:CompleteMultipartUpload',
        eventTime: '2026-10-25T05:12:31.123Z',
      },
    ]);
  });

  it('accepts the minimal record LocalStack and older S3 versions send', () => {
    const minimal = {
      Records: [
        {
          eventVersion: '2.2',
          eventSource: 'aws:s3',
          awsRegion: 'ap-southeast-1',
          eventTime: '2026-10-25T05:12:31Z',
          eventName: 'ObjectCreated:Put',
          s3: {
            s3SchemaVersion: '1.0',
            bucket: { name: 'shotx-local-media' },
            object: { key: 'originals/p/f/a.jpg', size: 0, unknownField: true },
          },
          glacierEventData: {},
        },
      ],
    };
    const message = parseQueueMessage('media', JSON.stringify(minimal));
    expect(createdObjects(message)[0]).toMatchObject({ key: 'originals/p/f/a.jpg', size: 0 });
  });

  it('parses the s3:TestEvent sent when the notification is configured', () => {
    const message = parseQueueMessage('media', JSON.stringify(testEvent));
    expect(isS3TestEvent(message)).toBe(true);
    expect(createdObjects(message)).toEqual([]);
  });

  it.each([
    [
      'an ObjectRemoved event',
      s3Event('originals/p/f/a.jpg', { eventName: 'ObjectRemoved:Delete' }),
    ],
    ['another event source', s3Event('originals/p/f/a.jpg', { eventSource: 'aws:sqs' })],
    ['malformed key encoding', s3Event('originals/p/f/%E0%B8.jpg')],
    ['a missing size', s3Event('originals/p/f/a.jpg', { s3: { object: { key: 'a' } } })],
    ['no records', { Records: [] }],
    ['an unknown test event', { ...testEvent, Event: 's3:Other' }],
  ])('rejects %s', (_label, body) => {
    expect(() => parseQueueMessage('media', JSON.stringify(body))).toThrow(QueueMessageError);
  });

  it('rejects bodies that are not JSON', () => {
    expect(() => parseQueueMessage('media', 'not json')).toThrow(/Invalid media queue message/);
  });

  it('gives the worker the photographer and file of each created original', () => {
    const key = originalKey({ photographerId, fileId, originalName: 'งานวิ่ง IMG+1 (2).jpg' });
    const encoded = encodeURIComponent(key).replace(/%2F/g, '/').replace(/%20/g, '+');
    const message = parseQueueMessage('media', JSON.stringify(s3Event(encoded)));
    const { originals, ignored } = createdOriginals(message);
    expect(ignored).toEqual([]);
    expect(originals).toEqual([
      expect.objectContaining({
        key,
        size: 18_734_112,
        photographerId,
        fileId,
        originalName: 'งานวิ่ง IMG+1 (2).jpg',
      }),
    ]);
  });

  it('ignores created objects that are not originals built by originalKey', () => {
    const keys = [
      derivedKey({ photographerId, fileId }, 'thumb'),
      'originals/../x/a.jpg',
      `originals/${photographerId}/${fileId}/a/b.jpg`,
      'something/else.jpg',
    ];
    for (const key of keys) {
      const message = parseQueueMessage('media', JSON.stringify(s3Event(encodeURIComponent(key))));
      expect(createdOriginals(message)).toMatchObject({ originals: [], ignored: [{ key }] });
    }
    expect(createdOriginals(parseQueueMessage('media', JSON.stringify(testEvent)))).toEqual({
      originals: [],
      ignored: [],
    });
  });
});

describe('media queue: original.completed', () => {
  const key = originalKey({ photographerId, fileId, originalName: 'งานวิ่ง IMG+1 (2).jpg' });
  const message = { kind: 'original.completed', fileId, photographerId, key } as const;

  it('round-trips and is told apart from S3 events', () => {
    const parsed = parseQueueMessage('media', serializeQueueMessage('media', message));
    expect(parsed).toEqual(message);
    expect(isOriginalCompleted(parsed)).toBe(true);
    expect(isS3TestEvent(parsed)).toBe(false);
    expect(isOriginalCompleted(parseQueueMessage('media', JSON.stringify(testEvent)))).toBe(false);
    expect(isOriginalCompleted(parseQueueMessage('media', JSON.stringify(s3Event('a'))))).toBe(
      false,
    );
    expect(originalCompletedMessage({ fileId, photographerId, key })).toEqual(message);
  });

  it.each([
    ['a derived key', { key: derivedKey({ photographerId, fileId }, 'thumb') }],
    ['another file', { fileId: otherFileId }],
    ['another photographer', { photographerId: otherFileId }],
    ['a hand-written key', { key: `originals/${photographerId}/${fileId}/../a.jpg` }],
    ['a non-uuid id', { fileId: 'f', key: `originals/${photographerId}/f/a.jpg` }],
    ['no key', { key: '' }],
    ['another kind', { kind: 'original.created' }],
  ])('rejects %s', (_label, change) => {
    const body = { ...message, ...change };
    expect(() => serializeQueueMessage('media', body as never)).toThrow(QueueMessageError);
    expect(() => parseQueueMessage('media', JSON.stringify(body))).toThrow(QueueMessageError);
  });

  it('originalCompletedMessage refuses a key of another file', () => {
    expect(() => originalCompletedMessage({ fileId: otherFileId, photographerId, key })).toThrow(
      RangeError,
    );
  });

  it('mediaOriginals gives the same original for both variants', () => {
    const fromApi = mediaOriginals(
      parseQueueMessage('media', JSON.stringify(message)),
      'shotx-prod-media',
    );
    const encoded = encodeURIComponent(key).replace(/%2F/g, '/').replace(/%20/g, '+');
    const fromS3 = mediaOriginals(
      parseQueueMessage('media', JSON.stringify(s3Event(encoded))),
      'shotx-prod-media',
    );
    const expected = { key, photographerId, fileId, originalName: 'งานวิ่ง IMG+1 (2).jpg' };
    expect(fromApi).toEqual({
      originals: [{ source: 'original.completed', ...expected }],
      ignored: [],
    });
    expect(fromS3).toEqual({ originals: [{ source: 's3-event', ...expected }], ignored: [] });
  });

  it('mediaOriginals ignores test events, other buckets and other keys without keys', () => {
    const parse = (body: unknown) => parseQueueMessage('media', JSON.stringify(body));
    expect(mediaOriginals(parse(testEvent), 'shotx-prod-media')).toEqual({
      originals: [],
      ignored: [{ source: 's3-event', reason: 'test-event' }],
    });
    expect(mediaOriginals(parse(s3Event(encodeURIComponent(key))), 'other-bucket')).toEqual({
      originals: [],
      ignored: [{ source: 's3-event', reason: 'other-bucket' }],
    });
    expect(
      mediaOriginals(
        parse(s3Event(derivedKey({ photographerId, fileId }, 'thumb'))),
        'shotx-prod-media',
      ),
    ).toEqual({ originals: [], ignored: [{ source: 's3-event', reason: 'not-an-original' }] });
  });

  it('createdObjects and createdOriginals refuse it instead of dropping it', () => {
    const parsed = parseQueueMessage('media', JSON.stringify(message));
    expect(() => createdObjects(parsed)).toThrow(/use mediaOriginals/);
    expect(() => createdOriginals(parsed)).toThrow(/use mediaOriginals/);
  });
});

describe('faces queue', () => {
  it('parses index.file and index.folder jobs', () => {
    const file = parseQueueMessage('faces', JSON.stringify({ type: 'index.file', fileId }));
    expect(file).toEqual({ type: 'index.file', fileId });
    expectTypeOf(file).toEqualTypeOf<FacesQueueMessage>();
    expect(
      parseQueueMessage('faces', JSON.stringify({ type: 'index.folder', folderId: fileId })),
    ).toEqual({ type: 'index.folder', folderId: fileId });
  });

  it('parses unindex.folder and delete.faces jobs, which carry ids only', () => {
    const unindex = { type: 'unindex.folder', folderId: fileId } as const;
    expect(parseQueueMessage('faces', serializeQueueMessage('faces', unindex))).toEqual(unindex);
    const deletion = { type: 'delete.faces', deletionId: jobId } as const;
    expect(parseQueueMessage('faces', serializeQueueMessage('faces', deletion))).toEqual(deletion);
    expect(
      parseQueueMessage('faces', JSON.stringify({ ...deletion, faceIds: ['x'], bbox: {} })),
    ).toEqual(deletion);
  });

  it.each([
    { type: 'delete.faces' },
    { type: 'unindex.folder', fileId },
    { type: 'index.file' },
    { type: 'index.file', fileId: 'not-a-uuid' },
    { type: 'index.folder', fileId },
    { type: 'delete', fileId },
  ])('rejects %j', (body) => {
    expect(() => parseQueueMessage('faces', JSON.stringify(body))).toThrow(QueueMessageError);
  });
});

describe('zip queue', () => {
  it('carries only the job id', () => {
    const message: ZipQueueMessage = { type: 'zip.create', jobId };
    const body = serializeQueueMessage('zip', message);
    expect(JSON.parse(body)).toEqual({ type: 'zip.create', jobId });
    expect(parseQueueMessage('zip', body)).toEqual(message);
    expectTypeOf<keyof ZipQueueMessage>().toEqualTypeOf<'type' | 'jobId'>();
  });

  it('drops entries and other fields of the old message shape', () => {
    const old = { type: 'zip.create', jobId, shareId, photographerId, entries: [] };
    expect(parseQueueMessage('zip', JSON.stringify(old))).toEqual({ type: 'zip.create', jobId });
  });

  it.each([{ type: 'zip.create' }, { type: 'zip.create', jobId: 'job-1' }, { type: 'zip', jobId }])(
    'rejects %j',
    (body) => {
      expect(() => parseQueueMessage('zip', JSON.stringify(body))).toThrow(QueueMessageError);
    },
  );

  it('stays small with the largest job id', () => {
    expect(serializeQueueMessage('zip', { type: 'zip.create', jobId }).length).toBeLessThan(100);
  });
});

describe('zip entries', () => {
  const web: ZipEntry = {
    fileId,
    key: derivedKey({ photographerId, fileId }, 'web'),
    name: 'IMG_0001.jpg',
    bytes: 1_200_000,
  };
  const mov: ZipEntry = {
    fileId: otherFileId,
    key: originalKey({ photographerId, fileId: otherFileId, originalName: 'clip.mov' }),
    name: 'clip.mov',
    bytes: 3_000_000_000,
  };
  const valid = { photographerId, entries: [web, mov] };

  it('accepts originals and derivatives of the photographer', () => {
    expect(parseZipEntries(valid)).toEqual(valid);
  });

  it("rejects keys of another photographer or another entry's file", () => {
    const foreign = '0195f3a2-0000-7000-8000-000000000000';
    const bad = [
      derivedKey({ photographerId: foreign, fileId }, 'web'),
      derivedKey({ photographerId, fileId: otherFileId }, 'web'),
      'tmp/zips/x.zip',
      '../secrets',
    ];
    for (const key of bad) {
      expect(() => parseZipEntries({ ...valid, entries: [{ ...web, key }, mov] })).toThrow(
        /entries\.0\.key/,
      );
    }
  });

  it('rejects unsafe or duplicate entry names without echoing them', () => {
    expect(() => parseZipEntries({ ...valid, entries: [{ ...web, name: '../evil.jpg' }] })).toThrow(
      /entries\.0\.name/,
    );
    const duplicate = () =>
      parseZipEntries({ ...valid, entries: [web, { ...mov, name: 'img_0001.JPG' }] });
    expect(duplicate).toThrow(ZipEntriesError);
    expect(duplicate).toThrow(/entries\.1\.name: must be unique within the job \(ignoring case\)/);
    expect(duplicate).not.toThrow(/img_0001/i);
  });

  it('requires one to ZIP_MAX_FILES_LIMIT entries', () => {
    expect(() => parseZipEntries({ ...valid, entries: [] })).toThrow(ZipEntriesError);
    const many = Array.from({ length: 10_001 }, (_, i) => ({ ...web, name: `${i}.jpg` }));
    expect(() => parseZipEntries({ ...valid, entries: many })).toThrow(/entries/);
  });

  it('folds names by case', () => {
    expect(zipEntryNameKey('IMG_0001.JPG')).toBe(zipEntryNameKey('img_0001.jpg'));
    expect(zipEntryNameKey('ภาพ.jpg')).toBe('ภาพ.jpg');
  });

  it('numbers names that collide ignoring case', () => {
    expect(
      uniqueZipEntryNames(['a.jpg', 'A.JPG', 'a.jpg', 'b', 'B', 'a (2).jpg', 'งาน.jpg']),
    ).toEqual(['a.jpg', 'A (2).JPG', 'a (3).jpg', 'b', 'B (2)', 'a (2) (2).jpg', 'งาน.jpg']);
  });

  it('keeps numbered names safe and within 255 bytes', () => {
    const long = `${'ก'.repeat(83)}.jpg`;
    const names = uniqueZipEntryNames([long, long, long]);
    expect(new Set(names.map(zipEntryNameKey)).size).toBe(3);
    for (const name of names) {
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
      expect(name.endsWith('.jpg')).toBe(true);
    }
    expect(names[1]).toMatch(/ \(2\)\.jpg$/);
    expect(() =>
      parseZipEntries({
        photographerId,
        entries: names.map((name) => ({ ...web, name })),
      }),
    ).not.toThrow();
  });

  it('refuses unsanitized names', () => {
    expect(() => uniqueZipEntryNames(['a/b.jpg'])).toThrow(/sanitizeOriginalName/);
  });
});

describe('jobs queue', () => {
  it('parses every scheduled job type with the EventBridge Scheduler time format', () => {
    for (const type of SCHEDULED_JOB_TYPES) {
      const message = parseQueueMessage(
        'jobs',
        JSON.stringify({ type, scheduledTime: '2026-10-25T17:00:00Z' }),
      );
      expect(message).toEqual({ type, scheduledTime: '2026-10-25T17:00:00Z' });
      expectTypeOf(message).toEqualTypeOf<ScheduledJobMessage>();
    }
  });

  it.each([
    { type: 'stats.rollup.daily', scheduledTime: '2026-10-25T17:00:00Z' },
    { type: 'trash.purge.daily' },
    { type: 'trash.purge.daily', scheduledTime: 'yesterday' },
  ])('rejects %j', (body) => {
    expect(() => parseQueueMessage('jobs', JSON.stringify(body))).toThrow(QueueMessageError);
  });
});

describe('media queue: web.rerender (ADR 0028)', () => {
  const fileId = '0195f3a2-9e3a-7f6c-9d4b-5e6f7a8b9c0e';
  const message = { kind: 'web.rerender', fileId, photographerId } as const;

  it('round-trips, is told apart from the other variants and has its job name', () => {
    const parsed = parseQueueMessage('media', serializeQueueMessage('media', message));
    expect(parsed).toEqual(message);
    expect(isWebRerender(parsed)).toBe(true);
    expect(isDesignAsset(parsed)).toBe(false);
    expect(isFileCopy(parsed)).toBe(false);
    expect(isOriginalCompleted(parsed)).toBe(false);
    expect(queueJobName('media', parsed)).toBe('media.web-rerender');
    expect(() => mediaOriginals(parsed, 'bucket')).toThrow(RangeError);
    expect(() => createdObjects(parsed)).toThrow(RangeError);
  });
});

describe('media queue: design.asset (ADR 0013)', () => {
  const assetId = '0195f3a2-9e3a-7f6c-9d4b-5e6f7a8b9c0d';
  const message = { kind: 'design.asset', assetId, photographerId } as const;

  it('round-trips, is told apart from the other variants and has its job name', () => {
    const parsed = parseQueueMessage('media', serializeQueueMessage('media', message));
    expect(parsed).toEqual(message);
    expect(isDesignAsset(parsed)).toBe(true);
    expect(isFileCopy(parsed)).toBe(false);
    expect(isOriginalCompleted(parsed)).toBe(false);
    expect(isS3TestEvent(parsed)).toBe(false);
    expect(isDesignAsset(parseQueueMessage('media', JSON.stringify(testEvent)))).toBe(false);
    expect(queueJobName('media', parsed)).toBe('media.design-asset');
  });

  it.each([
    ['a non-uuid asset id', { assetId: 'a/b' }],
    ['no photographer', { photographerId: undefined }],
    ['another kind', { kind: 'design.assets' }],
  ])('rejects %s', (_label, change) => {
    const body = { ...message, ...change };
    expect(() => parseQueueMessage('media', JSON.stringify(body))).toThrow(QueueMessageError);
  });

  it('is never mistaken for an original: the helpers for originals refuse it', () => {
    const parsed = parseQueueMessage('media', JSON.stringify(message));
    expect(() => mediaOriginals(parsed, 'shotx-prod-media')).toThrow(/isDesignAsset/);
    expect(() => createdObjects(parsed)).toThrow(/isDesignAsset/);
    expect(() => createdOriginals(parsed)).toThrow(/isDesignAsset/);
  });
});
