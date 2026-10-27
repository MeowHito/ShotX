import { createHash } from 'node:crypto';
import { parseQueueMessage } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { ageArgs, backupKey, nextDailyRun, pgDumpEnv, selectExpired } from '../ops/backup';
import { loadBackupConfig, loadMonitorConfig } from '../ops/config';
import { MONITOR_GRANTS, monitorGrantStatements } from '../ops/migrate';
import { buildUsersAcl, MONITOR_COMMANDS } from '../ops/redis-acl';
import { manualJobBody, parseJobType } from '../ops/run-job';

const AGE_KEY = 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p';

describe('monitor config', () => {
  it('has defaults for everything but the stage', () => {
    const c = loadMonitorConfig({ APP_STAGE: 'prod' });
    expect(c).toMatchObject({
      stage: 'prod',
      webhookUrl: null,
      intervalSeconds: 60,
      queueFailedMax: 0,
      redisMemoryPercent: 75,
      faceDeletionMaxAgeSeconds: 86_400,
      allowSwap: false,
      diskPaths: ['/var/lib/shotx-ops'],
    });
    expect(c.queueMaxWaitSeconds).toEqual({ media: 1800, faces: 1800, zip: 1800, jobs: 1800 });
  });

  it('takes per-queue wait limits', () => {
    const c = loadMonitorConfig({ APP_STAGE: 'prod', MONITOR_ZIP_MAX_WAIT_SECONDS: '120' });
    expect(c.queueMaxWaitSeconds.zip).toBe(120);
    expect(c.queueMaxWaitSeconds.media).toBe(1800);
  });

  it('needs https webhooks outside local', () => {
    expect(() =>
      loadMonitorConfig({ APP_STAGE: 'prod', ALERT_WEBHOOK_URL: 'http://hooks.example.com/x' }),
    ).toThrow(/ALERT_WEBHOOK_URL must be https/);
    expect(
      loadMonitorConfig({ APP_STAGE: 'local', ALERT_WEBHOOK_URL: 'http://localhost:9/x' })
        .webhookUrl,
    ).toBe('http://localhost:9/x');
  });
});

describe('backup config', () => {
  const env = {
    APP_STAGE: 'prod',
    BACKUP_ENDPOINT_URL: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    BACKUP_BUCKET: 'shotx-prod-backups',
    BACKUP_ACCESS_KEY_ID: 'id',
    BACKUP_SECRET_ACCESS_KEY: 'secret',
    BACKUP_AGE_RECIPIENTS: AGE_KEY,
  };

  it('reads the bucket, recipients, retention and time', () => {
    expect(loadBackupConfig(env)).toMatchObject({
      bucket: 'shotx-prod-backups',
      region: 'auto',
      prefix: 'postgres/',
      recipients: [AGE_KEY],
      retentionDays: 35,
      timeUtc: { hours: 19, minutes: 0 },
    });
  });

  it('accepts public keys only, and refuses an age private key anywhere in the env', () => {
    expect(() => loadBackupConfig({ ...env, BACKUP_AGE_RECIPIENTS: 'not-a-key' })).toThrow(
      /age public keys/,
    );
    expect(() =>
      loadBackupConfig({ ...env, SOMETHING: 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQ' }),
    ).toThrow(/SOMETHING holds an age private key/);
  });

  it('needs https outside local', () => {
    expect(() =>
      loadBackupConfig({ ...env, BACKUP_ENDPOINT_URL: 'http://minio.example.com' }),
    ).toThrow(/must be https/);
  });
});

describe('backup', () => {
  it('names dumps by stage and UTC time', () => {
    expect(backupKey('postgres/', 'prod', new Date('2026-11-02T19:00:07.123Z'))).toBe(
      'postgres/prod/2026/11/shotx-prod-20261102T190007Z.dump.age',
    );
  });

  it('runs daily at the configured UTC time, always in the future', () => {
    const t = { hours: 19, minutes: 0 };
    expect(nextDailyRun(new Date('2026-11-02T10:00:00Z'), t).toISOString()).toBe(
      '2026-11-02T19:00:00.000Z',
    );
    expect(nextDailyRun(new Date('2026-11-02T19:00:00Z'), t).toISOString()).toBe(
      '2026-11-03T19:00:00.000Z',
    );
  });

  it('expires old dumps but never the newest one', () => {
    const now = new Date('2026-12-31T00:00:00Z');
    const at = (iso: string) => new Date(iso);
    const objects = [
      { key: 'p/a.dump.age', lastModified: at('2026-10-01T00:00:00Z') },
      { key: 'p/a.dump.age.sha256', lastModified: at('2026-10-01T00:00:00Z') },
      { key: 'p/b.dump.age', lastModified: at('2026-12-30T00:00:00Z') },
    ];
    expect(selectExpired(objects, now, 35)).toEqual(['p/a.dump.age', 'p/a.dump.age.sha256']);
    // The backup job stopped long ago: keep its last dump.
    expect(selectExpired(objects.slice(0, 2), now, 35)).toEqual([]);
  });

  it('gives pg_dump only libpq settings, never the bucket token', () => {
    const env = pgDumpEnv({
      PATH: '/usr/bin',
      PGHOST: 'postgres',
      PGPASSWORD: 'p',
      BACKUP_SECRET_ACCESS_KEY: 's',
      BACKUP_AGE_RECIPIENTS: AGE_KEY,
    });
    expect(Object.keys(env).sort()).toEqual(['PATH', 'PGHOST', 'PGPASSWORD']);
  });

  it('encrypts to every recipient', () => {
    expect(ageArgs([AGE_KEY, 'age1other'])).toEqual(['-r', AGE_KEY, '-r', 'age1other']);
  });
});

describe('redis users.acl', () => {
  const app = 'a'.repeat(40);
  const monitor = 'm'.repeat(40);
  const acl = buildUsersAcl({ app, monitor });
  const line = (user: string) => acl.split('\n').find((l) => l.startsWith(`user ${user} `)) ?? '';

  it('turns the default user off', () => {
    expect(line('default')).toBe('user default off resetpass resetkeys resetchannels -@all');
  });

  it('gives the app everything but @dangerous, by password hash only', () => {
    const sha = createHash('sha256').update(app).digest('hex');
    expect(line('shotx-app')).toContain(`#${sha}`);
    expect(line('shotx-app')).toMatch(/\+@all -@dangerous$/);
    expect(acl).not.toContain(app);
    expect(acl).not.toContain(monitor);
  });

  it('gives the monitor read-only keys and a fixed command list', () => {
    expect(line('shotx-monitor')).toContain('%R~*');
    expect(line('shotx-monitor')).toMatch(/-@all( \+[a-z|]+)+$/);
    for (const c of MONITOR_COMMANDS) expect(line('shotx-monitor')).toContain(`+${c}`);
    expect(line('healthcheck')).toBe(
      'user healthcheck on nopass resetkeys resetchannels -@all +ping',
    );
  });

  it('refuses short, blank or shared passwords', () => {
    expect(() => buildUsersAcl({ app: 'short', monitor })).toThrow(/REDIS_APP_PASSWORD/);
    expect(() => buildUsersAcl({ app, monitor: `${'x'.repeat(32)} y` })).toThrow(
      /REDIS_MONITOR_PASSWORD/,
    );
    expect(() => buildUsersAcl({ app, monitor: app })).toThrow(/must differ/);
  });
});

describe('monitor database grants', () => {
  it('revokes, then grants only the listed columns', () => {
    const sql = monitorGrantStatements();
    expect(sql[0]).toBe('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "shotx_monitor"');
    expect(sql).toContain(
      'GRANT SELECT ("id", "share_id", "created_at", "completed_at") ON "face_deletions" TO "shotx_monitor"',
    );
  });

  it('never exposes names, keys or personal data', () => {
    const columns = Object.values(MONITOR_GRANTS).flat();
    for (const c of ['name', 'email', 's3_key', 'owner_id', 'photographer_id', 'mime']) {
      expect(columns).not.toContain(c);
    }
  });
});

describe('run-job', () => {
  it('accepts scheduled job types only', () => {
    expect(parseJobType('quota.reconcile.nightly')).toBe('quota.reconcile.nightly');
    expect(() => parseJobType('drop.database')).toThrow(/must be one of/);
    expect(() => parseJobType(undefined)).toThrow(/must be one of/);
  });

  it('builds a jobs message the worker parses, with this second as its slot', () => {
    const body = manualJobBody('faces.reconcile.daily', new Date('2026-11-02T03:04:05.678Z'));
    expect(parseQueueMessage('jobs', body)).toEqual({
      type: 'faces.reconcile.daily',
      scheduledTime: '2026-11-02T03:04:05Z',
    });
  });
});
