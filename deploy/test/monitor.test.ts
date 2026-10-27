import { describe, expect, it } from 'vitest';
import { loadMonitorConfig } from '../ops/config';
import { AlertTracker, webhookPayload } from '../ops/monitor/alerts';
import { evaluate, type Finding, type Snapshot } from '../ops/monitor/checks';
import {
  dbStats,
  parseInfoMemory,
  parseLoadavg,
  parseMeminfo,
  queueStats,
} from '../ops/monitor/collect';

const config = loadMonitorConfig({ APP_STAGE: 'prod' });
const thresholds = { faceDeletionAlert: { perShare: 20, windowSeconds: 86_400 } };
const now = new Date('2026-11-02T12:00:00Z');
const GiB = 1024 ** 3;

const healthy: Snapshot = {
  errors: {},
  queues: [
    { queue: 'media', failed: 0, waiting: 3, oldestWaitingSeconds: 12 },
    { queue: 'faces', failed: 0, waiting: 0, oldestWaitingSeconds: null },
  ],
  redis: { usedBytes: 100 * 1024 ** 2, maxBytes: 512 * 1024 ** 2 },
  db: {
    stuckProcessing: { count: 0, ids: [] },
    openFaceDeletions: { count: 0, ids: [], oldestSeconds: null },
    faceDeletionsPerShare: [{ shareId: 's1', count: 3 }],
  },
  backup: { lastSuccessAt: '2026-11-01T19:05:00Z' },
  host: {
    memTotalBytes: 8 * GiB,
    memAvailableBytes: 4 * GiB,
    swapTotalBytes: 0,
    load5: 1.5,
    cpus: 4,
    disks: [{ path: '/var/lib/shotx-ops', totalBytes: 100 * GiB, availableBytes: 60 * GiB }],
  },
};
const ids = (f: Finding[]) => f.map((x) => x.id).sort();

describe('evaluate', () => {
  it('finds nothing on a healthy box', () => {
    expect(evaluate(config, thresholds, healthy, now)).toEqual([]);
  });

  it('flags failed jobs and old waiting jobs per queue', () => {
    const f = evaluate(
      config,
      thresholds,
      {
        ...healthy,
        queues: [
          { queue: 'media', failed: 2, waiting: 1, oldestWaitingSeconds: 10 },
          { queue: 'zip', failed: 0, waiting: 9, oldestWaitingSeconds: 4000 },
        ],
      },
      now,
    );
    expect(ids(f)).toEqual(['queue.media.failed', 'queue.zip.age']);
  });

  it('flags Redis near maxmemory, and an unbounded Redis', () => {
    const near = { usedBytes: 400, maxBytes: 500 };
    expect(ids(evaluate(config, thresholds, { ...healthy, redis: near }, now))).toEqual([
      'redis.memory',
    ]);
    const unbounded = { usedBytes: 1, maxBytes: 0 };
    expect(ids(evaluate(config, thresholds, { ...healthy, redis: unbounded }, now))).toEqual([
      'redis.maxmemory',
    ]);
  });

  it('flags stuck files, open face deletions and deletion bursts with ids only', () => {
    const f = evaluate(
      config,
      thresholds,
      {
        ...healthy,
        db: {
          stuckProcessing: { count: 30, ids: Array.from({ length: 30 }, (_, i) => `f${i}`) },
          openFaceDeletions: { count: 1, ids: ['d1'], oldestSeconds: 200_000 },
          faceDeletionsPerShare: [{ shareId: 's9', count: 25 }],
        },
      },
      now,
    );
    expect(ids(f)).toEqual([
      'faces.deletion_burst',
      'faces.deletion_open',
      'files.processing_stuck',
    ]);
    const stuck = f.find((x) => x.id === 'files.processing_stuck');
    expect((stuck?.details?.fileIds as string[]).length).toBe(config.maxIds);
    expect(f.find((x) => x.id === 'faces.deletion_burst')?.summary).toContain(
      'face_deletion.alert',
    );
  });

  it('flags a stale or missing backup', () => {
    const stale = { lastSuccessAt: '2026-10-30T19:00:00Z' };
    expect(ids(evaluate(config, thresholds, { ...healthy, backup: stale }, now))).toEqual([
      'backup.age',
    ]);
    expect(ids(evaluate(config, thresholds, { ...healthy, backup: null }, now))).toEqual([
      'backup.age',
    ]);
  });

  it('flags host memory, swap, load and disk', () => {
    const f = evaluate(
      config,
      thresholds,
      {
        ...healthy,
        host: {
          memTotalBytes: 8 * GiB,
          memAvailableBytes: 0.2 * GiB,
          swapTotalBytes: GiB,
          load5: 12,
          cpus: 4,
          disks: [{ path: '/data', totalBytes: 100 * GiB, availableBytes: 5 * GiB }],
        },
      },
      now,
    );
    expect(ids(f)).toEqual(['host.disk./data', 'host.load', 'host.memory', 'host.swap']);
  });

  it('reports a check it could not run', () => {
    const f = evaluate(config, thresholds, { errors: { database: 'connect ECONNREFUSED' } }, now);
    expect(ids(f)).toEqual(['monitor.database']);
  });
});

describe('alert tracker', () => {
  const finding: Finding = { id: 'queue.media.failed', severity: 'critical', summary: '2 failed' };

  it('fires once, repeats after the interval, and resolves', () => {
    const t = new AlertTracker(3600);
    const at = (s: number) => new Date(now.getTime() + s * 1000);
    expect(t.update([finding], at(0)).map((n) => n.status)).toEqual(['firing']);
    // Live numbers change; that alone doesn't re-fire.
    expect(t.update([{ ...finding, summary: '3 failed' }], at(60))).toEqual([]);
    expect(t.update([finding], at(3600)).map((n) => n.status)).toEqual(['firing']);
    expect(t.update([], at(3700)).map((n) => n.status)).toEqual(['resolved']);
    expect(t.update([], at(3800))).toEqual([]);
  });

  it('re-fires at once when the severity changes', () => {
    const t = new AlertTracker(0);
    t.update([finding], now);
    expect(t.update([{ ...finding, severity: 'warning' }], now)).toHaveLength(1);
  });
});

describe('webhook payload', () => {
  it('carries a chat text and the structured alerts, nothing else', () => {
    const body = webhookPayload('prod', [
      {
        status: 'firing',
        finding: { id: 'x', severity: 'critical', summary: 's', details: { n: 1 } },
      },
    ]);
    expect(body).toEqual({
      source: 'shotx-monitor',
      stage: 'prod',
      text: 'shotx prod:\nCRITICAL [x] s',
      content: 'shotx prod:\nCRITICAL [x] s',
      alerts: [
        { status: 'firing', id: 'x', severity: 'critical', summary: 's', details: { n: 1 } },
      ],
    });
  });
});

describe('collection', () => {
  it('parses INFO memory, /proc/meminfo and /proc/loadavg', () => {
    expect(parseInfoMemory('# Memory\r\nused_memory:1024\r\nmaxmemory:536870912\r\n')).toEqual({
      usedBytes: 1024,
      maxBytes: 536_870_912,
    });
    expect(
      parseMeminfo(
        'MemTotal:       8000 kB\nMemFree: 1 kB\nMemAvailable:   4000 kB\nSwapTotal:      0 kB\n',
      ),
    ).toEqual({ memTotalBytes: 8000 * 1024, memAvailableBytes: 4000 * 1024, swapTotalBytes: 0 });
    expect(parseLoadavg('0.50 1.25 2.00 1/300 12345\n')).toBe(1.25);
  });

  it('reads BullMQ queue sizes and the oldest waiting job with read-only commands', async () => {
    const prefix = 'shotx:prod:bull';
    const lists: Record<string, string[]> = {
      // LPUSH order: newest first, oldest last; a BullMQ 5 marker may sit at the tail.
      [`${prefix}:media:wait`]: ['j3', 'j2', 'j1', '0:0'],
    };
    const hashes: Record<string, Record<string, string>> = {
      [`${prefix}:media:j1`]: { timestamp: String(now.getTime() - 90_000) },
    };
    const calls: string[] = [];
    const redis = {
      zcard: (k: string) => (
        calls.push(`zcard ${k}`),
        Promise.resolve(k.endsWith('zip:failed') ? 4 : 0)
      ),
      llen: (k: string) => (calls.push('llen'), Promise.resolve(lists[k]?.length ?? 0)),
      lindex: (k: string, i: number) => {
        calls.push('lindex');
        const l = lists[k] ?? [];
        return Promise.resolve(l.at(i) ?? null);
      },
      hget: (k: string, f: string) => (calls.push('hget'), Promise.resolve(hashes[k]?.[f] ?? null)),
    };
    const stats = await queueStats(redis as never, 'prod', now);
    expect(stats.find((s) => s.queue === 'media')).toEqual({
      queue: 'media',
      failed: 0,
      waiting: 3,
      oldestWaitingSeconds: 90,
    });
    expect(stats.find((s) => s.queue === 'zip')?.failed).toBe(4);
    expect(new Set(calls.map((c) => c.split(' ')[0]))).toEqual(
      new Set(['zcard', 'llen', 'lindex', 'hget']),
    );
  });

  it('reads counts and ids from the database', async () => {
    const results = [
      { rows: [{ id: 'f1', total: '7' }] },
      { rows: [{ id: 'd1', total: '1', oldest: 99_000 }] },
      { rows: [{ share_id: 's1', n: 21 }] },
    ];
    const pool = { query: () => Promise.resolve(results.shift()) };
    const stats = await dbStats(pool as never, {
      media: { processingAgeSeconds: 21_600, maxRequeues: 3 },
      faceDeletionMaxAgeSeconds: 86_400,
      faceDeletionAlert: { perShare: 20, windowSeconds: 86_400 },
      maxIds: 20,
    });
    expect(stats).toEqual({
      stuckProcessing: { count: 7, ids: ['f1'] },
      openFaceDeletions: { count: 1, ids: ['d1'], oldestSeconds: 99_000 },
      faceDeletionsPerShare: [{ shareId: 's1', count: 21 }],
    });
  });
});
