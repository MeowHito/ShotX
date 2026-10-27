import { pathToFileURL } from 'node:url';
import { nextDailyRun, runBackup } from './backup';
import { loadBackupConfig } from './config';
import { runMigrate } from './migrate';
import { runMonitor } from './monitor/run';
import { buildUsersAcl } from './redis-acl';
import { parseJobType, runJob } from './run-job';

// Entry point of the ops image (deploy/ops/Dockerfile) and `pnpm --filter @shotx/deploy ops`.

export const USAGE = `Usage: ops <command>

  migrate            apply migrations, seed plans, grant the monitor role its columns
  backup [--once]    daily encrypted pg_dump to the backup bucket (--once: now, then exit)
  monitor [--once]   checks and alerts every MONITOR_INTERVAL_SECONDS (--once: one round; exit 1
                     if anything fires)
  run-job <type>     queue one scheduled job now (e.g. quota.reconcile.nightly)
  redis-acl          print users.acl from REDIS_APP_PASSWORD and REDIS_MONITOR_PASSWORD`;

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

async function backupLoop(once: boolean): Promise<number> {
  const config = loadBackupConfig(process.env);
  if (once) {
    await runBackup(config, process.env, log);
    return 0;
  }
  let stopping = false;
  process.once('SIGTERM', () => (stopping = true));
  process.once('SIGINT', () => (stopping = true));
  while (!stopping) {
    const next = nextDailyRun(new Date(), config.timeUtc);
    log(`next backup at ${next.toISOString()}`);
    while (!stopping && Date.now() < next.getTime()) {
      await new Promise((r) => setTimeout(r, Math.min(60_000, next.getTime() - Date.now())));
    }
    if (stopping) break;
    // A failed run is recorded in the status file and alerted by the monitor; keep the schedule.
    await runBackup(config, process.env, log).catch((error: unknown) =>
      log(`backup failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const once = rest.includes('--once');
  switch (command) {
    case 'migrate':
      await runMigrate(process.env, log);
      return 0;
    case 'backup':
      return backupLoop(once);
    case 'monitor':
      return runMonitor(process.env, once, log);
    case 'run-job':
      await runJob(process.env, parseJobType(rest[0]), log);
      return 0;
    case 'redis-acl':
      process.stdout.write(
        buildUsersAcl({
          app: process.env.REDIS_APP_PASSWORD ?? '',
          monitor: process.env.REDIS_MONITOR_PASSWORD ?? '',
        }),
      );
      return 0;
    default:
      console.error(USAGE);
      return command === undefined || command === '--help' ? 0 : 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
