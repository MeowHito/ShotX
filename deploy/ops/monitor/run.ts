import { loadDatabaseConfig, pgPoolConfig } from '@shotx/db';
import { type Env, loadFaceConfig, loadRedisConfig, loadWorkerSettings } from '@shotx/shared';
import { Redis } from 'ioredis';
import pg from 'pg';
import { readBackupStatus } from '../backup';
import { loadMonitorConfig, type MonitorConfig } from '../config';
import { AlertTracker, type Notification, webhookPayload } from './alerts';
import { evaluate, type Snapshot, type Thresholds } from './checks';
import { dbStats, type DbThresholds, hostStats, queueStats, redisMemory } from './collect';

// The `monitor` compose service: one round every MONITOR_INTERVAL_SECONDS, alerts to
// ALERT_WEBHOOK_URL, and an optional heartbeat GET (MONITOR_HEARTBEAT_URL) after each round so an
// external service notices when the monitor itself (or the whole VPS) is down.

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? 'error';

async function attempt<T>(errors: Record<string, string>, name: string, run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    errors[name] = errorText(error);
    return undefined;
  }
}

export interface MonitorDeps {
  config: MonitorConfig;
  thresholds: Thresholds;
  db: DbThresholds;
  redis: Redis;
  pool: pg.Pool;
}

export function createMonitorDeps(env: Env): MonitorDeps {
  const config = loadMonitorConfig(env);
  const face = loadFaceConfig(env);
  const worker = loadWorkerSettings(env);
  const redisConfig = loadRedisConfig(env);
  const redis = new Redis(redisConfig.url, {
    ...(redisConfig.credentials ?? {}),
    connectionName: 'shotx-monitor',
    enableReadyCheck: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  // The monitor role reads a few columns only; one connection is plenty.
  const pool = new pg.Pool({ ...pgPoolConfig(loadDatabaseConfig(env)), max: 1 });
  return {
    config,
    thresholds: { faceDeletionAlert: face.deletion.alert },
    db: {
      media: worker.sweeps.media,
      faceDeletionMaxAgeSeconds: config.faceDeletionMaxAgeSeconds,
      faceDeletionAlert: face.deletion.alert,
      maxIds: config.maxIds,
    },
    redis,
    pool,
  };
}

export async function collect(deps: MonitorDeps, now: Date): Promise<Snapshot> {
  const errors: Record<string, string> = {};
  const { config } = deps;
  const queues = await attempt(errors, 'queues', () => queueStats(deps.redis, config.stage, now));
  const redis = await attempt(errors, 'redis', () => redisMemory(deps.redis));
  const db = await attempt(errors, 'database', () => dbStats(deps.pool, deps.db));
  const backup = await attempt(errors, 'backup', () => readBackupStatus(config.stateDir));
  const host = await attempt(errors, 'host', () => hostStats(config.diskPaths));
  return {
    errors,
    ...(queues === undefined ? {} : { queues }),
    ...(redis === undefined ? {} : { redis }),
    ...(db === undefined ? {} : { db }),
    ...(backup === undefined ? {} : { backup }),
    ...(host === undefined ? {} : { host }),
  };
}

async function send(url: string | null, body: unknown, log: (line: string) => void) {
  if (url === null) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel();
    if (!res.ok) log(`alert webhook answered HTTP ${res.status}`);
  } catch (error) {
    // Never log the URL: it usually embeds a token.
    log(`alert webhook failed: ${errorText(error)}`);
  }
}

async function heartbeat(url: string | null, log: (line: string) => void) {
  if (url === null) return;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel();
  } catch (error) {
    log(`heartbeat failed: ${errorText(error)}`);
  }
}

/** One round: collect, evaluate, notify. Returns the notifications sent. */
export async function monitorRound(
  deps: MonitorDeps,
  tracker: AlertTracker,
  log: (line: string) => void,
  now = new Date(),
): Promise<Notification[]> {
  const snapshot = await collect(deps, now);
  const findings = evaluate(deps.config, deps.thresholds, snapshot, now);
  const notifications = tracker.update(findings, now);
  for (const n of notifications) {
    log(
      JSON.stringify({
        event: 'monitor.alert',
        status: n.status,
        id: n.finding.id,
        summary: n.finding.summary,
      }),
    );
  }
  if (notifications.length > 0) {
    await send(deps.config.webhookUrl, webhookPayload(deps.config.stage, notifications), log);
  }
  await heartbeat(deps.config.heartbeatUrl, log);
  return notifications;
}

export async function runMonitor(
  env: Env,
  once: boolean,
  log: (line: string) => void,
): Promise<number> {
  const deps = createMonitorDeps(env);
  const tracker = new AlertTracker(deps.config.repeatSeconds);
  if (deps.config.webhookUrl === null) log('ALERT_WEBHOOK_URL is not set: alerts are only logged');
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    do {
      const sent = await monitorRound(deps, tracker, log);
      if (once) return sent.some((n) => n.status === 'firing') ? 1 : 0;
      const until = Date.now() + deps.config.intervalSeconds * 1000;
      while (!stopping && Date.now() < until) await new Promise((r) => setTimeout(r, 1000));
    } while (!stopping);
    return 0;
  } finally {
    deps.redis.disconnect();
    await deps.pool.end();
  }
}
