import { FACE_DELETION_ALERT_EVENT, faceDeletionAlertDue, type QueueName } from '@shotx/shared';
import type { BackupStatus } from '../backup';
import type { MonitorConfig } from '../config';

// Pure evaluation of one monitoring round (ADR 0008 section 7). Inputs are counts, ages and row
// ids only; findings carry nothing else (no names, emails, file names, faces or IP addresses).

export type Severity = 'warning' | 'critical';

export interface Finding {
  /** Stable id, e.g. `queue.media.failed`; one alert per id. */
  id: string;
  severity: Severity;
  summary: string;
  /** Numbers and row ids only. */
  details?: Record<string, number | string | string[]>;
}

export interface QueueStats {
  queue: QueueName;
  failed: number;
  waiting: number;
  /** Age of the oldest waiting job; null when none waits. */
  oldestWaitingSeconds: number | null;
}

export interface RedisMemory {
  usedBytes: number;
  /** 0 means unbounded (a misconfiguration under noeviction). */
  maxBytes: number;
}

export interface IdsCount {
  count: number;
  ids: string[];
}

export interface DbStats {
  /** `processing` files the media sweep has given up on (past MEDIA_SWEEP_MAX_REQUEUES). */
  stuckProcessing: IdsCount;
  /** Face deletions open longer than the limit. */
  openFaceDeletions: IdsCount & { oldestSeconds: number | null };
  /** Shares whose face deletions in the alert window reach FACE_DELETION_ALERT_PER_SHARE. */
  faceDeletionsPerShare: { shareId: string; count: number }[];
}

export interface HostStats {
  memTotalBytes: number;
  memAvailableBytes: number;
  swapTotalBytes: number;
  load5: number;
  cpus: number;
  disks: { path: string; totalBytes: number; availableBytes: number }[];
}

/** One round's data. A section is absent when its collection failed (see `errors`). */
export interface Snapshot {
  queues?: QueueStats[];
  redis?: RedisMemory;
  db?: DbStats;
  backup?: BackupStatus | null;
  host?: HostStats;
  /** Collection failures, by check name (the message has no secrets). */
  errors: Record<string, string>;
}

export interface Thresholds {
  faceDeletionAlert: { perShare: number; windowSeconds: number };
}

const pct = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
const ids = (list: string[], max: number) => list.slice(0, max);

export function evaluate(
  config: MonitorConfig,
  thresholds: Thresholds,
  snapshot: Snapshot,
  now: Date,
): Finding[] {
  const out: Finding[] = [];

  for (const [check, message] of Object.entries(snapshot.errors)) {
    out.push({
      id: `monitor.${check}`,
      severity: 'critical',
      summary: `monitor could not check ${check}: ${message.slice(0, 200)}`,
    });
  }

  for (const q of snapshot.queues ?? []) {
    if (q.failed > config.queueFailedMax) {
      out.push({
        id: `queue.${q.queue}.failed`,
        severity: 'critical',
        summary: `${q.failed} failed job(s) kept in the ${q.queue} queue`,
        details: { failed: q.failed, threshold: config.queueFailedMax },
      });
    }
    const maxWait = config.queueMaxWaitSeconds[q.queue];
    if (q.oldestWaitingSeconds !== null && q.oldestWaitingSeconds > maxWait) {
      out.push({
        id: `queue.${q.queue}.age`,
        severity: 'critical',
        summary: `oldest waiting ${q.queue} job is ${Math.round(q.oldestWaitingSeconds)}s old`,
        details: {
          waiting: q.waiting,
          oldestSeconds: Math.round(q.oldestWaitingSeconds),
          threshold: maxWait,
        },
      });
    }
  }

  if (snapshot.redis !== undefined) {
    const { usedBytes, maxBytes } = snapshot.redis;
    if (maxBytes === 0) {
      out.push({
        id: 'redis.maxmemory',
        severity: 'critical',
        summary: 'Redis maxmemory is 0 (unbounded): set --maxmemory (ADR 0008 section 3)',
      });
    } else if (pct(usedBytes, maxBytes) >= config.redisMemoryPercent) {
      out.push({
        id: 'redis.memory',
        severity: 'critical',
        summary: `Redis uses ${pct(usedBytes, maxBytes)}% of maxmemory (noeviction: writes fail when full)`,
        details: { usedBytes, maxBytes, thresholdPercent: config.redisMemoryPercent },
      });
    }
  }

  if (snapshot.db !== undefined) {
    const { stuckProcessing, openFaceDeletions, faceDeletionsPerShare } = snapshot.db;
    if (stuckProcessing.count > 0) {
      out.push({
        id: 'files.processing_stuck',
        severity: 'warning',
        summary: `${stuckProcessing.count} file(s) stuck in processing after the media sweep's last re-send`,
        details: { count: stuckProcessing.count, fileIds: ids(stuckProcessing.ids, config.maxIds) },
      });
    }
    if (openFaceDeletions.count > 0) {
      out.push({
        id: 'faces.deletion_open',
        severity: 'critical',
        summary: `${openFaceDeletions.count} face deletion request(s) open for more than ${config.faceDeletionMaxAgeSeconds}s (PDPA)`,
        details: {
          count: openFaceDeletions.count,
          oldestSeconds: Math.round(openFaceDeletions.oldestSeconds ?? 0),
          deletionIds: ids(openFaceDeletions.ids, config.maxIds),
        },
      });
    }
    const bursts = faceDeletionsPerShare.filter((s) =>
      faceDeletionAlertDue(s.count, thresholds.faceDeletionAlert),
    );
    if (bursts.length > 0) {
      out.push({
        id: 'faces.deletion_burst',
        severity: 'warning',
        summary: `${FACE_DELETION_ALERT_EVENT}: ${bursts.length} share(s) with at least ${thresholds.faceDeletionAlert.perShare} face deletions in ${thresholds.faceDeletionAlert.windowSeconds}s (ADR 0007)`,
        details: {
          shares: bursts.length,
          shareIds: ids(
            bursts.map((b) => b.shareId),
            config.maxIds,
          ),
          maxCount: Math.max(...bursts.map((b) => b.count)),
        },
      });
    }
  }

  if (snapshot.backup !== undefined) {
    const last = snapshot.backup?.lastSuccessAt;
    const age = last === undefined ? null : (now.getTime() - Date.parse(last)) / 1000;
    if (age === null || !Number.isFinite(age) || age > config.backupMaxAgeSeconds) {
      out.push({
        id: 'backup.age',
        severity: 'critical',
        summary:
          age === null || !Number.isFinite(age)
            ? 'no successful database backup recorded'
            : `last successful database backup is ${Math.round(age / 3600)}h old`,
        details: {
          thresholdSeconds: config.backupMaxAgeSeconds,
          ...(snapshot.backup?.lastFailureAt === undefined
            ? {}
            : { lastFailureAt: snapshot.backup.lastFailureAt }),
        },
      });
    }
  }

  if (snapshot.host !== undefined) {
    const h = snapshot.host;
    const usedMem = pct(h.memTotalBytes - h.memAvailableBytes, h.memTotalBytes);
    if (usedMem >= config.memoryPercent) {
      out.push({
        id: 'host.memory',
        severity: 'critical',
        summary: `host memory ${usedMem}% used`,
        details: { totalBytes: h.memTotalBytes, availableBytes: h.memAvailableBytes },
      });
    }
    if (!config.allowSwap && h.swapTotalBytes > 0) {
      out.push({
        id: 'host.swap',
        severity: 'warning',
        summary: 'swap is on: selfie buffers could be paged to disk (ADR 0008 section 6)',
        details: { swapTotalBytes: h.swapTotalBytes },
      });
    }
    const loadPerCpu = h.cpus > 0 ? h.load5 / h.cpus : h.load5;
    if (loadPerCpu > config.loadPerCpu) {
      out.push({
        id: 'host.load',
        severity: 'warning',
        summary: `5-minute load ${h.load5.toFixed(2)} on ${h.cpus} CPU(s)`,
        details: { load5: h.load5, cpus: h.cpus, thresholdPerCpu: config.loadPerCpu },
      });
    }
    for (const d of h.disks) {
      const used = pct(d.totalBytes - d.availableBytes, d.totalBytes);
      if (used >= config.diskPercent) {
        out.push({
          id: `host.disk.${d.path}`,
          severity: 'critical',
          summary: `disk ${d.path} ${used}% used`,
          details: { totalBytes: d.totalBytes, availableBytes: d.availableBytes },
        });
      }
    }
  }
  return out;
}
