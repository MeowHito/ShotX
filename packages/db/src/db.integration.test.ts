import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from './client';
import { loadDatabaseConfig, pgPoolConfig } from './config';
import { folderPath, folderSubtreeMoveSql, planFolderMove } from './ltree';
import { MIGRATIONS_FOLDER, migrateDatabase } from './migrate';
import { driveNameKey, isCoveredByFaceIndex, isFileInShareScope, zipKey } from '@shotx/shared';
import { driveNameKeySql } from './schema/columns';
import * as schema from './schema/index';
import { SEED_PLANS, seedPlans } from './seed';
import {
  coveredByFaceIndexSql,
  fileInShareScopeSql,
  searchableFaceSql,
  shareFaceSearchAvailableSql,
} from './share-scope';
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

const MiB = 1024 * 1024;

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

    // Names are unique among live siblings (migration 0002), so helpers default to unique ones.
    const newFolder = async (
      ownerId: string,
      parent: { id: string; path: string } | null,
      name = `งานวิ่ง ${randomUUID()}`,
    ) => {
      const id = randomUUID();
      return one(
        await db()
          .insert(schema.folders)
          .values({
            id,
            ownerId,
            parentId: parent?.id ?? null,
            name,
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
            name: `IMG_${randomUUID()}.JPG`,
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
          [{ position: 1, fileId: files[1]?.id ?? '' }, 'zip_job_entries_name_folded_unique'],
          // Names collide ignoring ASCII case, like uniqueZipEntryNames.
          [
            { position: 1, fileId: files[1]?.id ?? '', name: 'A.JPG' },
            'zip_job_entries_name_folded_unique',
          ],
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

    describe('drive (migration 0002)', () => {
      const rename = (id: string, name: string) =>
        db().update(schema.folders).set({ name }).where(eq(schema.folders.id, id));

      it('makes live folder names unique per parent, ignoring ASCII case only', async () => {
        const owner = await newUser();
        const stranger = await newUser();
        const event = await newFolder(owner.id, null, 'Event');
        const nested = await newFolder(owner.id, event, 'Event');

        for (const parent of [null, event]) {
          expect(await pgError(newFolder(owner.id, parent, 'EVENT'))).toEqual({
            code: UNIQUE,
            constraint: 'folders_live_name_unique',
          });
        }
        // Another owner, another case-sensitive letter outside ASCII, or Thai: no conflict.
        await newFolder(stranger.id, null, 'event');
        await newFolder(owner.id, null, 'Äpfel');
        await newFolder(owner.id, null, 'äpfel');
        await newFolder(owner.id, null, 'งานวิ่ง');
        expect(await pgError(newFolder(owner.id, null, 'งานวิ่ง'))).toMatchObject({ code: UNIQUE });

        // Trashed folders don't hold their name.
        await db()
          .update(schema.folders)
          .set({ deletedAt: new Date() })
          .where(eq(schema.folders.id, nested.id));
        await newFolder(owner.id, event, 'event');
        expect(await pgError(rename(event.id, 'äpfel'))).toEqual({
          code: UNIQUE,
          constraint: 'folders_live_name_unique',
        });
      });

      it('makes live file names unique per folder and at the root; failed files free theirs', async () => {
        const owner = await newUser();
        const folder = await newFolder(owner.id, null, 'IMG_0001.JPG');
        for (const folderId of [null, folder.id]) {
          const first = await newFile(owner.id, { folderId, name: 'IMG_0001.JPG' });
          expect(await pgError(newFile(owner.id, { folderId, name: 'img_0001.jpg' }))).toEqual({
            code: UNIQUE,
            constraint: 'files_live_name_unique',
          });
          await db()
            .update(schema.files)
            .set({ status: 'failed' })
            .where(eq(schema.files.id, first.id));
          await newFile(owner.id, { folderId, name: 'img_0001.jpg' });
        }
      });

      it('computes the same name key as driveNameKey', async () => {
        const names = ['IMG_0001.JPG', 'ÄbC', 'İstanbul', 'งานวิ่ง ABC', 'ǅ'];
        for (const name of names) {
          const [row] = await rows<{ key: string }>(
            db(),
            sql`SELECT ${driveNameKeySql(sql`${name}::text`)} AS key`,
          );
          expect(row?.key, name).toBe(driveNameKey(name));
        }
      });

      it('moves a subtree, trashed descendants included, with one statement', async () => {
        const owner = await newUser();
        const stranger = await newUser();
        const a = await newFolder(owner.id, null);
        const b = await newFolder(owner.id, a);
        const c = await newFolder(owner.id, b);
        const target = await newFolder(owner.id, null);
        await db()
          .update(schema.folders)
          .set({ deletedAt: new Date() })
          .where(eq(schema.folders.id, c.id));
        // Same subtree shape for another owner: must not be touched.
        const foreign = await newFolder(stranger.id, null);

        const pathsOf = async () =>
          Object.fromEntries(
            (
              await db()
                .select({
                  id: schema.folders.id,
                  path: schema.folders.path,
                  parentId: schema.folders.parentId,
                })
                .from(schema.folders)
                .where(
                  sql`${schema.folders.id} IN (${sql.join(
                    [a.id, b.id, c.id, foreign.id].map((id) => sql`${id}::uuid`),
                    sql`, `,
                  )})`,
                )
            ).map((f) => [f.id, { path: f.path, parentId: f.parentId }]),
          );

        const move = (
          newParent: { id: string; path: string } | null,
          folder: { id: string; path: string; parentId: string | null },
        ) => {
          const result = planFolderMove({ folder, newParent, subtreeMaxDepth: 3, maxDepth: 32 });
          if (!result.ok) throw new Error(result.code);
          return db().execute(folderSubtreeMoveSql(owner.id, result.plan));
        };

        await move(target, b);
        const moved = await pathsOf();
        expect(moved[b.id]).toEqual({ path: folderPath(target.path, b.id), parentId: target.id });
        expect(moved[c.id]).toEqual({
          path: folderPath(folderPath(target.path, b.id), c.id),
          parentId: b.id,
        });
        expect(moved[a.id]).toEqual({ path: a.path, parentId: null });
        expect(moved[foreign.id]).toEqual({ path: foreign.path, parentId: null });

        await move(null, { id: b.id, path: folderPath(target.path, b.id), parentId: target.id });
        const atRoot = await pathsOf();
        expect(atRoot[b.id]).toEqual({ path: folderPath(null, b.id), parentId: null });
        expect(atRoot[c.id]).toEqual({
          path: folderPath(folderPath(null, b.id), c.id),
          parentId: b.id,
        });
      });

      it('keeps trash and upload fields consistent', async () => {
        const owner = await newUser();
        const folder = await newFolder(owner.id, null);
        const setFolder = (values: Partial<typeof schema.folders.$inferInsert>) =>
          db().update(schema.folders).set(values).where(eq(schema.folders.id, folder.id));
        expect(await pgError(setFolder({ purgeRequestedAt: new Date() }))).toEqual({
          code: CHECK,
          constraint: 'folders_trash_fields_need_deleted',
        });
        expect(
          await pgError(setFolder({ deletedAt: new Date(), trashedViaFolderId: folder.id })),
        ).toEqual({ code: CHECK, constraint: 'folders_trashed_via_not_self' });

        expect(await pgError(newFile(owner.id, { trashedViaFolderId: folder.id }))).toEqual({
          code: CHECK,
          constraint: 'files_trash_fields_need_deleted',
        });
        expect(await pgError(newFile(owner.id, { uploadId: 'upload-1' }))).toEqual({
          code: CHECK,
          constraint: 'files_upload_id_while_uploading',
        });
        expect(
          await pgError(
            newFile(owner.id, {
              uploadId: 'upload-1',
              uploadExpiresAt: new Date(),
              status: 'ready',
            }),
          ),
        ).toEqual({ code: CHECK, constraint: 'files_upload_id_while_uploading' });
        expect(
          await pgError(newFile(owner.id, { uploadId: 'upload-1', uploadExpiresAt: new Date() })),
        ).toEqual({ code: CHECK, constraint: 'files_upload_part_bytes_valid' });
        await newFile(owner.id, {
          uploadId: 'upload-1',
          uploadExpiresAt: new Date(),
          uploadPartBytes: 16 * MiB,
        });
      });
    });

    describe('sharing and face search (migration 0003)', () => {
      const now = new Date();
      const inDays = (days: number) => new Date(now.getTime() + days * 86_400_000);

      const newShare = async (ownerId: string, target: Partial<NewShare>) =>
        one(
          await db()
            .insert(schema.shares)
            .values({ ownerId, targetType: 'folder', token: newToken(), ...target })
            .returning(),
        );

      it('makes client upload ids unique per owner only', async () => {
        const a = await newUser();
        const b = await newUser();
        const clientUploadId = randomUUID();
        await newFile(a.id, { clientUploadId });
        expect(await pgError(newFile(a.id, { clientUploadId }))).toEqual({
          code: UNIQUE,
          constraint: 'files_client_upload_id_unique',
        });
        await newFile(b.id, { clientUploadId });
        await newFile(a.id, { clientUploadId: null });
        await newFile(a.id, { clientUploadId: null });
      });

      it('keeps the upload part size within S3 limits', async () => {
        const owner = await newUser();
        const open = { uploadId: 'u', uploadExpiresAt: new Date() };
        for (const uploadPartBytes of [5 * MiB - 1, 5 * 1024 * MiB + 1]) {
          expect(await pgError(newFile(owner.id, { ...open, uploadPartBytes }))).toEqual({
            code: CHECK,
            constraint: 'files_upload_part_bytes_valid',
          });
        }
        await newFile(owner.id, { ...open, uploadPartBytes: 5 * 1024 * MiB });
        expect(await pgError(newFile(owner.id, { webSizeBytes: -1 }))).toEqual({
          code: CHECK,
          constraint: 'files_web_size_nonnegative',
        });
      });

      it('enables face indexing only with the attendees-informed confirmation', async () => {
        const owner = await newUser();
        const folder = await newFolder(owner.id, null);
        const set = (values: Partial<typeof schema.folders.$inferInsert>) =>
          db().update(schema.folders).set(values).where(eq(schema.folders.id, folder.id));
        expect(
          await pgError(set({ faceIndexEnabled: true, faceIndexExpiresAt: inDays(90) })),
        ).toEqual({ code: CHECK, constraint: 'folders_face_index_needs_confirmation' });
        expect(await pgError(set({ faceIndexEnabled: true, faceIndexInformedAt: now }))).toEqual({
          code: CHECK,
          constraint: 'folders_face_index_needs_confirmation',
        });
        await set({
          faceIndexEnabled: true,
          faceIndexInformedAt: now,
          faceIndexExpiresAt: inDays(90),
        });
        await set({ faceIndexEnabled: false, faceIndexExpiresAt: null });
      });

      it('keeps one current consent per share, viewer or session and version', async () => {
        const owner = await newUser();
        const viewer = await newUser({ role: 'user' });
        const share = await newShare(owner.id, {
          targetType: 'file',
          targetFileId: (await newFile(owner.id)).id,
        });
        const anonId = randomUUID();
        const consent = { shareId: share.id, policyVersion: '2026-10-25', ipHash: 'v1:h' };
        await db()
          .insert(schema.consents)
          .values({ ...consent, anonId });
        expect(
          await pgError(
            db()
              .insert(schema.consents)
              .values({ ...consent, anonId }),
          ),
        ).toEqual({ code: UNIQUE, constraint: 'consents_current_anon_unique' });
        // Idempotent upsert: the conflict is skipped.
        await db()
          .insert(schema.consents)
          .values({ ...consent, anonId })
          .onConflictDoNothing();
        // Withdrawal frees the slot; history stays.
        await db()
          .update(schema.consents)
          .set({ withdrawnAt: new Date() })
          .where(eq(schema.consents.anonId, anonId));
        await db()
          .insert(schema.consents)
          .values({ ...consent, anonId });
        await db()
          .insert(schema.consents)
          .values({ ...consent, policyVersion: '2027-01-01', anonId });
        await db()
          .insert(schema.consents)
          .values({ ...consent, viewerId: viewer.id });
        expect(
          await pgError(
            db()
              .insert(schema.consents)
              .values({ ...consent, viewerId: viewer.id }),
          ),
        ).toEqual({ code: UNIQUE, constraint: 'consents_current_viewer_unique' });
        expect(
          await pgError(
            db()
              .insert(schema.consents)
              .values({ ...consent, viewerId: viewer.id, anonId: randomUUID() }),
          ),
        ).toEqual({ code: CHECK, constraint: 'consents_viewer_or_anon' });
        expect(
          await pgError(
            db()
              .insert(schema.consents)
              .values({
                ...consent,
                anonId: randomUUID(),
                acceptedAt: now,
                withdrawnAt: new Date(now.getTime() - 1000),
              }),
          ),
        ).toEqual({ code: CHECK, constraint: 'consents_withdrawn_after_accepted' });
      });

      it('records owner downloads without a share, on every partition', async () => {
        const photographer = await newUser();
        const insert = (values: Partial<typeof schema.activityEvents.$inferInsert>) =>
          db()
            .insert(schema.activityEvents)
            .values({
              type: 'download',
              photographerId: photographer.id,
              fileId: randomUUID(),
              ...values,
            });
        await insert({ source: 'owner', shareId: null, bytes: 10 });
        await insert({ shareId: randomUUID(), anonId: randomUUID() });
        await insert({ source: 'owner', shareId: null, createdAt: new Date(Date.UTC(2099, 0, 1)) });
        for (const values of [
          { source: 'owner' as const, shareId: randomUUID() },
          { source: 'share' as const, shareId: null },
          { source: 'owner' as const, shareId: null, anonId: randomUUID() },
        ]) {
          expect(await pgError(insert(values))).toMatchObject({ code: CHECK });
        }
      });

      it('marks faces for deletion only within their owner', async () => {
        const owner = await newUser();
        const other = await newUser();
        const file = await newFile(owner.id, { status: 'ready' });
        const face = one(
          await db()
            .insert(schema.faces)
            .values({
              fileId: file.id,
              ownerId: owner.id,
              rekognitionFaceId: randomUUID(),
              bbox: { left: 0.1, top: 0.1, width: 0.2, height: 0.2 },
              confidence: 99.9,
            })
            .returning(),
        );
        const deletion = (photographerId: string) =>
          db()
            .insert(schema.faceDeletions)
            .values({ photographerId, shareId: randomUUID(), facesMatched: 1 })
            .returning();
        const mine = one(await deletion(owner.id));
        const theirs = one(await deletion(other.id));
        const mark = (deletionId: string) =>
          db().update(schema.faces).set({ deletionId }).where(eq(schema.faces.id, face.id));
        expect(await pgError(mark(theirs.id))).toEqual({
          code: FOREIGN_KEY,
          constraint: 'faces_deletion_same_owner_fk',
        });
        await mark(mine.id);
        const searchable = await db()
          .select({ id: schema.faces.id })
          .from(schema.faces)
          .where(and(eq(schema.faces.fileId, file.id), searchableFaceSql()));
        expect(searchable).toEqual([]);
        expect(
          await pgError(
            db()
              .update(schema.faceDeletions)
              .set({ completedAt: new Date() })
              .where(eq(schema.faceDeletions.id, mine.id)),
          ),
        ).toEqual({ code: CHECK, constraint: 'face_deletions_completed_has_count' });
      });

      it('keeps share stats and zip URL issue consistent', async () => {
        const owner = await newUser();
        const other = await newUser();
        const share = await newShare(owner.id, {
          targetType: 'file',
          targetFileId: (await newFile(owner.id)).id,
        });
        await db()
          .insert(schema.shareDailyStats)
          .values({ shareId: share.id, photographerId: owner.id, date: '2026-10-25', visitors: 3 });
        expect(
          await pgError(
            db()
              .insert(schema.shareDailyStats)
              .values({ shareId: share.id, photographerId: other.id, date: '2026-10-26' }),
          ),
        ).toEqual({ code: FOREIGN_KEY, constraint: 'share_daily_stats_share_same_owner_fk' });
        expect(
          await pgError(
            db().insert(schema.zipJobs).values({
              photographerId: owner.id,
              shareId: share.id,
              anonId: randomUUID(),
              downloadSize: 'web',
              fileCount: 1,
              totalBytes: 1,
              urlIssuedAt: new Date(),
            }),
          ),
        ).toEqual({ code: CHECK, constraint: 'zip_jobs_url_issued_when_ready' });
      });

      describe('scope SQL agrees with the shared rules', () => {
        it('serves ready, live files inside the root, and follows moves', async () => {
          const owner = await newUser();
          const a = await newFolder(owner.id, null);
          const b = await newFolder(owner.id, a);
          const c = await newFolder(owner.id, null);
          const inB = await newFile(owner.id, { folderId: b.id, status: 'ready' });
          const inA = await newFile(owner.id, { folderId: a.id, status: 'ready' });
          await newFile(owner.id, { folderId: c.id, status: 'ready' });
          await newFile(owner.id, { folderId: b.id, status: 'processing' });
          await newFile(owner.id, { folderId: b.id, status: 'ready', deletedAt: new Date() });
          await newFile(owner.id, { folderId: null, status: 'ready' });
          const share = {
            ownerId: owner.id,
            targetType: 'folder' as const,
            targetFileId: null,
            targetFolderId: a.id,
          };
          const inScope = async () =>
            (
              await db()
                .select({ id: schema.files.id })
                .from(schema.files)
                .where(fileInShareScopeSql(share))
            )
              .map((r) => r.id)
              .sort();
          expect(await inScope()).toEqual([inA.id, inB.id].sort());

          // The same answer from the pure rule, file by file.
          const fileRows = await rows<{
            id: string;
            status: string;
            deleted: boolean;
            path: string | null;
          }>(
            db(),
            sql`SELECT f.id, f.status, f.deleted_at IS NOT NULL AS deleted, d.path::text AS path
                FROM files f LEFT JOIN folders d ON d.id = f.folder_id WHERE f.owner_id = ${owner.id}`,
          );
          const pure = fileRows
            .filter((r) =>
              isFileInShareScope(share, a.path, {
                id: r.id,
                ownerId: owner.id,
                status: r.status as 'ready',
                deletedAt: r.deleted ? new Date() : null,
                purgeRequestedAt: null,
                folderPath: r.path,
              }),
            )
            .map((r) => r.id)
            .sort();
          expect(pure).toEqual(await inScope());

          // Move b under c: its files leave a's scope at once.
          const move = planFolderMove({
            folder: b,
            newParent: c,
            subtreeMaxDepth: 2,
            maxDepth: 32,
          });
          if (!move.ok) throw new Error('move rejected');
          await db().execute(folderSubtreeMoveSql(owner.id, move.plan));
          expect(await inScope()).toEqual([inA.id]);

          // A trashed root serves nothing.
          await db()
            .update(schema.folders)
            .set({ deletedAt: new Date() })
            .where(eq(schema.folders.id, a.id));
          expect(await inScope()).toEqual([]);

          const fileShare = {
            ...share,
            targetType: 'file' as const,
            targetFileId: inA.id,
            targetFolderId: null,
          };
          expect(
            await db()
              .select({ id: schema.files.id })
              .from(schema.files)
              .where(fileInShareScopeSql(fileShare)),
          ).toEqual([{ id: inA.id }]);
        });

        it('finds face-index coverage above and below a share root', async () => {
          const owner = await newUser();
          const event = await newFolder(owner.id, null);
          const day1 = await newFolder(owner.id, event);
          const other = await newFolder(owner.id, null);
          const enable = (id: string, expiresAt: Date) =>
            db()
              .update(schema.folders)
              .set({
                faceIndexEnabled: true,
                faceIndexInformedAt: now,
                faceIndexExpiresAt: expiresAt,
              })
              .where(eq(schema.folders.id, id));
          const covered = async () =>
            (
              await db()
                .select({ id: schema.folders.id })
                .from(schema.folders)
                .where(
                  and(
                    eq(schema.folders.ownerId, owner.id),
                    coveredByFaceIndexSql(schema.folders.path, schema.folders.ownerId, now),
                  ),
                )
            )
              .map((r) => r.id)
              .sort();
          const available = async (folderId: string) =>
            one(
              await rows<{ ok: boolean }>(
                db(),
                sql`SELECT ${shareFaceSearchAvailableSql({ ownerId: owner.id, targetFolderId: folderId }, now)} AS ok`,
              ),
            ).ok;

          expect(await covered()).toEqual([]);
          expect(await available(event.id)).toBe(false);

          await enable(day1.id, inDays(90));
          expect(await covered()).toEqual([day1.id]);
          expect(await available(event.id)).toBe(true); // an index below the root
          expect(await available(day1.id)).toBe(true);
          expect(await available(other.id)).toBe(false);

          await enable(event.id, inDays(-1)); // expired: covers nothing
          expect(await covered()).toEqual([day1.id]);
          await enable(event.id, inDays(30));
          expect(await covered()).toEqual([event.id, day1.id].sort());
          expect(
            isCoveredByFaceIndex(
              day1.path,
              [
                {
                  path: event.path,
                  faceIndexEnabled: true,
                  faceIndexExpiresAt: inDays(30),
                  deletedAt: null,
                },
              ],
              now,
            ),
          ).toBe(true);
        });
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

describe('migration 0003 on a database with 0002 and existing rows (PGlite)', () => {
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

  it('backfills part sizes, turns off unconfirmed face indexes and dedupes consents', async () => {
    const client = await PGlite.create({ extensions: { ltree } });
    try {
      const db = drizzlePglite({ client, schema });
      const folder = migrationsUpTo(3);
      await migratePglite(db, { migrationsFolder: folder });
      rmSync(folder, { recursive: true });
      const exec = (query: SQL) => db.execute(query);

      const owner = randomUUID();
      await exec(
        sql`INSERT INTO users (id, cognito_pool, cognito_sub, role) VALUES (${owner}, 'users', ${owner}, 'photographer')`,
      );
      const folderId = randomUUID();
      await exec(
        sql`INSERT INTO folders (id, owner_id, name, path, face_index_enabled, face_index_expires_at)
            VALUES (${folderId}, ${owner}, 'f', ${folderPath(null, folderId)}::ltree, true, now() + interval '90 days')`,
      );
      const file = async (size: number, open: boolean) => {
        const id = randomUUID();
        await exec(
          sql`INSERT INTO files (id, owner_id, name, mime, size_bytes, s3_key, upload_id, upload_expires_at)
              VALUES (${id}, ${owner}, ${`${id}.jpg`}, 'image/jpeg', ${size}, ${`originals/${owner}/${id}/a.jpg`},
                      ${open ? 'u' : null}, ${open ? sql`now() + interval '1 day'` : null})`,
        );
        return id;
      };
      const small = await file(1, true);
      const huge = await file(300 * 1024 * MiB, true);
      const done = await file(1, false);
      const shareId = randomUUID();
      await exec(
        sql`INSERT INTO shares (id, owner_id, target_type, target_file_id, token) VALUES (${shareId}, ${owner}, 'file', ${done}, ${newToken()})`,
      );
      const anon = randomUUID();
      const viewer = randomUUID();
      await exec(
        sql`INSERT INTO users (id, cognito_pool, cognito_sub, role) VALUES (${viewer}, 'users', ${viewer}, 'user')`,
      );
      const consent = (anonId: string | null, viewerId: string | null, acceptedAt: string) =>
        exec(
          sql`INSERT INTO consents (share_id, viewer_id, anon_id, policy_version, ip_hash, accepted_at)
              VALUES (${shareId}, ${viewerId}, ${anonId}, '2026-10-25', 'h', ${acceptedAt}::timestamptz)`,
        );
      await consent(anon, null, '2026-10-01T00:00:00Z');
      await consent(anon, null, '2026-10-02T00:00:00Z');
      await consent(randomUUID(), viewer, '2026-10-03T00:00:00Z');

      await migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });

      const parts = await rows<{ id: string; part: number | null }>(
        db,
        sql`SELECT id, upload_part_bytes::float8 AS part FROM files`,
      );
      const partOf = (id: string) => parts.find((p) => p.id === id)?.part;
      expect(partOf(small)).toBe(16 * MiB);
      expect(partOf(huge)).toBe(31 * MiB);
      expect(partOf(done)).toBeNull();

      const folders = await rows<{ enabled: boolean }>(
        db,
        sql`SELECT face_index_enabled AS enabled FROM folders WHERE id = ${folderId}`,
      );
      expect(folders).toEqual([{ enabled: false }]);

      const consents = await rows<{ anon: string | null; viewer: string | null; current: boolean }>(
        db,
        sql`SELECT anon_id AS anon, viewer_id AS viewer, withdrawn_at IS NULL AS current
            FROM consents ORDER BY accepted_at`,
      );
      expect(consents).toEqual([
        { anon, viewer: null, current: false },
        { anon, viewer: null, current: true },
        { anon: null, viewer, current: true },
      ]);
    } finally {
      await client.close();
    }
  }, 120_000);
});
