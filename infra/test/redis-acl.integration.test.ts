import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../lib/config';
import { rawConfig } from './helpers';

/**
 * The Redis app user's access string (`redis.accessString`, e.g. "on ~* &* +@all -@dangerous")
 * against a real Redis 7: the commands api and worker need still work, including those that run
 * inside scripts (the rate limiter's EVAL calls TIME), and the dangerous ones are denied.
 * Destructive commands are only checked with ACL DRYRUN, never run.
 *
 * Runs when REDIS_URL points at a Redis without AUTH (docker compose, CI); skipped otherwise.
 * ElastiCache 7.1 is based on Redis 7.0; CI runs 7.2. Both use the same command categories for
 * the commands below.
 */

type Reply = string | number | null | Error | Reply[];

/** Minimal RESP2 client: enough for ACL, AUTH and a few data commands. No dependency needed. */
class Resp {
  private buffer = Buffer.alloc(0);
  private readonly waiting: ((reply: Reply) => void)[] = [];

  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const parsed = parse(this.buffer, 0);
        if (parsed === null) return;
        this.buffer = this.buffer.subarray(parsed[1]);
        this.waiting.shift()?.(parsed[0]);
      }
    });
  }

  static open(url: URL): Promise<Resp> {
    return new Promise((resolve, reject) => {
      const socket = connect(Number(url.port || 6379), url.hostname, () =>
        resolve(new Resp(socket)),
      );
      socket.once('error', reject);
    });
  }

  send(...args: (string | number)[]): Promise<Reply> {
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      const parts = args.map((a) => Buffer.from(String(a)));
      this.socket.write(
        Buffer.concat([
          Buffer.from(`*${parts.length}\r\n`),
          ...parts.flatMap((p) => [Buffer.from(`$${p.length}\r\n`), p, Buffer.from('\r\n')]),
        ]),
      );
    });
  }

  close(): void {
    this.socket.end();
  }
}

function parse(buf: Buffer, at: number): [Reply, number] | null {
  const eol = buf.indexOf('\r\n', at);
  if (eol < 0) return null;
  const line = buf.toString('utf8', at + 1, eol);
  const next = eol + 2;
  switch (String.fromCharCode(buf[at] ?? 0)) {
    case '+':
      return [line, next];
    case '-':
      return [new Error(line), next];
    case ':':
      return [Number(line), next];
    case '$': {
      const len = Number(line);
      if (len < 0) return [null, next];
      if (buf.length < next + len + 2) return null;
      return [buf.toString('utf8', next, next + len), next + len + 2];
    }
    case '*': {
      const count = Number(line);
      if (count < 0) return [null, next];
      const items: Reply[] = [];
      let pos = next;
      for (let i = 0; i < count; i++) {
        const item = parse(buf, pos);
        if (item === null) return null;
        items.push(item[0]);
        pos = item[1];
      }
      return [items, pos];
    }
    default:
      throw new Error(`Unexpected RESP reply: ${line}`);
  }
}

const redisUrl = process.env.REDIS_URL;
const accessString = parseConfig(rawConfig()).redis.accessString;

/** The rate limiter's shape (packages/face redis-token-bucket.ts): TIME, LINDEX, LPUSH, LTRIM, PEXPIRE. */
const LIMITER_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local newest = redis.call('LINDEX', KEYS[1], 0)
redis.call('LPUSH', KEYS[1], string.format('%d', now))
redis.call('LTRIM', KEYS[1], 0, 9)
redis.call('PEXPIRE', KEYS[1], 1000)
return redis.call('LINDEX', KEYS[1], 0)
`;

describe.skipIf(redisUrl === undefined || redisUrl === '')(
  'Redis app user ACL (real Redis)',
  () => {
    const url = new URL(redisUrl ?? 'redis://localhost:6379');
    const user = `shotx-acl-test-${randomBytes(4).toString('hex')}`;
    const password = randomBytes(24).toString('hex');
    const key = `shotx:acl-test:${user}`;
    let admin: Resp;
    let app: Resp;

    beforeAll(async () => {
      admin = await Resp.open(url);
      const info = String(await admin.send('INFO', 'server'));
      const major = Number(/redis_version:(\d+)/.exec(info)?.[1]);
      if (!(major >= 7))
        throw new Error(`Redis 7+ needed for ACL DRYRUN, got ${info.slice(0, 80)}`);
      const tokens = accessString.trim().split(/\s+/);
      expect(await admin.send('ACL', 'SETUSER', user, 'reset', ...tokens, `>${password}`)).toBe(
        'OK',
      );
      app = await Resp.open(url);
      expect(await app.send('AUTH', user, password)).toBe('OK');
    });

    afterAll(async () => {
      app?.close();
      if (admin !== undefined) {
        await admin.send('DEL', key, `${key}:grant`);
        await admin.send('ACL', 'DELUSER', user);
        admin.close();
      }
    });

    const dryRun = (...command: string[]) => admin.send('ACL', 'DRYRUN', user, ...command);

    it.each([
      ['GET', key],
      ['SET', key, 'v', 'EX', '60'],
      ['EXPIRE', key, '60'],
      ['DEL', key],
      ['LINDEX', key, '0'],
      ['LPUSH', key, '1'],
      ['LTRIM', key, '0', '9'],
      ['PEXPIRE', key, '1000'],
      ['EVAL', 'return 1', '0'],
      ['EVALSHA', 'e0e1f9fabfc9d4800c877a703b823ac0578ff8db', '0'],
      ['SCRIPT', 'LOAD', 'return 1'],
      ['TIME'],
      ['PING'],
      ['CLIENT', 'SETNAME', 'shotx-api'],
    ])('allows %s', async (...command) => {
      expect(await dryRun(...command)).toBe('OK');
    });

    it.each([
      ['FLUSHALL'],
      ['FLUSHDB'],
      ['KEYS', '*'],
      ['CONFIG', 'GET', 'maxmemory-policy'],
      ['CONFIG', 'SET', 'maxmemory-policy', 'allkeys-lru'],
      ['DEBUG', 'SLEEP', '0'],
      ['SHUTDOWN'],
      ['MONITOR'],
      ['INFO'],
      ['SWAPDB', '0', '1'],
      ['MIGRATE', 'h', '1', key, '0', '1'],
      ['RESTORE', key, '0', 'x'],
      ['REPLICAOF', 'NO', 'ONE'],
      ['ACL', 'SETUSER', 'x'],
      ['CLIENT', 'KILL', 'ID', '1'],
      ['SAVE'],
      ['BGSAVE'],
    ])('denies %s', async (...command) => {
      expect(String(await dryRun(...command))).toMatch(/no permissions/i);
    });

    it('runs the rate limiter script (TIME inside EVAL, then EVALSHA)', async () => {
      const first = await app.send('EVAL', LIMITER_SCRIPT, 1, key);
      expect(typeof first).toBe('string');
      const sha = await app.send('SCRIPT', 'LOAD', LIMITER_SCRIPT);
      expect(typeof sha).toBe('string');
      expect(typeof (await app.send('EVALSHA', String(sha), 1, key))).toBe('string');
      expect(await app.send('PTTL', key)).toBeGreaterThan(0);
    });

    it('stores and expires a grant with GET, SET and EXPIRE', async () => {
      expect(await app.send('SET', `${key}:grant`, '["file-1"]', 'EX', 60)).toBe('OK');
      expect(await app.send('EXPIRE', `${key}:grant`, 120)).toBe(1);
      expect(await app.send('GET', `${key}:grant`)).toBe('["file-1"]');
    });

    it('denies dangerous commands for real, also from inside a script', async () => {
      expect(await app.send('KEYS', '*')).toBeInstanceOf(Error);
      const fromScript = await app.send('EVAL', "return redis.call('FLUSHALL')", 0);
      // Redis 7.2: NOPERM ...; 7.0: ERR The user executing the script can't run this command.
      expect(String(fromScript)).toMatch(/NOPERM|no permissions|can't run this command/i);
      expect(await admin.send('EXISTS', `${key}:grant`)).toBe(1);
    });
  },
);
