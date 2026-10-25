import { describe, expect, expectTypeOf, it } from 'vitest';
import { derivedKey, originalKey } from '../s3-keys';
import {
  createdObjects,
  isS3TestEvent,
  parseQueueMessage,
  QUEUE_MESSAGE_SCHEMAS,
  QUEUE_NAMES,
  QUEUE_URL_ENV,
  QueueMessageError,
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
    expect(SCHEDULED_JOB_TYPES).toEqual([
      'stats.rollup.hourly',
      'subscriptions.transition.daily',
      'trash.purge.daily',
      'faces.expire.daily',
      'quota.reconcile.nightly',
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

  it.each([
    { type: 'index.file' },
    { type: 'index.file', fileId: 'not-a-uuid' },
    { type: 'index.folder', fileId },
    { type: 'delete', fileId },
  ])('rejects %j', (body) => {
    expect(() => parseQueueMessage('faces', JSON.stringify(body))).toThrow(QueueMessageError);
  });
});

describe('zip queue', () => {
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
  const valid: ZipQueueMessage = {
    type: 'zip.create',
    jobId,
    shareId,
    photographerId,
    entries: [web, mov],
  };

  it('round-trips a valid job', () => {
    const body = serializeQueueMessage('zip', valid);
    expect(parseQueueMessage('zip', body)).toEqual(valid);
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
      expect(() =>
        serializeQueueMessage('zip', { ...valid, entries: [{ ...web, key }, mov] }),
      ).toThrow(/at entries\[0\]\.key/);
    }
  });

  it('rejects unsafe or duplicate entry names', () => {
    expect(() =>
      serializeQueueMessage('zip', { ...valid, entries: [{ ...web, name: '../evil.jpg' }] }),
    ).toThrow(/at entries\[0\]\.name/);
    expect(() =>
      serializeQueueMessage('zip', { ...valid, entries: [web, { ...mov, name: 'img_0001.JPG' }] }),
    ).toThrow(/at entries\[1\]\.name/);
  });

  it('requires at least one entry', () => {
    expect(() => serializeQueueMessage('zip', { ...valid, entries: [] })).toThrow(
      QueueMessageError,
    );
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
