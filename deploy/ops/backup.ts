import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { BackupConfig } from './config';

// Daily pg_dump, encrypted to age public keys on the VPS and streamed to the backup bucket (ADR
// 0008 section 6). Nothing unencrypted touches disk or leaves the host.

const DAY_MS = 86_400_000;

/** `<prefix><stage>/YYYY/MM/shotx-<stage>-YYYYMMDDTHHMMSSZ.dump.age` */
export function backupKey(prefix: string, stage: string, at: Date): string {
  const iso = at.toISOString();
  const stamp = iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${prefix}${stage}/${iso.slice(0, 4)}/${iso.slice(5, 7)}/shotx-${stage}-${stamp}.dump.age`;
}

/** The next daily run at HH:MM UTC strictly after `now`. */
export function nextDailyRun(now: Date, time: { hours: number; minutes: number }): Date {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), time.hours, time.minutes),
  );
  return next.getTime() > now.getTime() ? next : new Date(next.getTime() + DAY_MS);
}

export interface StoredObject {
  key: string;
  lastModified: Date;
}

/**
 * Dumps (and their `.sha256` files) older than the retention, never the newest dump whatever
 * its age: a backup job that stopped must not end with an empty bucket.
 */
export function selectExpired(
  objects: readonly StoredObject[],
  now: Date,
  retentionDays: number,
): string[] {
  const dumps = objects.filter((o) => o.key.endsWith('.dump.age'));
  const newest = dumps.reduce<StoredObject | null>(
    (a, o) => (a === null || o.lastModified > a.lastModified ? o : a),
    null,
  );
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  const keep = newest?.key;
  return objects
    .filter((o) => o.lastModified.getTime() < cutoff)
    .filter((o) => o.key !== keep && o.key !== `${keep}.sha256`)
    .map((o) => o.key);
}

export interface BackupStatus {
  lastSuccessAt?: string;
  lastKey?: string;
  lastBytes?: number;
  lastSha256?: string;
  lastFailureAt?: string;
  /** A short reason, never a secret or a row. */
  lastError?: string;
}

export const STATUS_FILE = 'backup-status.json';

export async function readBackupStatus(stateDir: string): Promise<BackupStatus | null> {
  try {
    return JSON.parse(await readFile(join(stateDir, STATUS_FILE), 'utf8')) as BackupStatus;
  } catch {
    return null;
  }
}

async function writeBackupStatus(stateDir: string, status: BackupStatus): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const tmp = join(stateDir, `${STATUS_FILE}.tmp`);
  await writeFile(tmp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o640 });
  await rename(tmp, join(stateDir, STATUS_FILE));
}

/** `age -r <r1> -r <r2> ...`: encrypt to every recipient (e.g. the owner and a break-glass key). */
export function ageArgs(recipients: readonly string[]): string[] {
  return recipients.flatMap((r) => ['-r', r]);
}

/** Custom format (compressed, pg_restore can pick objects), connection from the PG* variables. */
export const PG_DUMP_ARGS = ['--format=custom', '--compress=6', '--no-password'];

/** Only PATH, the locale and libpq's PG* variables reach pg_dump; no bucket token. */
export function pgDumpEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([k]) => k === 'PATH' || k === 'LANG' || /^PG[A-Z]+$/.test(k)),
  );
}

function exited(child: ReturnType<typeof spawn>, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.on('error', (error) => reject(new Error(`${name} could not start: ${error.message}`)));
    child.on('close', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${name} exited with ${code ?? signal}`)),
    );
  });
}

function s3(config: BackupConfig): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpointUrl,
    credentials: config.credentials,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/**
 * One backup. The upload stream ends only after pg_dump and age both exited 0; otherwise it is
 * destroyed and the multipart upload aborted, so a truncated dump is never stored as complete.
 */
export async function runBackup(
  config: BackupConfig,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  now = new Date(),
): Promise<BackupStatus> {
  const client = s3(config);
  const key = backupKey(config.prefix, config.stage, now);
  const previous = (await readBackupStatus(config.stateDir)) ?? {};
  const started = Date.now();
  const children: ReturnType<typeof spawn>[] = [];
  try {
    const dump = spawn('pg_dump', PG_DUMP_ARGS, {
      env: pgDumpEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const age = spawn('age', ageArgs(config.recipients), {
      env: { PATH: env.PATH },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(dump, age);
    // stderr carries progress and errors only (no rows); keep the first lines for the log.
    for (const [name, child] of [
      ['pg_dump', dump],
      ['age', age],
    ] as const) {
      child.stderr?.on('data', (chunk: Buffer) =>
        log(`${name}: ${chunk.toString().trim().slice(0, 500)}`),
      );
    }
    dump.stdout.pipe(age.stdin);

    const hash = createHash('sha256');
    let bytes = 0;
    const body = new PassThrough();
    const counter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk);
        bytes += chunk.length;
        done(null, chunk);
      },
    });
    age.stdout.pipe(counter).pipe(body, { end: false });
    const counted = new Promise<void>((resolve) => counter.on('end', resolve));
    Promise.all([exited(dump, 'pg_dump'), exited(age, 'age'), counted]).then(
      () => body.end(),
      (error: unknown) => body.destroy(error instanceof Error ? error : new Error(String(error))),
    );

    const upload = new Upload({
      client,
      params: {
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/octet-stream',
      },
      partSize: 16 * 1024 * 1024,
      queueSize: 2,
      leavePartsOnError: false,
    });
    await upload.done();

    const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    if ((head.ContentLength ?? 0) !== bytes || bytes === 0) {
      throw new Error(`stored size ${head.ContentLength ?? 0} differs from ${bytes} bytes written`);
    }
    const sha256 = hash.digest('hex');
    const name = key.slice(key.lastIndexOf('/') + 1);
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: `${key}.sha256`,
        Body: `${sha256}  ${name}\n`,
        ContentType: 'text/plain',
      }),
    );
    const status: BackupStatus = {
      ...previous,
      lastSuccessAt: new Date().toISOString(),
      lastKey: key,
      lastBytes: bytes,
      lastSha256: sha256,
    };
    await writeBackupStatus(config.stateDir, status);
    log(`backup ${key}: ${bytes} bytes in ${Math.round((Date.now() - started) / 1000)}s`);
    await prune(client, config, log);
    return status;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const status: BackupStatus = {
      ...previous,
      lastFailureAt: new Date().toISOString(),
      lastError: reason.slice(0, 300),
    };
    await writeBackupStatus(config.stateDir, status);
    throw error;
  } finally {
    // A failed upload stops reading the pipe: end the children so pg_dump doesn't hold its
    // snapshot (and vacuum) until the container restarts.
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    client.destroy();
  }
}

async function prune(client: S3Client, config: BackupConfig, log: (line: string) => void) {
  const prefix = `${config.prefix}${config.stage}/`;
  const objects: StoredObject[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of page.Contents ?? []) {
      if (o.Key !== undefined && o.LastModified !== undefined) {
        objects.push({ key: o.Key, lastModified: o.LastModified });
      }
    }
    token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
  } while (token !== undefined);
  const expired = selectExpired(objects, new Date(), config.retentionDays);
  for (let i = 0; i < expired.length; i += 1000) {
    const batch = expired.slice(i, i + 1000);
    try {
      const out = await client.send(
        new DeleteObjectsCommand({
          Bucket: config.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      // The bucket lock refuses early deletes: that is the lock working, not a failure.
      for (const e of out.Errors ?? []) log(`prune: kept ${e.Key ?? '?'} (${e.Code ?? 'error'})`);
    } catch (error) {
      log(`prune failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (expired.length > 0)
    log(`prune: ${expired.length} object(s) past ${config.retentionDays} days`);
}
