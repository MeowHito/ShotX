import 'reflect-metadata';
import { userInfo } from 'node:os';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createDb, createPool, loadDatabaseConfig } from '@shotx/db';
import { loadApiConfig } from '../config';
import {
  type AdminOpsContext,
  AdminOpsError,
  createAdmin,
  resetAdminPassword,
  resetAdminTotp,
  type TotpEnrolment,
  unlockAdmin,
} from './admin-ops';

// Operator CLI for ShotX admin accounts (AUTH_PROVIDER=shotx or local). Runs with the API's
// environment, e.g. in the api container:
//
//   node dist/cli/admin.js create --email a@example.com --name "Admin A"   (password on stdin)
//   node dist/cli/admin.js reset-totp --email a@example.com
//   node dist/cli/admin.js reset-password --email a@example.com            (password on stdin)
//   node dist/cli/admin.js unlock --email a@example.com
//
// Locally: pnpm --filter @shotx/api admin <command> ... The password is read from stdin (hidden
// on a terminal), never from arguments, so it stays out of shell history and `ps`.

const USAGE = `Usage: admin <create|reset-totp|reset-password|unlock> --email <email> [--name <name>]`;

/** Reads one line from stdin; on a terminal the typed characters are not echoed. */
function readPassword(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const tty = process.stdin.isTTY;
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
    if (tty) {
      process.stdout.write(prompt);
      // Swallow the echo of typed characters.
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => undefined;
    }
    rl.once('line', (line) => {
      rl.close();
      if (tty) process.stdout.write('\n');
      resolve(line);
    });
    rl.once('close', () => reject(new AdminOpsError('No password given on stdin')));
  });
}

function printEnrolment(enrolment: TotpEnrolment): void {
  // Shown once: the secret is stored encrypted and can't be displayed again (reset-totp instead).
  process.stdout.write(
    [
      `admin user id: ${enrolment.userId}`,
      `subject:       ${enrolment.subject}`,
      'Add this to the admin’s authenticator app (shown once). The first valid code at',
      'sign-in confirms the enrolment.',
      `  ${enrolment.otpauthUri}`,
      `  manual entry: ${enrolment.secretBase32}`,
      '',
    ].join('\n'),
  );
}

async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { email: { type: 'string' }, name: { type: 'string' } },
  });
  const [command] = positionals;
  const email = values.email;
  if (command === undefined || email === undefined) throw new AdminOpsError(USAGE);

  const config = loadApiConfig(process.env);
  const admin = config.shotxAuth?.admin ?? null;
  if (admin === null) {
    throw new AdminOpsError(
      'Admin sign-in is off: needs AUTH_PROVIDER=shotx or local with AUTH_ADMINS_SIGNING_KEY and ADMIN_TOTP_ENCRYPTION_KEY',
    );
  }
  const pool = createPool(loadDatabaseConfig(process.env));
  const ctx: AdminOpsContext = {
    db: createDb(pool),
    stage: config.app.stage,
    admin,
    argon2id: config.password.argon2id,
    now: () => new Date(),
    operator: userInfo().username,
  };
  try {
    switch (command) {
      case 'create': {
        if (values.name === undefined) throw new AdminOpsError(USAGE);
        const password = await readPassword('New admin password: ');
        printEnrolment(await createAdmin(ctx, { email, name: values.name, password }));
        break;
      }
      case 'reset-totp':
        printEnrolment(await resetAdminTotp(ctx, email));
        break;
      case 'reset-password':
        await resetAdminPassword(ctx, email, await readPassword('New password: '));
        process.stdout.write('Password changed; the admin’s sessions were revoked.\n');
        break;
      case 'unlock':
        await unlockAdmin(ctx, email);
        process.stdout.write('Unlocked.\n');
        break;
      default:
        throw new AdminOpsError(USAGE);
    }
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  // Config errors never contain secret values; nothing here prints the password.
  console.error(error instanceof Error ? error.message : 'admin command failed');
  process.exit(1);
});
