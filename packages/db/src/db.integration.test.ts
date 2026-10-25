import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { eq, type SQL, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from './client';
import { loadDatabaseConfig, pgPoolConfig } from './config';
import { folderPath } from './ltree';
import { MIGRATIONS_FOLDER, migrateDatabase } from './migrate';
import { zipKey } from '@shotx/shared';
import * as schema from './schema/index';
import { SEED_PLANS, seedPlans } from './seed';
import type { NewDriveFile, NewShare, NewUser, NewZipJob } from './types';

// Migrations and seed against a real PostgreSQL. Two backends run the same tests:
// - PGlite: PostgreSQL 18 compiled to WASM, in process, with the ltree extension. Always runs.
// - TEST_DATABASE_URL: a PostgreSQL server (CI's Postgres 18 service). Runs when the variable is
//   set; each run creates a fresh database from template0 and drops it afterwards, so the user
//   needs CREATEDB.

type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

interface Backend {
  db: Db;
  /** Applies the migrations again (must be a no-op). */
  migrateAgain(): Promise<void>;
  close(): Promise<void>;
}

async function openPglite(): Promise<Backend> {
  const client = await PGlite.create({ extensions: { ltree } });
  const db = drizzlePglite({ client, schema });
  const run = () => migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await run();
  return { db, migrateAgain: run, close: () => client.close() };
}

async function openServer(url: string): Promise<Backend> {
  const admin = loadDatabaseConfig({ DATABASE_URL: url });
  const name = `shotx_it_${process.pid}_${Date.now()}`;
  const adminClient = new pg.Client(pgPoolConfig(admin));
  await adminClient.connect();
  // template0 has no extensions, so migration 0000 must create ltree itself, as on RDS.
  await adminClient.query(`CREATE DATABASE "${name}" TEMPLATE template0 ENCODING 'UTF8'`);
  const config = { ...admin, database: name, poolMax: 2 };
  const pool = createPool(config);
  const close = async () => {
    await pool.end();
    await adminClient.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await adminClient.end();
  };
  try {
    await migrateDatabase(config);
  } catch (error) {
    await close();
    throw error;
  }
  return { db: createDb(pool), migrateAgain: () => migrateDatabase(config), close };
}

const backends = [
  { name: 'PGlite (PostgreSQL 18, in process)', open: openPglite, enabled: true },
  {
    name: 'TEST_DATABASE_URL',
    open: () => openServer(process.env.TEST_DATABASE_URL ?? ''),
    enabled: (process.env.TEST_DATABASE_URL ?? '') !== '',
  },
];

/** Raw query rows. Both drivers return `{ rows }`, but the shared Db type can't say so. */
async function rows<T extends Record<string, unknown>>(db: Db, query: SQL): Promise<T[]> {
  const result: unknown = await db.execute<T>(query);
  return (result as { rows: T[] }).rows;
}

function one<T>(items: T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error('expected a row');
  return item;
}

/** The PostgreSQL error a statement fails with (Drizzle wraps it in `cause`). */
async function pgError(statement: PromiseLike<unknown>) {
  try {
    await statement;
  } catch (error) {
    let e: unknown = error;
    while (e instanceof Error && !('code' in e && typeof e.code === 'string')) e = e.cause;
    const { code, constraint } = (e ?? {}) as { code?: string; constraint?: string };
    return { code, constraint };
  }
  throw new Error('expected the statement to fail');
}

const UNIQUE = '23505';
const CHECK = '23514';
const FOREIGN_KEY = '23503';
/** ON DELETE RESTRICT reports restrict_violation, not foreign_key_violation. */
const RESTRICT = '23001';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** A random 22-character base62 share token. */
function newToken(): string {
  return Array.from(randomBytes(22), (b) => BASE62[b % 62]).join('');
}

function utcMonthPartition(date: Date, offset = 0): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
  return `activity_events_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

for (const backend of backends) {
  describe.skipIf(!backend.enabled)(`migrations and seed on ${backend.name}`, () => {
    let b: Backend;
    const db = () => b.db;

    beforeAll(async () => {
      b = await backend.open();
    }, 120_000);

    afterAll(async () => {
      await b?.close();
    });

    const newUser = async (values: Partial<NewUser> = {}) =>
      one(
        await db()
          .insert(schema.users)
          .values({
            cognitoPool: 'users',
            cognitoSub: randomUUID(),
            role: 'photographer',
            ...values,
          })
          .returning(),
      );

    const newFolder = async (ownerId: string, parent: { id: string; path: string } | null) => {
      const id = randomUUID();
      return one(
        await db()
          .insert(schema.folders)
          .values({
            id,
            ownerId,
            parentId: parent?.id ?? null,
            name: 'งานวิ่ง 2026',
            path: folderPath(parent?.path ?? null, id),
          })
          .returning(),
      );
    };

    const newFile = async (ownerId: string, values: Partial<NewDriveFile> = {}) =>
      one(
        await db()
          .insert(schema.files)
          .values({
            ownerId,
            name: 'IMG_0001.JPG',
            mime: 'image/jpeg',
            sizeBytes: 18_734_112,
            s3Key: `originals/${ownerId}/${randomUUID()}/IMG_0001.JPG`,
            ...values,
          })
          .returning(),
      );

    const planId = async (code: string) => {
      await seedPlans(db());
      return one(
        await db()
          .select({ id: schema.plans.id })
          .from(schema.plans)
          .where(eq(schema.plans.code, code)),
      ).id;
    };

    it('creates the ltree extension and is idempotent', async () => {
      const ext = await rows<{ extname: string }>(
        db(),
        sql`SELECT extname FROM pg_extension WHERE extname = 'ltree'`,
      );
      expect(ext).toEqual([{ extname: 'ltree' }]);
      await b.migrateAgain();
    });

    it('seeds the four plans and the trial once, and never overwrites admin edits', async () => {
      const inserted = await seedPlans(db());
      expect(inserted.sort()).toEqual(SEED_PLANS.map((p) => p.code).sort());

      await db()
        .update(schema.plans)
        .set({ priceMonthSatang: 12_900 })
        .where(eq(schema.plans.code, 'starter'));
      expect(await seedPlans(db())).toEqual([]);

      const stored = await db()
        .select({
          code: schema.plans.code,
          quotaBytes: schema.plans.quotaBytes,
          priceMonthSatang: schema.plans.priceMonthSatang,
          priceYearSatang: schema.plans.priceYearSatang,
          trialDays: schema.plans.trialDays,
          isActive: schema.plans.isActive,
        })
        .from(schema.plans);
      for (const seed of SEED_PLANS) {
        const row = stored.find((p) => p.code === seed.code);
        expect(row, seed.code).toEqual({
          code: seed.code,
          quotaBytes: seed.quotaBytes,
          priceMonthSatang: seed.code === 'starter' ? 12_900 : seed.priceMonthSatang,
          priceYearSatang: seed.priceYearSatang,
          trialDays: seed.trialDays,
          isActive: true,
        });
      }
    });

    it('generates time-ordered uuidv7 ids', async () => {
      const user = await newUser();
      expect(user.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('keys identities per Cognito pool and never lets a users-pool identity be an admin', async () => {
      const sub = randomUUID();
      await newUser({ cognitoPool: 'users', cognitoSub: sub, role: 'photographer' });
      // Same sub in the admins pool is a different identity.
      await newUser({ cognitoPool: 'admins', cognitoSub: sub, role: 'admin' });

      expect(await pgError(newUser({ cognitoPool: 'users', cognitoSub: sub }))).toEqual({
        code: UNIQUE,
        constraint: 'users_cognito_identity_unique',
      });
      expect(await pgError(newUser({ cognitoPool: 'users', role: 'admin' }))).toEqual({
        code: CHECK,
        constraint: 'users_admin_iff_admins_pool',
      });
      expect(await pgError(newUser({ cognitoPool: 'admins', role: 'photographer' }))).toEqual({
        code: CHECK,
        constraint: 'users_admin_iff_admins_pool',
      });
    });

    it('allows one live subscription per photographer', async () => {
      const photographer = await newUser();
      const plan = await planId('starter');
      const sub = (status: 'trial' | 'active' | 'expired') =>
        db()
          .insert(schema.subscriptions)
          .values({
            photographerId: photographer.id,
            planId: plan,
            status,
            periodEnd: new Date('2026-12-01T00:00:00Z'),
          });
      await sub('expired');
      await sub('active');
      expect(await pgError(sub('trial'))).toEqual({
        code: UNIQUE,
        constraint: 'subscriptions_one_live_per_photographer',
      });
    });

    it('makes payments unique per (gateway, gateway_ref) so webhooks can upsert', async () => {
      const photographer = await newUser();
      const subscription = one(
        await db()
          .insert(schema.subscriptions)
          .values({
            photographerId: photographer.id,
            planId: await planId('pro'),
            status: 'active',
            periodEnd: new Date('2027-01-01T00:00:00Z'),
          })
          .returning(),
      );
      const payment = {
        subscriptionId: subscription.id,
        amountSatang: 99_000,
        vatSatang: 6_477,
        method: 'promptpay' as const,
        gateway: 'omise',
        gatewayRef: `chrg_${randomUUID()}`,
      };
      await db().insert(schema.payments).values(payment);
      expect(await pgError(db().insert(schema.payments).values(payment))).toEqual({
        code: UNIQUE,
        constraint: 'payments_gateway_ref_unique',
      });

      // The webhook pattern: the same event delivered twice leaves one paid row.
      for (let i = 0; i < 2; i++) {
        await db()
          .insert(schema.payments)
          .values({ ...payment, status: 'paid', paidAt: new Date() })
          .onConflictDoUpdate({
            target: [schema.payments.gateway, schema.payments.gatewayRef],
            set: { status: 'paid', paidAt: new Date() },
          });
      }
      const stored = await db()
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.gatewayRef, payment.gatewayRef));
      expect(stored.map((p) => p.status)).toEqual(['paid']);

      expect(
        await pgError(
          db()
            .insert(schema.payments)
            .values({ ...payment, gatewayRef: randomUUID(), vatSatang: 100_000 }),
        ),
      ).toEqual({ code: CHECK, constraint: 'payments_vat_within_amount' });
    });

    it('stores folder paths as ltree and answers scope queries with <@', async () => {
      const owner = await newUser();
      const root = await newFolder(owner.id, null);
      const child = await newFolder(owner.id, root);
      const grandchild = await newFolder(owner.id, child);
      const otherRoot = await newFolder(owner.id, null);

      const subtree = async (path: string) =>
        (
          await db()
            .select({ id: schema.folders.id })
            .from(schema.folders)
            .where(sql`${schema.folders.path} <@ ${path}::ltree`)
        )
          .map((f) => f.id)
          .sort();
      expect(await subtree(root.path)).toEqual([root.id, child.id, grandchild.id].sort());

      // Move child (and its subtree) under otherRoot: one transaction rewrites the prefix.
      await db().transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE folders
          SET path = ${otherRoot.path}::ltree || subpath(path, nlevel(${child.path}::ltree) - 1)
          WHERE path <@ ${child.path}::ltree AND owner_id = ${owner.id}`);
        await tx
          .update(schema.folders)
          .set({ parentId: otherRoot.id })
          .where(eq(schema.folders.id, child.id));
      });
      expect(await subtree(root.path)).toEqual([root.id]);
      expect(await subtree(otherRoot.path)).toEqual([otherRoot.id, child.id, grandchild.id].sort());

      const gist = await rows<{ indexdef: string }>(
        db(),
        sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'folders_path_gist'`,
      );
      expect(one(gist).indexdef).toContain('USING gist (path)');
    });

    it('rejects folder paths that break the label rules', async () => {
      const owner = await newUser();
      const root = await newFolder(owner.id, null);
      const id = randomUUID();
      const insert = (values: { parentId: string | null; path: string }) =>
        db()
          .insert(schema.folders)
          .values({ id, ownerId: owner.id, name: 'x', ...values });

      expect(
        await pgError(insert({ parentId: null, path: folderPath(null, randomUUID()) })),
      ).toEqual({ code: CHECK, constraint: 'folders_path_ends_with_own_label' });
      expect(await pgError(insert({ parentId: null, path: folderPath(root.path, id) }))).toEqual({
        code: CHECK,
        constraint: 'folders_root_iff_no_parent',
      });
      expect(await pgError(insert({ parentId: root.id, path: folderPath(null, id) }))).toEqual({
        code: CHECK,
        constraint: 'folders_root_iff_no_parent',
      });
    });

    it("keeps folders, files and faces inside their owner's tree", async () => {
      const owner = await newUser();
      const stranger = await newUser();
      const strangersFolder = await newFolder(stranger.id, null);
      const id = randomUUID();

      expect(
        await pgError(
          db()
            .insert(schema.folders)
            .values({
              id,
              ownerId: owner.id,
              parentId: strangersFolder.id,
              name: 'x',
              path: folderPath(strangersFolder.path, id),
            }),
        ),
      ).toEqual({ code: FOREIGN_KEY, constraint: 'folders_parent_same_owner_fk' });

      expect(await pgError(newFile(owner.id, { folderId: strangersFolder.id }))).toEqual({
        code: FOREIGN_KEY,
        constraint: 'files_folder_same_owner_fk',
      });

      const file = await newFile(owner.id);
      const face = {
        fileId: file.id,
        ownerId: owner.id,
        rekognitionFaceId: randomUUID(),
        bbox: { left: 0.1, top: 0.2, width: 0.05, height: 0.07 },
        confidence: 99.98,
      };
      expect(
        await pgError(
          db()
            .insert(schema.faces)
            .values({ ...face, ownerId: stranger.id }),
        ),
      ).toEqual({ code: FOREIGN_KEY, constraint: 'faces_file_same_owner_fk' });
      await db().insert(schema.faces).values(face);
      expect(await pgError(db().insert(schema.faces).values(face))).toEqual({
        code: UNIQUE,
        constraint: 'faces_rekognition_face_id_unique',
      });

      // A file with faces can't be deleted until its faces are (DeleteFaces first).
      expect(await pgError(db().delete(schema.files).where(eq(schema.files.id, file.id)))).toEqual({
        code: RESTRICT,
        constraint: 'faces_file_same_owner_fk',
      });
      await db().delete(schema.faces).where(eq(schema.faces.fileId, file.id));
      await db().delete(schema.files).where(eq(schema.files.id, file.id));
    });

    it('stores byte counts above 2^31 exactly', async () => {
      const owner = await newUser();
      const size = 5 * 1024 ** 3 + 7;
      const file = await newFile(owner.id, { sizeBytes: size, mime: 'video/quicktime' });
      expect(file.sizeBytes).toBe(size);
      await db()
        .insert(schema.storageUsage)
        .values({ photographerId: owner.id, usedBytes: size, reservedBytes: 3 * 1024 ** 3 });
      const usage = one(
        await db()
          .select()
          .from(schema.storageUsage)
          .where(eq(schema.storageUsage.photographerId, owner.id)),
      );
      expect(usage).toEqual({
        photographerId: owner.id,
        usedBytes: size,
        reservedBytes: 3 * 1024 ** 3,
      });
    });

    it('makes share tokens unique and base62', async () => {
      const owner = await newUser();
      const share = {
        ownerId: owner.id,
        targetType: 'folder' as const,
        targetFolderId: (await newFolder(owner.id, null)).id,
        token: '7Hq2LwZ0aXy9KcVb3NmRt1',
      };
      await db().insert(schema.shares).values(share);
      expect(await pgError(db().insert(schema.shares).values(share))).toEqual({
        code: UNIQUE,
        constraint: 'shares_token_unique',
      });
      expect(
        await pgError(
          db()
            .insert(schema.shares)
            .values({ ...share, token: 'not/base62!' }),
        ),
      ).toEqual({ code: CHECK, constraint: 'shares_token_base62' });
    });

    it("ties a share's target to its owner and to target_type", async () => {
      const owner = await newUser();
      const stranger = await newUser();
      const file = await newFile(owner.id);
      const folder = await newFolder(owner.id, null);
      const strangersFile = await newFile(stranger.id);
      const strangersFolder = await newFolder(stranger.id, null);
      const insert = (values: Partial<NewShare>) =>
        db()
          .insert(schema.shares)
          .values({ ownerId: owner.id, targetType: 'file', token: newToken(), ...values })
          .returning();

      const fileShare = one(await insert({ targetType: 'file', targetFileId: file.id }));
      expect(fileShare).toMatchObject({ targetFileId: file.id, targetFolderId: null });
      const folderShare = one(await insert({ targetType: 'folder', targetFolderId: folder.id }));
      expect(folderShare).toMatchObject({ targetFileId: null, targetFolderId: folder.id });

      // Another photographer's file or folder, even with a valid id.
      expect(await pgError(insert({ targetType: 'file', targetFileId: strangersFile.id }))).toEqual(
        {
          code: FOREIGN_KEY,
          constraint: 'shares_target_file_same_owner_fk',
        },
      );
      expect(
        await pgError(insert({ targetType: 'folder', targetFolderId: strangersFolder.id })),
      ).toEqual({ code: FOREIGN_KEY, constraint: 'shares_target_folder_same_owner_fk' });
      // A target that doesn't exist.
      expect(await pgError(insert({ targetType: 'file', targetFileId: randomUUID() }))).toEqual({
        code: FOREIGN_KEY,
        constraint: 'shares_target_file_same_owner_fk',
      });
      // Moving a share to another owner is rejected too.
      expect(
        await pgError(
          db()
            .update(schema.shares)
            .set({ ownerId: stranger.id })
            .where(eq(schema.shares.id, fileShare.id)),
        ),
      ).toEqual({ code: FOREIGN_KEY, constraint: 'shares_target_file_same_owner_fk' });

      // Exactly one target.
      expect(await pgError(insert({ targetType: 'file' }))).toEqual({
        code: CHECK,
        constraint: 'shares_one_target',
      });
      expect(
        await pgError(
          insert({ targetType: 'file', targetFileId: file.id, targetFolderId: folder.id }),
        ),
      ).toEqual({ code: CHECK, constraint: 'shares_one_target' });
      // The one that matches target_type.
      expect(await pgError(insert({ targetType: 'file', targetFolderId: folder.id }))).toEqual({
        code: CHECK,
        constraint: 'shares_target_matches_type',
      });
      expect(await pgError(insert({ targetType: 'folder', targetFileId: file.id }))).toEqual({
        code: CHECK,
        constraint: 'shares_target_matches_type',
      });

      // Purge must remove a target's shares first.
      expect(await pgError(db().delete(schema.files).where(eq(schema.files.id, file.id)))).toEqual({
        code: RESTRICT,
        constraint: 'shares_target_file_same_owner_fk',
      });
      expect(
        await pgError(db().delete(schema.folders).where(eq(schema.folders.id, folder.id))),
      ).toEqual({ code: RESTRICT, constraint: 'shares_target_folder_same_owner_fk' });
    });

    describe('zip jobs', () => {
      const setup = async () => {
        const owner = await newUser();
        const viewer = await newUser({ role: 'user' });
        const folder = await newFolder(owner.id, null);
        const share = one(
          await db()
            .insert(schema.shares)
            .values({
              ownerId: owner.id,
              targetType: 'folder',
              targetFolderId: folder.id,
              token: newToken(),
            })
            .returning(),
        );
        const files = [
          await newFile(owner.id, { folderId: folder.id }),
          await newFile(owner.id, { folderId: folder.id }),
        ];
        return { owner, viewer, share, files };
      };
      const job = (values: NewZipJob) => db().insert(schema.zipJobs).values(values).returning();

      it('stores a job with its entries and finishes it', async () => {
        const { owner, viewer, share, files } = await setup();
        const created = one(
          await job({
            photographerId: owner.id,
            shareId: share.id,
            viewerId: viewer.id,
            downloadSize: 'web',
            fileCount: 2,
            totalBytes: 5 * 1024 ** 3,
            idempotencyKey: 'f3a1c2d4-7a1e-4bd2-9c55-0b8a3e1f2d6c',
          }),
        );
        expect(created).toMatchObject({ status: 'queued', attempts: 0, resultKey: null });
        await db()
          .insert(schema.zipJobEntries)
          .values(
            files.map((file, position) => ({
              jobId: created.id,
              photographerId: owner.id,
              position,
              fileId: file.id,
              name: position === 0 ? 'IMG_0001.jpg' : 'งานวิ่ง 2026.jpg',
            })),
          );

        const finish = (values: Partial<NewZipJob>) =>
          db().update(schema.zipJobs).set(values).where(eq(schema.zipJobs.id, created.id));
        expect(await pgError(finish({ status: 'running' }))).toEqual({
          code: CHECK,
          constraint: 'zip_jobs_started_when_claimed',
        });
        await finish({ status: 'running', startedAt: new Date(), attempts: 1 });
        expect(
          await pgError(
            finish({
              status: 'ready',
              resultKey: 'tmp/zips/other.zip',
              resultBytes: 1,
              completedAt: new Date(),
              expiresAt: new Date(),
            }),
          ),
        ).toEqual({ code: CHECK, constraint: 'zip_jobs_result_key_is_zip_key' });
        expect(await pgError(finish({ status: 'ready', completedAt: new Date() }))).toEqual({
          code: CHECK,
          constraint: 'zip_jobs_ready_has_result',
        });
        await finish({
          status: 'ready',
          resultKey: zipKey(created.id),
          resultBytes: 5 * 1024 ** 3 + 4096,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + 86_400_000),
        });

        const entries = await db()
          .select({ position: schema.zipJobEntries.position, name: schema.zipJobEntries.name })
          .from(schema.zipJobEntries)
          .where(eq(schema.zipJobEntries.jobId, created.id))
          .orderBy(schema.zipJobEntries.position);
        expect(entries).toEqual([
          { position: 0, name: 'IMG_0001.jpg' },
          { position: 1, name: 'งานวิ่ง 2026.jpg' },
        ]);

        // Deleting the job deletes its entries.
        await db().delete(schema.zipJobs).where(eq(schema.zipJobs.id, created.id));
        expect(
          await db()
            .select()
            .from(schema.zipJobEntries)
            .where(eq(schema.zipJobEntries.jobId, created.id)),
        ).toEqual([]);
      });

      it("never mixes photographers: the share and every file must be the job's", async () => {
        const { owner, viewer, share, files } = await setup();
        const other = await setup();
        const base = {
          shareId: share.id,
          anonId: randomUUID(),
          downloadSize: 'original' as const,
          fileCount: 1,
          totalBytes: 0,
        };
        expect(await pgError(job({ ...base, photographerId: other.owner.id }))).toEqual({
          code: FOREIGN_KEY,
          constraint: 'zip_jobs_share_same_owner_fk',
        });
        const created = one(await job({ ...base, photographerId: owner.id }));
        const entry = {
          jobId: created.id,
          photographerId: owner.id,
          position: 0,
          fileId: files[0]?.id ?? '',
          name: 'a.jpg',
        };
        expect(
          await pgError(
            db()
              .insert(schema.zipJobEntries)
              .values({ ...entry, fileId: other.files[0]?.id ?? '' }),
          ),
        ).toEqual({ code: FOREIGN_KEY, constraint: 'zip_job_entries_file_same_photographer_fk' });
        expect(
          await pgError(
            db()
              .insert(schema.zipJobEntries)
              .values({
                ...entry,
                photographerId: other.owner.id,
                fileId: other.files[0]?.id ?? '',
              }),
          ),
        ).toEqual({ code: FOREIGN_KEY, constraint: 'zip_job_entries_job_same_photographer_fk' });

        await db().insert(schema.zipJobEntries).values(entry);
        for (const [values, constraint] of [
          [{ position: 1 }, 'zip_job_entries_file_unique'],
          [{ position: 1, fileId: files[1]?.id ?? '' }, 'zip_job_entries_name_unique'],
        ] as const) {
          expect(
            await pgError(
              db()
                .insert(schema.zipJobEntries)
                .values({ ...entry, ...values }),
            ),
          ).toEqual({ code: UNIQUE, constraint });
        }
        expect(
          await pgError(
            db()
              .insert(schema.zipJobEntries)
              .values({ ...entry, position: 1, fileId: files[1]?.id ?? '', name: 'x'.repeat(256) }),
          ),
        ).toEqual({ code: CHECK, constraint: 'zip_job_entries_name_valid' });

        // A requester is required, and Idempotency-Key is unique per share.
        expect(
          await pgError(job({ ...base, photographerId: owner.id, anonId: undefined })),
        ).toEqual({ code: CHECK, constraint: 'zip_jobs_viewer_or_anon' });
        const keyed = {
          ...base,
          photographerId: owner.id,
          viewerId: viewer.id,
          idempotencyKey: 'k-1',
        };
        await job(keyed);
        expect(await pgError(job(keyed))).toEqual({
          code: UNIQUE,
          constraint: 'zip_jobs_idempotency_unique',
        });
      });

      it('drops the entries of a purged file so the worker can see the job shrank', async () => {
        const { owner, share, files } = await setup();
        const created = one(
          await job({
            photographerId: owner.id,
            shareId: share.id,
            anonId: randomUUID(),
            downloadSize: 'web',
            fileCount: 1,
            totalBytes: 1,
          }),
        );
        const file = files[0];
        if (file === undefined) throw new Error('no file');
        await db().insert(schema.zipJobEntries).values({
          jobId: created.id,
          photographerId: owner.id,
          position: 0,
          fileId: file.id,
          name: 'a.jpg',
        });
        await db().delete(schema.files).where(eq(schema.files.id, file.id));
        expect(
          await db()
            .select()
            .from(schema.zipJobEntries)
            .where(eq(schema.zipJobEntries.jobId, created.id)),
        ).toEqual([]);
      });
    });

    it('requires a viewer or an anonymous session for consent', async () => {
      const owner = await newUser();
      const share = one(
        await db()
          .insert(schema.shares)
          .values({
            ownerId: owner.id,
            targetType: 'file',
            targetFileId: (await newFile(owner.id)).id,
            token: 'Ab3dEf6hIj9kLm2oPq5sTu',
          })
          .returning(),
      );
      const consent = { shareId: share.id, policyVersion: '2026-10', ipHash: 'h' };
      await db()
        .insert(schema.consents)
        .values({ ...consent, anonId: randomUUID() });
      expect(await pgError(db().insert(schema.consents).values(consent))).toEqual({
        code: CHECK,
        constraint: 'consents_viewer_or_anon',
      });
    });

    it('partitions activity_events by UTC month with a default partition', async () => {
      const strategy = await rows<{ partstrat: string }>(
        db(),
        sql`SELECT partstrat FROM pg_partitioned_table
            WHERE partrelid = 'public.activity_events'::regclass`,
      );
      expect(strategy).toEqual([{ partstrat: 'r' }]);
      const partitions = await rows<{ name: string }>(
        db(),
        sql`SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
            WHERE i.inhparent = 'public.activity_events'::regclass`,
      );
      const now = new Date();
      expect(partitions.map((p) => p.name)).toEqual(
        expect.arrayContaining([
          'activity_events_default',
          utcMonthPartition(now, 0),
          utcMonthPartition(now, 1),
          utcMonthPartition(now, 2),
          utcMonthPartition(now, 3),
        ]),
      );
    });

    it('routes events to their month and moves caught rows when a partition is added', async () => {
      const photographer = await newUser();
      const event = (createdAt?: Date) =>
        db()
          .insert(schema.activityEvents)
          .values({
            type: 'scan',
            shareId: randomUUID(),
            photographerId: photographer.id,
            meta: { selfies: 2, strong: 14, maybe: 3 },
            ...(createdAt === undefined ? {} : { createdAt }),
          })
          .returning({ id: schema.activityEvents.id });
      const partitionOf = async (id: number) =>
        one(
          await rows<{ part: string }>(
            db(),
            sql`SELECT tableoid::regclass::text AS part FROM activity_events WHERE id = ${id}`,
          ),
        ).part;

      const current = one(await event());
      expect(await partitionOf(current.id)).toBe(utcMonthPartition(new Date()));

      const future = new Date(Date.UTC(new Date().getUTCFullYear() + 5, 6, 15, 12));
      const caught = one(await event(future));
      expect(await partitionOf(caught.id)).toBe('activity_events_default');

      const ensure = () =>
        rows<{ created: number }>(
          db(),
          sql`SELECT activity_events_ensure_partitions(${future.toISOString()}::timestamptz, 0) AS created`,
        );
      expect(await ensure()).toEqual([{ created: 1 }]);
      expect(await partitionOf(caught.id)).toBe(utcMonthPartition(future));
      expect(await ensure()).toEqual([{ created: 0 }]);

      const stored = one(
        await db()
          .select({ meta: schema.activityEvents.meta, bytes: schema.activityEvents.bytes })
          .from(schema.activityEvents)
          .where(eq(schema.activityEvents.id, caught.id)),
      );
      expect(stored).toEqual({ meta: { selfies: 2, strong: 14, maybe: 3 }, bytes: 0 });
    });
  });
}

describe('migration 0001 on a database with 0000 and existing shares (PGlite)', () => {
  /** A migrations folder with only the first `count` migrations of the journal. */
  function migrationsUpTo(count: number): string {
    const dir = mkdtempSync(join(tmpdir(), 'shotx-migrations-'));
    mkdirSync(join(dir, 'meta'));
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { tag: string }[] };
    const entries = journal.entries.slice(0, count);
    writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
    for (const { tag } of entries) {
      copyFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(dir, `${tag}.sql`));
    }
    return dir;
  }

  async function at0000() {
    const client = await PGlite.create({ extensions: { ltree } });
    const db = drizzlePglite({ client, schema });
    const folder = migrationsUpTo(1);
    await migratePglite(db, { migrationsFolder: folder });
    rmSync(folder, { recursive: true });
    const exec = (query: SQL) => db.execute(query);
    const user = async () => {
      const id = randomUUID();
      await exec(
        sql`INSERT INTO users (id, cognito_pool, cognito_sub, role) VALUES (${id}, 'users', ${id}, 'photographer')`,
      );
      return id;
    };
    const folderOf = async (ownerId: string) => {
      const id = randomUUID();
      await exec(
        sql`INSERT INTO folders (id, owner_id, name, path) VALUES (${id}, ${ownerId}, 'f', ${folderPath(null, id)}::ltree)`,
      );
      return id;
    };
    const fileOf = async (ownerId: string) => {
      const id = randomUUID();
      await exec(
        sql`INSERT INTO files (id, owner_id, name, mime, size_bytes, s3_key) VALUES (${id}, ${ownerId}, 'a.jpg', 'image/jpeg', 1, ${`originals/${ownerId}/${id}/a.jpg`})`,
      );
      return id;
    };
    const legacyShare = (ownerId: string, type: 'file' | 'folder', targetId: string) =>
      exec(
        sql`INSERT INTO shares (owner_id, target_type, target_id, token) VALUES (${ownerId}, ${type}::share_target_type, ${targetId}, ${newToken()})`,
      );
    const migrateAll = () => migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return { client, db, user, folderOf, fileOf, legacyShare, migrateAll };
  }

  it('moves target_id into target_file_id or target_folder_id', async () => {
    const t = await at0000();
    try {
      const owner = await t.user();
      const file = await t.fileOf(owner);
      const folder = await t.folderOf(owner);
      await t.legacyShare(owner, 'file', file);
      await t.legacyShare(owner, 'folder', folder);
      await t.migrateAll();
      const stored = await t.db
        .select({
          targetType: schema.shares.targetType,
          targetFileId: schema.shares.targetFileId,
          targetFolderId: schema.shares.targetFolderId,
        })
        .from(schema.shares)
        .orderBy(schema.shares.targetType);
      expect(stored).toEqual([
        { targetType: 'file', targetFileId: file, targetFolderId: null },
        { targetType: 'folder', targetFileId: null, targetFolderId: folder },
      ]);
    } finally {
      await t.client.close();
    }
  }, 60_000);

  it("fails instead of keeping a share that points at another owner's folder", async () => {
    const t = await at0000();
    try {
      const owner = await t.user();
      const stranger = await t.user();
      await t.legacyShare(owner, 'folder', await t.folderOf(stranger));
      expect(await pgError(t.migrateAll())).toEqual({
        code: FOREIGN_KEY,
        constraint: 'shares_target_folder_same_owner_fk',
      });
      // Nothing of 0001 was applied (one transaction).
      const columns = await rows<{ column_name: string }>(
        t.db,
        sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'shares' AND column_name LIKE 'target%' ORDER BY column_name`,
      );
      expect(columns.map((c) => c.column_name)).toEqual(['target_id', 'target_type']);
    } finally {
      await t.client.close();
    }
  }, 60_000);
});
