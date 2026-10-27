import { createHash } from 'node:crypto';

// users.acl of the compose Redis (ADR 0005 as amended by ADR 0008 section 3). Generated, never
// committed: it holds password hashes. `pnpm --filter @shotx/deploy ops redis-acl` prints it.

/** ACL user names; api and worker use APP, the monitor MONITOR, the container healthcheck PING. */
export const REDIS_USERS = {
  app: 'shotx-app',
  monitor: 'shotx-monitor',
  healthcheck: 'healthcheck',
} as const;

/** Commands the monitor runs: queue sizes and the oldest waiting job, plus INFO memory. */
export const MONITOR_COMMANDS = [
  'ping',
  'info',
  'zcard',
  'llen',
  'lindex',
  'hget',
  'client|setname',
];

/** At least 32 printable characters, no whitespace (redis ACL `>password` rules). */
export function assertRedisPassword(name: string, password: string | undefined): string {
  if (password === undefined || password.length < 32 || /\s/.test(password)) {
    throw new Error(`${name} must be at least 32 characters without whitespace`);
  }
  return password;
}

const sha256 = (password: string) => createHash('sha256').update(password, 'utf8').digest('hex');

/**
 * The ACL file:
 * - `default` off: unauthenticated clients can do nothing;
 * - the app user: every command except `@dangerous` (FLUSHALL, KEYS, CONFIG, INFO, ...), any key
 *   and channel, as ADR 0005 (BullMQ runs with skipVersionCheck because INFO is denied);
 * - the monitor: read-only keys and only the commands it needs;
 * - healthcheck: PING only, no password (the compose healthcheck; it can read and write nothing).
 * Passwords are stored as SHA-256 (`#<hex>`), never in clear.
 */
export function buildUsersAcl(passwords: { app: string; monitor: string }): string {
  const app = assertRedisPassword('REDIS_APP_PASSWORD', passwords.app);
  const monitor = assertRedisPassword('REDIS_MONITOR_PASSWORD', passwords.monitor);
  if (app === monitor) throw new Error('the app and monitor Redis passwords must differ');
  return [
    'user default off resetpass resetkeys resetchannels -@all',
    `user ${REDIS_USERS.app} on resetpass #${sha256(app)} resetkeys ~* resetchannels &* +@all -@dangerous`,
    `user ${REDIS_USERS.monitor} on resetpass #${sha256(monitor)} resetkeys %R~* resetchannels -@all ${MONITOR_COMMANDS.map((c) => `+${c}`).join(' ')}`,
    `user ${REDIS_USERS.healthcheck} on nopass resetkeys resetchannels -@all +ping`,
    '',
  ].join('\n');
}
