import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { loadDatabaseConfig, pgPoolConfig, pgSslOptions } from './config';

const rdsEnv = {
  PGHOST: 'shotx-prod.cluster-abc.ap-southeast-1.rds.amazonaws.com',
  PGPORT: '5432',
  PGDATABASE: 'shotx',
  PGUSER: 'shotx_admin',
  PGPASSWORD: 's3cr3t/with:chars@',
  PGSSLMODE: 'verify-full',
};

describe('loadDatabaseConfig', () => {
  it('reads DATABASE_URL, defaulting to plaintext for local docker', () => {
    expect(
      loadDatabaseConfig({ DATABASE_URL: 'postgres://shotx:shotx@localhost:5432/shotx' }),
    ).toEqual({
      source: 'DATABASE_URL',
      host: 'localhost',
      port: 5432,
      database: 'shotx',
      user: 'shotx',
      password: 'shotx',
      sslMode: 'disable',
      poolMax: 10,
    });
  });

  it('decodes URL-encoded credentials and reads sslmode from the URL', () => {
    const config = loadDatabaseConfig({
      DATABASE_URL:
        'postgresql://app%40corp:p%40ss%2Fw%3Ard@db.internal:6543/shot%20x?sslmode=verify-full',
      DATABASE_POOL_MAX: '25',
    });
    expect(config).toMatchObject({
      host: 'db.internal',
      port: 6543,
      user: 'app@corp',
      password: 'p@ss/w:rd',
      database: 'shot x',
      sslMode: 'verify-full',
      poolMax: 25,
    });
  });

  it('accepts IPv6 hosts and URLs without a password', () => {
    expect(loadDatabaseConfig({ DATABASE_URL: 'postgres://u@[::1]/db' })).toMatchObject({
      host: '::1',
      port: 5432,
      password: undefined,
    });
  });

  it('reads the libpq variables ECS tasks get', () => {
    expect(loadDatabaseConfig(rdsEnv)).toEqual({
      source: 'PG',
      host: rdsEnv.PGHOST,
      port: 5432,
      database: 'shotx',
      user: 'shotx_admin',
      password: rdsEnv.PGPASSWORD,
      sslMode: 'verify-full',
      poolMax: 10,
    });
    expect(loadDatabaseConfig({ ...rdsEnv, PGPORT: '' }).port).toBe(5432);
  });

  it('prefers DATABASE_URL and then ignores every PG* variable', () => {
    const config = loadDatabaseConfig({ ...rdsEnv, DATABASE_URL: 'postgres://a:b@localhost/x' });
    expect(config).toMatchObject({ source: 'DATABASE_URL', host: 'localhost', sslMode: 'disable' });
  });

  it('requires PGSSLMODE in the libpq form', () => {
    expect(() => loadDatabaseConfig({ ...rdsEnv, PGSSLMODE: undefined })).toThrow(/PGSSLMODE/);
  });

  it.each(['allow', 'prefer', 'no-verify', 'VERIFY-FULL'])('rejects sslmode %s', (mode) => {
    expect(() => loadDatabaseConfig({ ...rdsEnv, PGSSLMODE: mode })).toThrow(
      /allow and prefer are not supported/,
    );
    expect(() =>
      loadDatabaseConfig({ DATABASE_URL: `postgres://u:p@h/db?sslmode=${mode}` }),
    ).toThrow(/sslmode must be disable, require, verify-ca or verify-full/);
  });

  it.each([
    ['no configuration at all', {}, /set DATABASE_URL, or PGHOST/],
    ['a missing PGUSER', { ...rdsEnv, PGUSER: '' }, /PGUSER/],
    ['a bad PGPORT', { ...rdsEnv, PGPORT: '70000' }, /PGPORT/],
    ['a non-postgres URL', { DATABASE_URL: 'mysql://u:p@h/db' }, /postgres:\/\//],
    ['a URL without a database', { DATABASE_URL: 'postgres://u:p@h' }, /one database/],
    ['a URL without a user', { DATABASE_URL: 'postgres://h/db' }, /no user/],
    ['an unsupported URL parameter', { DATABASE_URL: 'postgres://u@h/db?sslcert=x' }, /sslcert/],
    ['a pool size of 0', { ...rdsEnv, DATABASE_POOL_MAX: '0' }, /DATABASE_POOL_MAX/],
  ])('rejects %s', (_label, env, message) => {
    expect(() => loadDatabaseConfig(env)).toThrow(message);
  });

  it('never puts the password in error messages', () => {
    const secret = 'Sup3rS3cret';
    for (const DATABASE_URL of [
      `postgres://u:${secret}@h/db?sslmode=prefer`,
      `postgres://u:${secret}@h`,
      `mysql://u:${secret}@h/db`,
      `postgres://u:${secret}%zz@h/db`,
    ]) {
      expect(() => loadDatabaseConfig({ DATABASE_URL })).toThrow();
      try {
        loadDatabaseConfig({ DATABASE_URL });
      } catch (error) {
        expect(String(error)).not.toContain(secret);
      }
    }
  });
});

describe('sslmode mapping', () => {
  const cert = { subject: { CN: 'other.example.com' }, subjectaltname: 'DNS:other.example.com' };

  it('maps disable to no TLS', () => {
    expect(pgSslOptions('disable')).toBe(false);
  });

  it('maps require to TLS without verification', () => {
    expect(pgSslOptions('require')).toEqual({ rejectUnauthorized: false });
  });

  it('maps verify-ca to a verified chain without a host name check', () => {
    const ssl = pgSslOptions('verify-ca');
    expect(ssl).toMatchObject({ rejectUnauthorized: true });
    if (ssl === false) throw new Error('expected TLS');
    expect(ssl.checkServerIdentity?.('db.example.com', cert as PeerCertificate)).toBeUndefined();
  });

  it('maps verify-full to a verified chain and host name', () => {
    const ssl = pgSslOptions('verify-full');
    expect(ssl).toEqual({ rejectUnauthorized: true, checkServerIdentity });
    if (ssl === false) throw new Error('expected TLS');
    expect(ssl.checkServerIdentity?.('db.example.com', cert as PeerCertificate)).toBeInstanceOf(
      Error,
    );
  });

  it('builds pool settings from the libpq form with explicit TLS', () => {
    expect(pgPoolConfig(loadDatabaseConfig(rdsEnv))).toEqual({
      host: rdsEnv.PGHOST,
      port: 5432,
      database: 'shotx',
      user: 'shotx_admin',
      password: rdsEnv.PGPASSWORD,
      ssl: { rejectUnauthorized: true, checkServerIdentity },
      max: 10,
    });
  });

  it('builds pool settings from DATABASE_URL without a connection string', () => {
    const pool = pgPoolConfig(
      loadDatabaseConfig({ DATABASE_URL: 'postgres://shotx:shotx@localhost:5432/shotx' }),
    );
    expect(pool).not.toHaveProperty('connectionString');
    expect(pool).toMatchObject({ host: 'localhost', ssl: false });
  });
});
