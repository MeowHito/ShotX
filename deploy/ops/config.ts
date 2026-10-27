import {
  type Env,
  LOCAL_DEV_APP_STAGE,
  parseEnv,
  QUEUE_NAMES,
  type QueueName,
} from '@shotx/shared';
import { z } from 'zod';

// Settings of the VPS ops tools (monitor, backup). They are deploy-local: no app reads them, so
// they live here and in deploy/env/*.env.example, not in packages/shared.

const stage = z.string().regex(/^[a-z][a-z0-9-]{1,15}$/, { error: 'must be a stage name' });
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const bool = () => z.stringbool();
const percent = () => z.coerce.number().gt(0).lt(100);

/** Where backup writes its status file and monitor reads it (the `ops-state` volume). */
export const DEFAULT_OPS_STATE_DIR = '/var/lib/shotx-ops';

/** https, or http on APP_STAGE=local (a local webhook catcher). */
function webhookUrl(env: Env, value: string | undefined, name: string): string | null {
  if (value === undefined || value === '') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid monitor configuration: ${name} is not a URL`);
  }
  const local = env.APP_STAGE === LOCAL_DEV_APP_STAGE;
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error(`Invalid monitor configuration: ${name} must be https`);
  }
  return url.toString();
}

const monitorEnvSchema = z.object({
  APP_STAGE: stage,
  /** Seconds between check rounds. */
  MONITOR_INTERVAL_SECONDS: int(10, 3600).default(60),
  /** A firing alert is sent again after this long (0: only on change). */
  MONITOR_REPEAT_SECONDS: int(0, 7 * 86_400).default(3600),
  /** Alert when a queue keeps more failed jobs than this (BullMQ's dead-letter set). */
  MONITOR_QUEUE_FAILED_MAX: int(0, 1_000_000).default(0),
  /** Alert when the oldest waiting job of a queue is older than this. */
  MONITOR_QUEUE_MAX_WAIT_SECONDS: int(10, 86_400).default(1800),
  MONITOR_REDIS_MEMORY_PERCENT: percent().default(75),
  /** ADR 0007: a face deletion must not stay open for more than a day. */
  MONITOR_FACE_DELETION_MAX_AGE_SECONDS: int(60, 7 * 86_400).default(86_400),
  /** Daily backups: alert when the last good one is older than a day plus slack. */
  MONITOR_BACKUP_MAX_AGE_SECONDS: int(3600, 30 * 86_400).default(93_600),
  /** Filesystems to watch, comma-separated mount points (the ops-state volume by default). */
  MONITOR_DISK_PATHS: z.string().default(DEFAULT_OPS_STATE_DIR),
  MONITOR_DISK_PERCENT: percent().default(80),
  MONITOR_MEMORY_PERCENT: percent().default(90),
  /** 5-minute load average per CPU. */
  MONITOR_LOAD_PER_CPU: z.coerce.number().gt(0).max(100).default(2),
  /** ADR 0008 section 6: swap off (or on the encrypted volume). false: alert while swap is on. */
  MONITOR_ALLOW_SWAP: bool().default(false),
  /** Most row ids listed in one alert. */
  MONITOR_MAX_IDS: int(0, 100).default(20),
  OPS_STATE_DIR: z.string().min(1).default(DEFAULT_OPS_STATE_DIR),
});

export interface MonitorConfig {
  stage: string;
  intervalSeconds: number;
  repeatSeconds: number;
  /** Secret (a webhook URL usually embeds a token): never log it. Null: log alerts only. */
  webhookUrl: string | null;
  /** GET after every round (a dead man's switch at an external uptime service). Secret. */
  heartbeatUrl: string | null;
  queueFailedMax: number;
  queueMaxWaitSeconds: Record<QueueName, number>;
  redisMemoryPercent: number;
  faceDeletionMaxAgeSeconds: number;
  backupMaxAgeSeconds: number;
  diskPaths: string[];
  diskPercent: number;
  memoryPercent: number;
  loadPerCpu: number;
  allowSwap: boolean;
  maxIds: number;
  stateDir: string;
}

/** `MONITOR_<QUEUE>_MAX_WAIT_SECONDS` overrides MONITOR_QUEUE_MAX_WAIT_SECONDS for one queue. */
export const queueMaxWaitEnv = (q: QueueName) => `MONITOR_${q.toUpperCase()}_MAX_WAIT_SECONDS`;

export function loadMonitorConfig(env: Env): MonitorConfig {
  const e = parseEnv(monitorEnvSchema, env, 'monitor');
  const perQueue = parseEnv(
    z.object(
      Object.fromEntries(QUEUE_NAMES.map((q) => [queueMaxWaitEnv(q), int(10, 86_400).optional()])),
    ),
    env,
    'monitor',
  ) as Record<string, number | undefined>;
  return {
    stage: e.APP_STAGE,
    intervalSeconds: e.MONITOR_INTERVAL_SECONDS,
    repeatSeconds: e.MONITOR_REPEAT_SECONDS,
    webhookUrl: webhookUrl(env, env.ALERT_WEBHOOK_URL, 'ALERT_WEBHOOK_URL'),
    heartbeatUrl: webhookUrl(env, env.MONITOR_HEARTBEAT_URL, 'MONITOR_HEARTBEAT_URL'),
    queueFailedMax: e.MONITOR_QUEUE_FAILED_MAX,
    queueMaxWaitSeconds: Object.fromEntries(
      QUEUE_NAMES.map((q) => [q, perQueue[queueMaxWaitEnv(q)] ?? e.MONITOR_QUEUE_MAX_WAIT_SECONDS]),
    ) as Record<QueueName, number>,
    redisMemoryPercent: e.MONITOR_REDIS_MEMORY_PERCENT,
    faceDeletionMaxAgeSeconds: e.MONITOR_FACE_DELETION_MAX_AGE_SECONDS,
    backupMaxAgeSeconds: e.MONITOR_BACKUP_MAX_AGE_SECONDS,
    diskPaths: e.MONITOR_DISK_PATHS.split(',')
      .map((p) => p.trim())
      .filter((p) => p !== ''),
    diskPercent: e.MONITOR_DISK_PERCENT,
    memoryPercent: e.MONITOR_MEMORY_PERCENT,
    loadPerCpu: e.MONITOR_LOAD_PER_CPU,
    allowSwap: e.MONITOR_ALLOW_SWAP,
    maxIds: e.MONITOR_MAX_IDS,
    stateDir: e.OPS_STATE_DIR,
  };
}

// --- Backup ------------------------------------------------------------------------------------

/** An age X25519 recipient (public key). Identities (`AGE-SECRET-KEY-1...`) are refused. */
const AGE_RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;
const AGE_IDENTITY = /AGE-SECRET-KEY-1/i;

const backupEnvSchema = z.object({
  APP_STAGE: stage,
  /** The backup bucket's S3 endpoint (R2: https://<account-id>.r2.cloudflarestorage.com). */
  BACKUP_ENDPOINT_URL: z.url({ protocol: /^https?$/ }),
  BACKUP_REGION: z.string().min(1).default('auto'),
  BACKUP_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, { error: 'must be a bucket name' }),
  /** Token of the backup bucket only, never the media tokens. Secret. */
  BACKUP_ACCESS_KEY_ID: z.string().min(1),
  BACKUP_SECRET_ACCESS_KEY: z.string().min(1),
  /** Key prefix of the dumps; ends with `/`. */
  BACKUP_PREFIX: z
    .string()
    .regex(/^([a-z0-9._-]+\/)*$/, { error: 'must be empty or end with /' })
    .default('postgres/'),
  /** age recipients (public keys), comma-separated. The private key is never on the VPS. */
  BACKUP_AGE_RECIPIENTS: z.string().min(1),
  /** Dumps older than this are deleted (the bucket lock keeps them at least as long). */
  BACKUP_RETENTION_DAYS: int(1, 3650).default(35),
  /** Daily run time, HH:MM in UTC (19:00 UTC is 02:00 in Bangkok). */
  BACKUP_TIME_UTC: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: 'must be HH:MM' })
    .default('19:00'),
  OPS_STATE_DIR: z.string().min(1).default(DEFAULT_OPS_STATE_DIR),
});

export interface BackupConfig {
  stage: string;
  endpointUrl: string;
  region: string;
  bucket: string;
  /** Secret. */
  credentials: { accessKeyId: string; secretAccessKey: string };
  prefix: string;
  recipients: string[];
  retentionDays: number;
  timeUtc: { hours: number; minutes: number };
  stateDir: string;
}

export function loadBackupConfig(env: Env): BackupConfig {
  // Fail closed if an age identity was put anywhere in the environment by mistake.
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && AGE_IDENTITY.test(value)) {
      throw new Error(
        `Invalid backup configuration: ${name} holds an age private key; it must never be on the VPS`,
      );
    }
  }
  const e = parseEnv(backupEnvSchema, env, 'backup');
  const recipients = e.BACKUP_AGE_RECIPIENTS.split(',')
    .map((r) => r.trim())
    .filter((r) => r !== '');
  const bad = recipients.filter((r) => !AGE_RECIPIENT.test(r));
  if (recipients.length === 0 || bad.length > 0) {
    throw new Error(
      'Invalid backup configuration: BACKUP_AGE_RECIPIENTS must be age public keys (age1...)',
    );
  }
  const url = new URL(e.BACKUP_ENDPOINT_URL);
  if (url.protocol !== 'https:' && e.APP_STAGE !== LOCAL_DEV_APP_STAGE) {
    throw new Error('Invalid backup configuration: BACKUP_ENDPOINT_URL must be https');
  }
  const [hours, minutes] = e.BACKUP_TIME_UTC.split(':').map(Number) as [number, number];
  return {
    stage: e.APP_STAGE,
    endpointUrl: url.origin,
    region: e.BACKUP_REGION,
    bucket: e.BACKUP_BUCKET,
    credentials: {
      accessKeyId: e.BACKUP_ACCESS_KEY_ID,
      secretAccessKey: e.BACKUP_SECRET_ACCESS_KEY,
    },
    prefix: e.BACKUP_PREFIX,
    recipients,
    retentionDays: e.BACKUP_RETENTION_DAYS,
    timeUtc: { hours, minutes },
    stateDir: e.OPS_STATE_DIR,
  };
}
