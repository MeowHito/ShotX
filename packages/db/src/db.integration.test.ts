import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
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
import {
  ADMIN_AUDIT_ACTIONS,
  AUTH_AUDIT_ACTIONS,
  DESIGN_TEMPLATES,
  designDocSchema,
  driveNameKey,
  isCoveredByFaceIndex,
  isFileInShareScope,
  isShareSlug,
  parseShareRef,
  slugifyEventName,
  withShareSlugSuffix,
  zipKey,
  driveSearchPattern,
} from '@shotx/shared';
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
  const client = await PGlite.create({ extensions: { ltree, pg_trgm, vector } });
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
            authPool: 'users',
            authSubject: randomUUID(),
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

    it('keys identities per auth pool and never lets a users-pool identity be an admin', async () => {
      const sub = randomUUID();
      await newUser({ authPool: 'users', authSubject: sub, role: 'photographer' });
      // Same sub in the admins pool is a different identity.
      await newUser({ authPool: 'admins', authSubject: sub, role: 'admin' });

      expect(await pgError(newUser({ authPool: 'users', authSubject: sub }))).toEqual({
        code: UNIQUE,
        constraint: 'users_auth_identity_unique',
      });
      expect(await pgError(newUser({ authPool: 'users', role: 'admin' }))).toEqual({
        code: CHECK,
        constraint: 'users_admin_iff_admins_pool',
      });
      expect(await pgError(newUser({ authPool: 'admins', role: 'photographer' }))).toEqual({
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
        photographerId: photographer.id,
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

    it('keeps billing consistent: one pending checkout, one open renewal, auto-renew needs a method', async () => {
      const photographer = await newUser();
      const plan = await planId('standard');
      const subscription = one(
        await db()
          .insert(schema.subscriptions)
          .values({
            photographerId: photographer.id,
            planId: plan,
            status: 'active',
            periodEnd: new Date('2027-01-01T00:00:00Z'),
          })
          .returning(),
      );
      const checkout = (key: string) =>
        db()
          .insert(schema.checkoutSessions)
          .values({
            photographerId: photographer.id,
            subscriptionId: subscription.id,
            changeType: 'renew',
            planId: plan,
            method: 'promptpay',
            months: 1,
            amountSatang: 39_000,
            vatSatang: 2_551,
            gateway: 'fake',
            idempotencyKey: key,
            requestSha256: 'a'.repeat(64),
            expiresAt: new Date(Date.now() + 15 * 60_000),
          })
          .returning();
      const first = one(await checkout('k-1'));
      expect(await pgError(checkout('k-1'))).toEqual({
        code: UNIQUE,
        constraint: 'checkout_sessions_idempotency_unique',
      });
      expect(await pgError(checkout('k-2'))).toEqual({
        code: UNIQUE,
        constraint: 'checkout_sessions_one_pending_per_photographer',
      });
      await db()
        .update(schema.checkoutSessions)
        .set({ status: 'expired', finishedAt: new Date() })
        .where(eq(schema.checkoutSessions.id, first.id));
      one(await checkout('k-2'));

      const renewal = (status: 'pending' | 'failed') =>
        db()
          .insert(schema.payments)
          .values({
            photographerId: photographer.id,
            subscriptionId: subscription.id,
            renewalPeriodEnd: subscription.periodEnd,
            amountSatang: 39_000,
            vatSatang: 2_551,
            method: 'card',
            gateway: 'fake',
            gatewayRef: `chrg_${randomUUID()}`,
            status,
          });
      await renewal('failed');
      await renewal('pending');
      expect(await pgError(renewal('pending'))).toEqual({
        code: UNIQUE,
        constraint: 'payments_one_open_renewal',
      });

      expect(
        await pgError(
          db()
            .update(schema.subscriptions)
            .set({ billing: 'auto_renew' })
            .where(eq(schema.subscriptions.id, subscription.id)),
        ),
      ).toEqual({ code: CHECK, constraint: 'subscriptions_auto_renew_has_method' });
      await db()
        .update(schema.subscriptions)
        .set({
          billing: 'auto_renew',
          autoRenewMonths: 1,
          paymentMethodGateway: 'fake',
          paymentMethodRef: 'card_123',
        })
        .where(eq(schema.subscriptions.id, subscription.id));
      expect(
        await pgError(
          db()
            .update(schema.subscriptions)
            .set({ pendingPlanId: plan })
            .where(eq(schema.subscriptions.id, subscription.id)),
        ),
      ).toEqual({ code: CHECK, constraint: 'subscriptions_pending_plan_complete' });

      const event = {
        gateway: 'fake',
        eventRef: `evt_${randomUUID()}`,
        gatewayRef: 'chrg_1',
        type: 'paid' as const,
        amountSatang: 39_000,
        payloadSha256: 'b'.repeat(64),
        verifiedAt: new Date(),
      };
      await db().insert(schema.paymentWebhookEvents).values(event);
      const replay = await db()
        .insert(schema.paymentWebhookEvents)
        .values(event)
        .onConflictDoNothing()
        .returning();
      expect(replay).toEqual([]);
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
              .values({
                ...entry,
                position: 1,
                fileId: files[1]?.id ?? '',
                name: 'x'.repeat(1025),
              }),
          ),
        ).toEqual({ code: CHECK, constraint: 'zip_job_entries_name_valid' });
        // Owner folder zips (migration 0008) keep relative paths, never escaping the archive.
        for (const name of [
          '/a.jpg',
          'a/',
          'a//b.jpg',
          '../a.jpg',
          'a/../b.jpg',
          './a.jpg',
          'a/./b.jpg',
          '..',
        ]) {
          expect(
            await pgError(
              db()
                .insert(schema.zipJobEntries)
                .values({ ...entry, position: 1, fileId: files[1]?.id ?? '', name }),
            ),
            name,
          ).toEqual({ code: CHECK, constraint: 'zip_job_entries_name_valid' });
        }
        await db()
          .insert(schema.zipJobEntries)
          .values({ ...entry, position: 1, fileId: files[1]?.id ?? '', name: 'Day 1/a.jpg' });

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

      it('holds owner jobs (migration 0008): no share, the owner as viewer, an archive name', async () => {
        const { owner, viewer, share } = await setup();
        const ownerJob = {
          photographerId: owner.id,
          viewerId: owner.id,
          downloadSize: 'original' as const,
          fileCount: 1,
          totalBytes: 0,
          archiveName: 'งานวิ่ง 2026.zip',
          sourceFolderId: randomUUID(),
        };
        const created = one(await job(ownerJob));
        expect(created).toMatchObject({ shareId: null, archiveName: 'งานวิ่ง 2026.zip' });
        for (const [values, constraint] of [
          [{ viewerId: viewer.id }, 'zip_jobs_owner_job_shape'],
          [{ anonId: randomUUID() }, 'zip_jobs_owner_job_shape'],
          [{ archiveName: null }, 'zip_jobs_owner_job_shape'],
          [{ archiveName: 'a/b.zip' }, 'zip_jobs_archive_name_valid'],
          [{ archiveName: 'folder.tar' }, 'zip_jobs_archive_name_valid'],
        ] as const) {
          expect(await pgError(job({ ...ownerJob, ...values })), constraint).toEqual({
            code: CHECK,
            constraint,
          });
        }
        // Share jobs never carry owner-job fields.
        expect(
          await pgError(
            job({
              photographerId: owner.id,
              shareId: share.id,
              anonId: randomUUID(),
              downloadSize: 'web',
              fileCount: 1,
              totalBytes: 0,
              archiveName: 'x.zip',
            }),
          ),
        ).toEqual({ code: CHECK, constraint: 'zip_jobs_owner_job_shape' });
        // Idempotency-Key: unique per photographer among owner jobs.
        await job({ ...ownerJob, idempotencyKey: 'owner-k' });
        expect(await pgError(job({ ...ownerJob, idempotencyKey: 'owner-k' }))).toEqual({
          code: UNIQUE,
          constraint: 'zip_jobs_owner_idempotency_unique',
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

    describe('studio search and copies (migration 0008)', () => {
      it('finds names containing the query, ignoring ASCII case, Thai as typed, per owner', async () => {
        const owner = await newUser();
        const stranger = await newUser();
        const folder = await newFolder(owner.id, null, 'งานวิ่ง Bangkok 2026');
        await newFile(owner.id, { folderId: folder.id, name: 'IMG_0001.JPG' });
        await newFile(owner.id, { folderId: folder.id, name: 'ภาพวิ่ง_100%.jpg' });
        await newFile(stranger.id, { folderId: null, name: 'img_0001.jpg' });
        const names = async (q: string) =>
          (
            await db()
              .select({ name: schema.files.name })
              .from(schema.files)
              .where(
                and(
                  eq(schema.files.ownerId, owner.id),
                  sql`${driveNameKeySql(schema.files.name)} LIKE ${driveSearchPattern(q)} ESCAPE '\\'`,
                ),
              )
          )
            .map((r) => r.name)
            .sort();
        expect(await names('img_0001')).toEqual(['IMG_0001.JPG']);
        expect(await names(' IMG ')).toEqual(['IMG_0001.JPG']);
        expect(await names('วิ่ง')).toEqual(['ภาพวิ่ง_100%.jpg']);
        // `%` and `_` are literal.
        expect(await names('100%')).toEqual(['ภาพวิ่ง_100%.jpg']);
        expect(await names('G_0')).toEqual(['IMG_0001.JPG']);
        expect(await names('x_x')).toEqual([]);
        const folders = await db()
          .select({ id: schema.folders.id })
          .from(schema.folders)
          .where(
            and(
              eq(schema.folders.ownerId, owner.id),
              sql`${driveNameKeySql(schema.folders.name)} LIKE ${driveSearchPattern('BANGKOK')} ESCAPE '\\'`,
            ),
          );
        expect(folders.map((f) => f.id)).toEqual([folder.id]);
      });

      it('keeps withheld files out of the coverage scan (migration 0009)', async () => {
        const owner = await newUser();
        const folder = await newFolder(owner.id, null, 'Run');
        const kept = await newFile(owner.id, {
          folderId: folder.id,
          name: 'a.jpg',
          status: 'ready',
        });
        const withheld = await newFile(owner.id, {
          folderId: folder.id,
          name: 'b.jpg',
          status: 'ready',
          facesWithheldAt: new Date(),
        });
        // The scan's predicate, exactly as files_unindexed_ready_idx has it.
        const candidates = await db()
          .select({ id: schema.files.id })
          .from(schema.files)
          .where(
            and(
              eq(schema.files.folderId, folder.id),
              sql`${schema.files.status} = 'ready' AND ${schema.files.faceCount} IS NULL AND ${schema.files.facesQueuedAt} IS NULL AND ${schema.files.deletedAt} IS NULL AND ${schema.files.facesWithheldAt} IS NULL`,
            ),
          );
        expect(candidates.map((c) => c.id)).toEqual([kept.id]);
        expect(withheld.facesWithheldAt).not.toBeNull();
      });

      it('records the source of a copy, never itself', async () => {
        const owner = await newUser();
        const source = await newFile(owner.id, { folderId: null, name: 'a.jpg' });
        const copy = await newFile(owner.id, {
          folderId: null,
          name: 'a (2).jpg',
          copiedFromFileId: source.id,
        });
        expect(copy.copiedFromFileId).toBe(source.id);
        expect(
          await pgError(
            db()
              .update(schema.files)
              .set({ copiedFromFileId: copy.id })
              .where(eq(schema.files.id, copy.id)),
          ),
        ).toEqual({ code: CHECK, constraint: 'files_copied_from_not_self' });
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

      it('indexes every new folder and needs an expiry, not a confirmation (migration 0012)', async () => {
        const owner = await newUser();
        const folder = await newFolder(owner.id, null);
        // ADR 0011 decision 1: on by default, with creation + 90 days as the safety-net expiry.
        expect(folder.faceIndexEnabled).toBe(true);
        expect(folder.faceIndexInformedAt).toBeNull();
        const days = ((folder.faceIndexExpiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000;
        expect(days).toBeGreaterThan(89.9);
        expect(days).toBeLessThan(90.1);
        const set = (values: Partial<typeof schema.folders.$inferInsert>) =>
          db().update(schema.folders).set(values).where(eq(schema.folders.id, folder.id));
        expect(await pgError(set({ faceIndexExpiresAt: null }))).toEqual({
          code: CHECK,
          constraint: 'folders_face_index_has_expiry',
        });
        await set({ faceIndexEnabled: true, faceIndexExpiresAt: inDays(30) });
        await set({ faceIndexEnabled: false, faceIndexExpiresAt: null });
        await set({ faceIndexEnabled: true, faceIndexExpiresAt: inDays(90) });
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
          // New folders are indexed by default (migration 0012); start from all off.
          await db()
            .update(schema.folders)
            .set({ faceIndexEnabled: false, faceIndexExpiresAt: null })
            .where(eq(schema.folders.ownerId, owner.id));
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

    it('keeps one current consent per purpose, so deletion consent coexists with search consent', async () => {
      const owner = await newUser();
      const share = one(
        await db()
          .insert(schema.shares)
          .values({
            ownerId: owner.id,
            targetType: 'file',
            targetFileId: (await newFile(owner.id)).id,
            token: newToken(),
          })
          .returning(),
      );
      const anonId = randomUUID();
      const consent = { shareId: share.id, anonId, policyVersion: '2026-10-25', ipHash: 'h' };
      const inserted = await db().insert(schema.consents).values(consent).returning();
      expect(one(inserted).purpose).toBe('face_search');
      await db()
        .insert(schema.consents)
        .values({ ...consent, purpose: 'face_deletion' });
      expect(await pgError(db().insert(schema.consents).values(consent))).toEqual({
        code: UNIQUE,
        constraint: 'consents_current_anon_unique',
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
    const client = await PGlite.create({ extensions: { ltree, pg_trgm, vector } });
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
    const client = await PGlite.create({ extensions: { ltree, pg_trgm, vector } });
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

      // Up to 0003 only: 0012 switches every folder on again (ADR 0011), checked at the end.
      const upTo0003 = migrationsUpTo(4);
      await migratePglite(db, { migrationsFolder: upTo0003 });
      rmSync(upTo0003, { recursive: true });

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

      // The rest of the chain: 0012 switches the folder back on (ADR 0011 decision 1).
      await migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });
      expect(
        await rows<{ enabled: boolean }>(
          db,
          sql`SELECT face_index_enabled AS enabled FROM folders WHERE id = ${folderId}`,
        ),
      ).toEqual([{ enabled: true }]);
    } finally {
      await client.close();
    }
  }, 120_000);
});

describe('migration 0004 on a database with 0003 and existing rows (PGlite)', () => {
  it('backfills payment owners, period starts, legacy auto-renew and consent purposes', async () => {
    const client = await PGlite.create({ extensions: { ltree, pg_trgm, vector } });
    try {
      const db = drizzlePglite({ client, schema });
      const dir = mkdtempSync(join(tmpdir(), 'shotx-migrations-'));
      mkdirSync(join(dir, 'meta'));
      const journal = JSON.parse(
        readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
      ) as { entries: { tag: string }[] };
      const entries = journal.entries.slice(0, 4);
      writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
      for (const { tag } of entries) {
        copyFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(dir, `${tag}.sql`));
      }
      await migratePglite(db, { migrationsFolder: dir });
      rmSync(dir, { recursive: true });
      const exec = (query: SQL) => db.execute(query);

      const owner = randomUUID();
      await exec(
        sql`INSERT INTO users (id, cognito_pool, cognito_sub, role) VALUES (${owner}, 'users', ${owner}, 'photographer')`,
      );
      const plan = randomUUID();
      await exec(
        sql`INSERT INTO plans (id, code, name, quota_bytes, price_month_satang, price_year_satang)
            VALUES (${plan}, 'legacy', 'Legacy', 1073741824, 14900, 149000)`,
      );
      const expired = randomUUID();
      await exec(
        sql`INSERT INTO subscriptions (id, photographer_id, plan_id, status, billing, period_end, created_at)
            VALUES (${expired}, ${owner}, ${plan}, 'expired', 'auto_renew', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')`,
      );
      await exec(
        sql`INSERT INTO payments (subscription_id, amount_satang, vat_satang, method, gateway, gateway_ref, status, paid_at)
            VALUES (${expired}, 14900, 975, 'promptpay', 'omise', 'chrg_1', 'refunded', '2025-12-01T00:00:00Z')`,
      );
      const file = randomUUID();
      await exec(
        sql`INSERT INTO files (id, owner_id, name, mime, size_bytes, s3_key)
            VALUES (${file}, ${owner}, 'a.jpg', 'image/jpeg', 1, ${`originals/${owner}/${file}/a.jpg`})`,
      );
      const share = randomUUID();
      await exec(
        sql`INSERT INTO shares (id, owner_id, target_type, target_file_id, token) VALUES (${share}, ${owner}, 'file', ${file}, ${newToken()})`,
      );
      await exec(
        sql`INSERT INTO consents (share_id, anon_id, policy_version, ip_hash) VALUES (${share}, ${randomUUID()}, '2026-10-25', 'h')`,
      );

      await migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });

      expect(
        await rows(
          db,
          sql`SELECT photographer_id::text AS owner, refunded_at = paid_at AS refunded FROM payments`,
        ),
      ).toEqual([{ owner, refunded: true }]);
      expect(
        await rows(
          db,
          sql`SELECT billing, period_start = period_end AS clamped FROM subscriptions WHERE id = ${expired}`,
        ),
      ).toEqual([{ billing: 'prepaid', clamped: true }]);
      expect(await rows(db, sql`SELECT purpose FROM consents`)).toEqual([
        { purpose: 'face_search' },
      ]);
    } finally {
      await client.close();
    }
  }, 120_000);
});

describe('auth sessions and admin credentials (migration 0005, PGlite)', () => {
  let b: Backend;
  const db = () => b.db;

  beforeAll(async () => {
    b = await openPglite();
  }, 120_000);

  afterAll(async () => {
    await b?.close();
  });

  const newUser = async (values: Partial<NewUser> = {}) =>
    one(
      await db()
        .insert(schema.users)
        .values({ authPool: 'users', authSubject: `line:${randomUUID()}`, ...values })
        .returning(),
    );
  const newAdmin = async (email: string | null = `${randomUUID()}@example.com`) => {
    const id = randomUUID();
    return one(
      await db()
        .insert(schema.users)
        .values({ id, authPool: 'admins', authSubject: `admin:${id}`, role: 'admin', email })
        .returning(),
    );
  };
  const hash = () => randomBytes(32).toString('hex');
  const session = (
    userId: string,
    pool: 'users' | 'admins',
    values: Record<string, unknown> = {},
  ) =>
    db()
      .insert(schema.authSessions)
      .values({
        userId,
        pool,
        refreshTokenHash: hash(),
        familyId: randomUUID(),
        expiresAt: new Date(Date.now() + 86_400_000),
        ...values,
      })
      .returning();
  const credentials = (userId: string, values: Record<string, unknown> = {}) =>
    db()
      .insert(schema.adminCredentials)
      .values({
        userId,
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
        totpSecretEncrypted: randomBytes(36),
        totpSecretNonce: randomBytes(12),
        ...values,
      })
      .returning();

  it('keeps a session in its user pool and its hash well-formed', async () => {
    const user = await newUser();
    const [row] = await session(user.id, 'users');
    expect(row?.pool).toBe('users');
    expect(await pgError(session(user.id, 'admins'))).toEqual({
      code: FOREIGN_KEY,
      constraint: 'auth_sessions_user_pool_fk',
    });
    expect(await pgError(session(user.id, 'users', { refreshTokenHash: 'ABC' }))).toEqual({
      code: CHECK,
      constraint: 'auth_sessions_hash_format',
    });
    const duplicate = row?.refreshTokenHash ?? '';
    expect(await pgError(session(user.id, 'users', { refreshTokenHash: duplicate }))).toEqual({
      code: UNIQUE,
      constraint: 'auth_sessions_refresh_token_hash_unique',
    });
  });

  it('rotates: a replaced session must be revoked, and a family revokes together', async () => {
    const user = await newUser();
    const familyId = randomUUID();
    const first = one(await session(user.id, 'users', { familyId }));
    const second = one(await session(user.id, 'users', { familyId }));
    expect(
      await pgError(
        db()
          .update(schema.authSessions)
          .set({ replacedById: second.id })
          .where(eq(schema.authSessions.id, first.id)),
      ),
    ).toEqual({ code: CHECK, constraint: 'auth_sessions_replaced_is_revoked' });
    await db()
      .update(schema.authSessions)
      .set({ replacedById: second.id, revokedAt: new Date() })
      .where(eq(schema.authSessions.id, first.id));
    const revoked = await db()
      .update(schema.authSessions)
      .set({ revokedAt: new Date() })
      .where(eq(schema.authSessions.familyId, familyId))
      .returning();
    expect(revoked).toHaveLength(2);
    expect(await pgError(session(user.id, 'users', { expiresAt: new Date(0) }))).toEqual({
      code: CHECK,
      constraint: 'auth_sessions_expiry_order',
    });
  });

  it('purges a successor before its predecessor: replaced_by_id is set to null (migration 0006)', async () => {
    const user = await newUser();
    const familyId = randomUUID();
    const first = one(await session(user.id, 'users', { familyId }));
    const second = one(await session(user.id, 'users', { familyId }));
    await db()
      .update(schema.authSessions)
      .set({ replacedById: second.id, revokedAt: new Date() })
      .where(eq(schema.authSessions.id, first.id));
    await db().delete(schema.authSessions).where(eq(schema.authSessions.id, second.id));
    const [left] = await db()
      .select()
      .from(schema.authSessions)
      .where(eq(schema.authSessions.id, first.id));
    expect(left).toMatchObject({ replacedById: null });
    expect(left?.revokedAt).not.toBeNull();
  });

  it('gives credentials to admins-pool users only, with valid hashes and TOTP sizes', async () => {
    const admin = await newAdmin();
    const [row] = await credentials(admin.id);
    expect(row).toMatchObject({ authPool: 'admins', failedAttempts: 0, totpConfirmedAt: null });
    expect(row?.totpSecretNonce).toHaveLength(12);
    const viewer = await newUser();
    expect(await pgError(credentials(viewer.id))).toEqual({
      code: FOREIGN_KEY,
      constraint: 'admin_credentials_admin_user_fk',
    });
    expect(await pgError(credentials(viewer.id, { authPool: 'users' }))).toEqual({
      code: CHECK,
      constraint: 'admin_credentials_admins_pool',
    });
    const other = await newAdmin();
    expect(await pgError(credentials(other.id, { passwordHash: '$2b$10$bcrypt' }))).toEqual({
      code: CHECK,
      constraint: 'admin_credentials_password_argon2id',
    });
    expect(await pgError(credentials(other.id, { totpSecretNonce: randomBytes(16) }))).toEqual({
      code: CHECK,
      constraint: 'admin_credentials_totp_sizes',
    });
  });

  it('deletes sessions and credentials with their user', async () => {
    const admin = await newAdmin();
    await credentials(admin.id);
    await session(admin.id, 'admins');
    await db().delete(schema.users).where(eq(schema.users.id, admin.id));
    expect(
      await db().select().from(schema.authSessions).where(eq(schema.authSessions.userId, admin.id)),
    ).toEqual([]);
    expect(
      await db()
        .select()
        .from(schema.adminCredentials)
        .where(eq(schema.adminCredentials.userId, admin.id)),
    ).toEqual([]);
  });

  it('keeps ShotX admin emails unique ignoring case, and identities per pool', async () => {
    const email = `Ops-${randomUUID()}@Example.com`;
    await newAdmin(email);
    expect(await pgError(newAdmin(email.toLowerCase()))).toEqual({
      code: UNIQUE,
      constraint: 'users_admin_email_unique',
    });
    // Legacy Cognito admins and users-pool accounts may share it.
    await newUser({ authPool: 'admins', authSubject: randomUUID(), role: 'admin', email });
    await newUser({ email });
    const subject = `google:${randomUUID()}`;
    await newUser({ authSubject: subject });
    expect(await pgError(newUser({ authSubject: subject }))).toEqual({
      code: UNIQUE,
      constraint: 'users_auth_identity_unique',
    });
    expect(await pgError(newUser({ authSubject: '' }))).toEqual({
      code: CHECK,
      constraint: 'users_auth_subject_not_empty',
    });
  });

  it('allows audit rows without an actor for auth events only', async () => {
    // Failed sign-ins for unknown emails, and the operator CLI's actions.
    for (const action of AUTH_AUDIT_ACTIONS) {
      await db().insert(schema.auditLog).values({
        actorId: null,
        action,
        targetType: 'admin_login',
        targetId: 'hmac',
      });
    }
    expect(
      await pgError(
        db().insert(schema.auditLog).values({
          actorId: null,
          action: 'takedown.share',
          targetType: 'share',
          targetId: randomUUID(),
        }),
      ),
    ).toEqual({ code: CHECK, constraint: 'audit_log_actor_unless_auth_event' });
  });
});

describe('migration 0005 on a database with 0004 and existing users (PGlite)', () => {
  it('renames the identity columns and constraints and keeps the admin CHECK', async () => {
    const client = await PGlite.create({ extensions: { ltree, pg_trgm, vector } });
    try {
      const db = drizzlePglite({ client, schema });
      const dir = mkdtempSync(join(tmpdir(), 'shotx-migrations-'));
      mkdirSync(join(dir, 'meta'));
      const journal = JSON.parse(
        readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
      ) as { entries: { tag: string }[] };
      const entries = journal.entries.slice(0, 5);
      writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
      for (const { tag } of entries) {
        copyFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(dir, `${tag}.sql`));
      }
      await migratePglite(db, { migrationsFolder: dir });
      rmSync(dir, { recursive: true });
      const exec = (query: SQL) => db.execute(query);

      const viewer = randomUUID();
      const admin = randomUUID();
      await exec(
        sql`INSERT INTO users (id, cognito_pool, cognito_sub, role, email) VALUES
            (${viewer}, 'users', 'cognito-sub-1', 'user', 'a@example.com'),
            (${admin}, 'admins', 'cognito-sub-2', 'admin', 'a@example.com')`,
      );
      await exec(
        sql`INSERT INTO audit_log (actor_id, action, target_type, target_id) VALUES (${admin}, 'takedown.share', 'share', 'x')`,
      );

      await migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });

      expect(
        await rows(
          db,
          sql`SELECT auth_pool::text AS pool, auth_subject AS subject FROM users ORDER BY auth_subject`,
        ),
      ).toEqual([
        { pool: 'users', subject: 'cognito-sub-1' },
        { pool: 'admins', subject: 'cognito-sub-2' },
      ]);
      expect(
        await rows(
          db,
          sql`SELECT conname FROM pg_constraint WHERE conrelid = 'users'::regclass ORDER BY conname`,
        ),
      ).toEqual(
        expect.arrayContaining([
          { conname: 'users_admin_iff_admins_pool' },
          { conname: 'users_auth_identity_unique' },
          { conname: 'users_auth_subject_not_empty' },
          { conname: 'users_id_auth_pool_unique' },
        ]),
      );
      expect(
        await pgError(
          exec(
            sql`INSERT INTO users (auth_pool, auth_subject, role) VALUES ('users', 'line:U1', 'admin')`,
          ),
        ),
      ).toEqual({ code: CHECK, constraint: 'users_admin_iff_admins_pool' });
    } finally {
      await client.close();
    }
  }, 120_000);
});

describe('admin-provisioned accounts (migration 0011, PGlite)', () => {
  let b: Backend;
  const db = () => b.db;

  beforeAll(async () => {
    b = await openPglite();
  }, 120_000);

  afterAll(async () => {
    await b?.close();
  });

  const fakeHash = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA';
  const insertUser = (values: NewUser) => db().insert(schema.users).values(values).returning();
  const newAdmin = async (values: Partial<NewUser> = {}) => {
    const id = randomUUID();
    return one(
      await insertUser({
        id,
        authPool: 'admins',
        authSubject: `admin:${id}`,
        role: 'admin',
        email: `admin-${id}@example.test`,
        ...values,
      }),
    );
  };
  const newPhotographer = async (values: Partial<NewUser> = {}) => {
    const id = randomUUID();
    return one(
      await insertUser({
        id,
        authPool: 'users',
        authSubject: `password:${id}`,
        role: 'photographer',
        email: `photo-${id}@example.test`,
        ...values,
      }),
    );
  };
  const sha = () => randomBytes(32).toString('hex');

  it('defaults accounts to active, and ties disabled_at to the status', async () => {
    const admin = await newAdmin();
    expect(admin).toMatchObject({ status: 'active', disabledAt: null, lastSignInAt: null });
    const p = await newPhotographer({ createdById: admin.id });
    expect(p.createdById).toBe(admin.id);
    const update = (set: Partial<NewUser>) =>
      db().update(schema.users).set(set).where(eq(schema.users.id, p.id));
    expect(await pgError(update({ status: 'disabled' }))).toEqual({
      code: CHECK,
      constraint: 'users_disabled_at_iff_disabled',
    });
    expect(await pgError(update({ disabledAt: new Date() }))).toEqual({
      code: CHECK,
      constraint: 'users_disabled_at_iff_disabled',
    });
    await update({ status: 'disabled', disabledAt: new Date() });
    await update({ status: 'active', disabledAt: null });
    expect(await pgError(update({ createdById: p.id }))).toEqual({
      code: CHECK,
      constraint: 'users_not_created_by_self',
    });
    // Deleting the creating admin keeps the account.
    await db().delete(schema.users).where(eq(schema.users.id, admin.id));
    const [left] = await db().select().from(schema.users).where(eq(schema.users.id, p.id));
    expect(left?.createdById).toBeNull();
  });

  it('keeps password subjects photographers with an email, and admin subjects admins', async () => {
    const id = randomUUID();
    const base = { id, authSubject: `password:${id}`, email: `${id}@example.test` };
    expect(await pgError(insertUser({ ...base, authPool: 'users', role: 'user' }))).toEqual({
      code: CHECK,
      constraint: 'users_password_subject_photographer',
    });
    expect(
      await pgError(insertUser({ ...base, authPool: 'users', role: 'photographer', email: null })),
    ).toEqual({ code: CHECK, constraint: 'users_password_account_has_email' });
    expect(
      await pgError(insertUser({ ...base, authSubject: `admin:${id}`, authPool: 'users' })),
    ).toEqual({ code: CHECK, constraint: 'users_admin_subject_admins_pool' });
  });

  it('keeps one email per password account across both pools, ignoring ASCII case', async () => {
    const email = `Somchai-${randomUUID()}@Example.test`;
    await newPhotographer({ email });
    expect(await pgError(newAdmin({ email: email.toLowerCase() }))).toEqual({
      code: UNIQUE,
      constraint: 'users_password_account_email_unique',
    });
    expect(await pgError(newPhotographer({ email: email.toUpperCase() }))).toEqual({
      code: UNIQUE,
      constraint: 'users_password_account_email_unique',
    });
    // LINE/Google viewers and photographers from before ADR 0010 may share it.
    await insertUser({ authPool: 'users', authSubject: `line:${randomUUID()}`, email });
    await insertUser({
      authPool: 'users',
      authSubject: `google:${randomUUID()}`,
      role: 'photographer',
      email,
    });
  });

  it('gives password credentials to users-pool accounts only, temporary by default', async () => {
    const p = await newPhotographer();
    const credentials = (userId: string, values: Record<string, unknown> = {}) =>
      db()
        .insert(schema.userPasswordCredentials)
        .values({ userId, passwordHash: fakeHash, ...values })
        .returning();
    const [row] = await credentials(p.id);
    expect(row).toMatchObject({
      authPool: 'users',
      mustChangePassword: true,
      failedAttempts: 0,
      lockedUntil: null,
      passwordChangedAt: null,
    });
    const admin = await newAdmin();
    expect(await pgError(credentials(admin.id))).toEqual({
      code: FOREIGN_KEY,
      constraint: 'user_password_credentials_user_fk',
    });
    expect(await pgError(credentials(admin.id, { authPool: 'admins' }))).toEqual({
      code: CHECK,
      constraint: 'user_password_credentials_users_pool',
    });
    const other = await newPhotographer();
    expect(await pgError(credentials(other.id, { passwordHash: '$2b$10$bcrypt' }))).toEqual({
      code: CHECK,
      constraint: 'user_password_credentials_password_argon2id',
    });
    expect(await pgError(credentials(other.id, { failedAttempts: -1 }))).toEqual({
      code: CHECK,
      constraint: 'user_password_credentials_failed_attempts_valid',
    });
    await db().delete(schema.users).where(eq(schema.users.id, p.id));
    expect(
      await db()
        .select()
        .from(schema.userPasswordCredentials)
        .where(eq(schema.userPasswordCredentials.userId, p.id)),
    ).toEqual([]);
  });

  it('lets admin-app admins start without a TOTP secret, but never half a secret', async () => {
    const credentials = (userId: string, values: Record<string, unknown> = {}) =>
      db()
        .insert(schema.adminCredentials)
        .values({ userId, passwordHash: fakeHash, ...values })
        .returning();
    const uiAdmin = await newAdmin();
    const [row] = await credentials(uiAdmin.id, { mustChangePassword: true });
    expect(row).toMatchObject({
      mustChangePassword: true,
      totpSecretEncrypted: null,
      totpSecretNonce: null,
      totpConfirmedAt: null,
    });
    // As the CLI writes them: secret set, not temporary.
    const cliAdmin = await newAdmin();
    const [cli] = await credentials(cliAdmin.id, {
      totpSecretEncrypted: randomBytes(36),
      totpSecretNonce: randomBytes(12),
    });
    expect(cli?.mustChangePassword).toBe(false);
    for (const [values, constraint] of [
      [{ totpSecretNonce: randomBytes(12) }, 'admin_credentials_totp_secret_complete'],
      [{ totpSecretEncrypted: randomBytes(36) }, 'admin_credentials_totp_secret_complete'],
      [{ totpConfirmedAt: new Date() }, 'admin_credentials_totp_state_needs_secret'],
      [{ totpLastUsedStep: 1 }, 'admin_credentials_totp_state_needs_secret'],
    ] as const) {
      const other = await newAdmin();
      expect(await pgError(credentials(other.id, values)), constraint).toEqual({
        code: CHECK,
        constraint,
      });
    }
    // The final sign-in step stores the secret and the confirmation together.
    await db()
      .update(schema.adminCredentials)
      .set({
        totpSecretEncrypted: randomBytes(36),
        totpSecretNonce: randomBytes(12),
        totpConfirmedAt: new Date(),
        mustChangePassword: false,
      })
      .where(eq(schema.adminCredentials.userId, uiAdmin.id));
  });

  it('records cash payments from an admin against a users-pool account, in satang', async () => {
    const admin = await newAdmin();
    const p = await newPhotographer();
    const pay = (values: Record<string, unknown> = {}) =>
      db()
        .insert(schema.cashPayments)
        .values({
          photographerId: p.id,
          amountSatang: 39_000,
          paidAt: new Date(),
          recordedById: admin.id,
          idempotencyKey: randomUUID(),
          requestSha256: sha(),
          ...values,
        })
        .returning();
    const [row] = await pay({ note: 'เงินสด' });
    expect(row).toMatchObject({
      photographerPool: 'users',
      recordedByPool: 'admins',
      amountSatang: 39_000,
    });
    expect(await pgError(pay({ photographerId: admin.id }))).toEqual({
      code: FOREIGN_KEY,
      constraint: 'cash_payments_photographer_fk',
    });
    expect(await pgError(pay({ recordedById: p.id }))).toEqual({
      code: FOREIGN_KEY,
      constraint: 'cash_payments_recorded_by_admin_fk',
    });
    for (const [values, constraint] of [
      [{ amountSatang: 0 }, 'cash_payments_amount_positive'],
      [{ note: '' }, 'cash_payments_note_length'],
      [{ note: 'x'.repeat(501) }, 'cash_payments_note_length'],
      [{ paidAt: new Date(Date.now() + 3 * 86_400_000) }, 'cash_payments_paid_at_not_future'],
      [{ idempotencyKey: '' }, 'cash_payments_idempotency_key_format'],
      [{ requestSha256: 'ABC' }, 'cash_payments_request_sha256_hex'],
    ] as const) {
      expect(await pgError(pay(values)), constraint).toEqual({ code: CHECK, constraint });
    }
    expect(await pgError(pay({ idempotencyKey: row?.idempotencyKey }))).toEqual({
      code: UNIQUE,
      constraint: 'cash_payments_idempotency_unique',
    });
    // A ledger row keeps its photographer: deleting them is refused.
    expect(await pgError(db().delete(schema.users).where(eq(schema.users.id, p.id)))).toEqual({
      code: FOREIGN_KEY,
      constraint: 'cash_payments_photographer_fk',
    });
  });

  it('allows admin user-management audit rows only with an actor', async () => {
    const admin = await newAdmin();
    for (const action of ADMIN_AUDIT_ACTIONS) {
      await db()
        .insert(schema.auditLog)
        .values({ actorId: admin.id, action, targetType: 'user', targetId: admin.id });
      expect(
        await pgError(
          db()
            .insert(schema.auditLog)
            .values({ actorId: null, action, targetType: 'user', targetId: admin.id }),
        ),
        action,
      ).toEqual({ code: CHECK, constraint: 'audit_log_actor_unless_auth_event' });
    }
  });
});

describe('migration 0011 on a database with 0010 and existing accounts (PGlite)', () => {
  it('keeps CLI admins (secret set, not temporary) and makes every account active', async () => {
    const client = await PGlite.create({ extensions: { ltree, pg_trgm, vector } });
    try {
      const db = drizzlePglite({ client, schema });
      const dir = mkdtempSync(join(tmpdir(), 'shotx-migrations-'));
      mkdirSync(join(dir, 'meta'));
      const journal = JSON.parse(
        readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
      ) as { entries: { tag: string }[] };
      const entries = journal.entries.slice(0, 11);
      expect(entries.at(-1)?.tag).toBe('0010_face_vectors');
      writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
      for (const { tag } of entries) {
        copyFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(dir, `${tag}.sql`));
      }
      await migratePglite(db, { migrationsFolder: dir });
      rmSync(dir, { recursive: true });
      const exec = (query: SQL) => db.execute(query);

      const admin = randomUUID();
      const viewer = randomUUID();
      const photographer = randomUUID();
      await exec(
        sql`INSERT INTO users (id, auth_pool, auth_subject, role, email) VALUES
            (${admin}, 'admins', ${`admin:${admin}`}, 'admin', 'Ops@Example.test'),
            (${viewer}, 'users', ${`line:${viewer}`}, 'user', null),
            (${photographer}, 'users', ${`google:${photographer}`}, 'photographer', 'ops@example.test')`,
      );
      await exec(
        sql`INSERT INTO admin_credentials (user_id, password_hash, totp_secret_encrypted, totp_secret_nonce, totp_confirmed_at)
            VALUES (${admin}, '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA', ${randomBytes(36)}, ${randomBytes(12)}, now())`,
      );

      await migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });

      expect(
        await rows(
          db,
          sql`SELECT status::text AS status, disabled_at, created_by_id FROM users ORDER BY id`,
        ),
      ).toEqual([
        { status: 'active', disabled_at: null, created_by_id: null },
        { status: 'active', disabled_at: null, created_by_id: null },
        { status: 'active', disabled_at: null, created_by_id: null },
      ]);
      expect(
        await rows(
          db,
          sql`SELECT must_change_password, totp_secret_encrypted IS NOT NULL AS has_secret FROM admin_credentials`,
        ),
      ).toEqual([{ must_change_password: false, has_secret: true }]);
      // The existing admin's email now blocks a photographer password account with it.
      const id = randomUUID();
      expect(
        await pgError(
          exec(
            sql`INSERT INTO users (id, auth_pool, auth_subject, role, email) VALUES (${id}, 'users', ${`password:${id}`}, 'photographer', 'OPS@example.test')`,
          ),
        ),
      ).toEqual({ code: UNIQUE, constraint: 'users_password_account_email_unique' });
    } finally {
      await client.close();
    }
  }, 120_000);
});

describe('migration 0012 on a database with 0011 and existing rows (PGlite)', () => {
  it('backfills slugs, switches every folder on, marks top-level folders and keeps consents Thai', async () => {
    const client = await PGlite.create({ extensions: { ltree, pg_trgm, vector } });
    try {
      const db = drizzlePglite({ client, schema });
      const dir = mkdtempSync(join(tmpdir(), 'shotx-migrations-'));
      mkdirSync(join(dir, 'meta'));
      const journal = JSON.parse(
        readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
      ) as { entries: { tag: string }[] };
      const entries = journal.entries.slice(0, 12);
      expect(entries.at(-1)?.tag).toBe('0011_admin_accounts');
      writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
      for (const { tag } of entries) {
        copyFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(dir, `${tag}.sql`));
      }
      await migratePglite(db, { migrationsFolder: dir });
      rmSync(dir, { recursive: true });
      const exec = (query: SQL) => db.execute(query);

      const owner = randomUUID();
      await exec(
        sql`INSERT INTO users (id, auth_pool, auth_subject, role) VALUES (${owner}, 'users', ${`line:${owner}`}, 'photographer')`,
      );
      const folder = async (
        name: string,
        parent: { id: string; path: string } | null,
        extra: SQL = sql`false, NULL, NULL, NULL`,
      ) => {
        const id = randomUUID();
        const path = folderPath(parent?.path ?? null, id);
        await exec(
          sql`INSERT INTO folders (id, owner_id, parent_id, name, path, face_index_enabled, face_index_expires_at, face_index_informed_at, deleted_at)
              VALUES (${id}, ${owner}, ${parent?.id ?? null}, ${name}, ${path}::ltree, ${extra})`,
        );
        return { id, path };
      };
      const thai = await folder('งานวิ่ง กรุงเทพ 2026', null);
      const day1 = await folder('Day 1', thai);
      const english = await folder('Bangkok Run 2026!', null);
      const later = await folder('bangkok   run 2026', null);
      const chinese = await folder('曼谷马拉松，2026年', null);
      const emoji = await folder('🎉🎉', null);
      const tokenShaped = await folder('ABCDEFGHIJKLMNOPQRSTUV', null);
      // Indexed until far in the future: keeps the longer expiry.
      const active = await folder(
        'Active',
        null,
        sql`true, now() + interval '200 days', now(), NULL`,
      );
      const trashed = await folder('Trashed', null, sql`false, NULL, NULL, now()`);
      const fileId = randomUUID();
      await exec(
        sql`INSERT INTO files (id, owner_id, folder_id, name, mime, size_bytes, s3_key, status)
            VALUES (${fileId}, ${owner}, ${english.id}, 'IMG_1234.JPG', 'image/jpeg', 1, ${`originals/${owner}/${fileId}/IMG_1234.JPG`}, 'ready')`,
      );
      const share = async (target: { folder?: string; file?: string }, createdAt: string) => {
        const id = randomUUID();
        await exec(
          sql`INSERT INTO shares (id, owner_id, target_type, target_folder_id, target_file_id, token, created_at)
              VALUES (${id}, ${owner}, ${target.file !== undefined ? 'file' : 'folder'},
                      ${target.folder ?? null}, ${target.file ?? null}, ${newToken()}, ${createdAt}::timestamptz)`,
        );
        return id;
      };
      const shares = {
        thai: await share({ folder: thai.id }, '2026-11-01T00:00:00Z'),
        english: await share({ folder: english.id }, '2026-11-01T00:00:00Z'),
        englishAgain: await share({ folder: english.id }, '2026-11-02T00:00:00Z'),
        later: await share({ folder: later.id }, '2026-11-03T00:00:00Z'),
        chinese: await share({ folder: chinese.id }, '2026-11-01T00:00:00Z'),
        emoji: await share({ folder: emoji.id }, '2026-11-01T00:00:00Z'),
        tokenShaped: await share({ folder: tokenShaped.id }, '2026-11-01T00:00:00Z'),
        file: await share({ file: fileId }, '2026-11-01T00:00:00Z'),
      };
      const shareId = shares.thai;
      await exec(
        sql`INSERT INTO consents (share_id, anon_id, policy_version, ip_hash) VALUES (${shareId}, ${randomUUID()}, '2026-11-11b', 'h')`,
      );
      const adminId = randomUUID();
      await exec(
        sql`INSERT INTO users (id, auth_pool, auth_subject, role) VALUES (${adminId}, 'admins', ${`admin:${adminId}`}, 'admin')`,
      );
      const sessionId = randomUUID();
      await exec(
        sql`INSERT INTO auth_sessions (id, user_id, pool, refresh_token_hash, family_id, expires_at)
            VALUES (${sessionId}, ${adminId}, 'admins', ${'a'.repeat(64)}, ${sessionId}, now() + interval '1 hour')`,
      );

      await migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });

      const slugs = Object.fromEntries(
        await Promise.all(
          Object.entries(shares).map(async ([key, id]) => [
            key,
            one(await rows<{ slug: string }>(db, sql`SELECT slug FROM shares WHERE id = ${id}`))
              .slug,
          ]),
        ),
      ) as Record<keyof typeof shares, string>;
      expect(slugs.thai).toBe('งานวิ่ง-กรุงเทพ-2026');
      expect(slugs.english).toBe('bangkok-run-2026');
      // Same base: the older share keeps it, later ones get a suffix.
      expect(slugs.englishAgain).toMatch(/^bangkok-run-2026-[0-9a-z]{6}$/);
      expect(slugs.later).toMatch(/^bangkok-run-2026-[0-9a-z]{6}$/);
      expect(slugs.later).not.toBe(slugs.englishAgain);
      expect(slugs.chinese).toBe('曼谷马拉松-2026年');
      expect(slugs.emoji).toBe('event');
      expect(slugs.tokenShaped).toMatch(/^abcdefghijklmnopqrstuv-[0-9a-z]{6}$/);
      expect(slugs.file).toBe('img-1234');
      // Every backfilled slug is one the api accepts, and matches slugifyEventName where SQL can.
      for (const [key, slug] of Object.entries(slugs)) {
        expect(isShareSlug(slug), key).toBe(true);
        expect(parseShareRef(slug), key).toEqual({ kind: 'slug', slug });
      }
      for (const name of [
        'งานวิ่ง กรุงเทพ 2026',
        'Bangkok Run 2026!',
        '曼谷马拉松，2026年',
        '🎉🎉',
      ]) {
        expect(Object.values(slugs)).toContain(slugifyEventName(name));
      }

      const folders = await rows<{
        id: string;
        enabled: boolean;
        days: number | null;
        queued: boolean;
      }>(
        db,
        sql`SELECT id, face_index_enabled AS enabled, queued_mark AS queued,
              extract(epoch FROM face_index_expires_at - now())::float8 / 86400 AS days
            FROM (SELECT *, face_index_queued_at IS NOT NULL AS queued_mark FROM folders) AS f`,
      );
      const byId = (id: string) => folders.find((f) => f.id === id);
      for (const f of folders) expect(f.enabled, f.id).toBe(true);
      expect(byId(thai.id)).toMatchObject({ queued: true });
      expect(byId(day1.id)).toMatchObject({ queued: false });
      expect(byId(trashed.id)).toMatchObject({ queued: false });
      expect(byId(thai.id)?.days).toBeCloseTo(90, 1);
      expect(byId(active.id)?.days).toBeCloseTo(200, 1);

      expect(await rows(db, sql`SELECT locale::text AS locale FROM consents`)).toEqual([
        { locale: 'th' },
      ]);
      expect(await rows(db, sql`SELECT amr FROM auth_sessions`)).toEqual([{ amr: null }]);
    } finally {
      await client.close();
    }
  }, 120_000);
});

describe('event gallery and admin sessions constraints (migration 0012, PGlite)', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzlePglite<typeof schema>>;
  beforeAll(async () => {
    client = await PGlite.create({ extensions: { ltree, pg_trgm, vector } });
    db = drizzlePglite({ client, schema });
    await migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });
  }, 120_000);
  afterAll(async () => {
    await client.close();
  });

  const newOwner = async () =>
    one(
      await db
        .insert(schema.users)
        .values({ authPool: 'users', authSubject: randomUUID(), role: 'photographer' })
        .returning(),
    );
  const newFolderOf = async (ownerId: string) => {
    const id = randomUUID();
    return one(
      await db
        .insert(schema.folders)
        .values({ id, ownerId, name: `f ${id}`, path: folderPath(null, id) })
        .returning(),
    );
  };
  const newFileOf = async (ownerId: string, folderId: string) =>
    one(
      await db
        .insert(schema.files)
        .values({
          ownerId,
          folderId,
          name: `IMG_${randomUUID()}.JPG`,
          mime: 'image/jpeg',
          sizeBytes: 1,
          s3Key: `originals/${ownerId}/${randomUUID()}/a.jpg`,
        })
        .returning(),
    );

  it('keeps slugs unique and well-formed; a slug is never token-shaped', async () => {
    const owner = await newOwner();
    const folder = await newFolderOf(owner.id);
    const insert = (slug: string | null) =>
      db.insert(schema.shares).values({
        ownerId: owner.id,
        targetType: 'folder',
        targetFolderId: folder.id,
        token: newToken(),
        slug,
      });
    await insert('งานวิ่ง-2026');
    await insert(null);
    await insert(null);
    expect(await pgError(insert('งานวิ่ง-2026'))).toEqual({
      code: UNIQUE,
      constraint: 'shares_slug_unique',
    });
    for (const bad of [
      'Bangkok',
      'run day',
      'run/day',
      'run.day',
      '-run',
      'run-',
      'run--day',
      'abcdefghijklmnopqrstuv',
      'a'.repeat(68),
    ]) {
      expect(await pgError(insert(bad)), bad).toEqual({
        code: CHECK,
        constraint: 'shares_slug_valid',
      });
    }
    // The longest slug the api makes fits.
    await insert(withShareSlugSuffix(slugifyEventName('ก'.repeat(100)), 'abc123'));
  });

  it("keeps a folder's cover the owner's file and clears it when the file row goes", async () => {
    const owner = await newOwner();
    const other = await newOwner();
    const folder = await newFolderOf(owner.id);
    const file = await newFileOf(owner.id, folder.id);
    const otherFolder = await newFolderOf(other.id);
    const othersFile = await newFileOf(other.id, otherFolder.id);
    const setCover = (fileId: string | null) =>
      db
        .update(schema.folders)
        .set({ coverFileId: fileId })
        .where(eq(schema.folders.id, folder.id));
    expect(await pgError(setCover(othersFile.id))).toEqual({
      code: FOREIGN_KEY,
      constraint: 'folders_cover_file_same_owner_fk',
    });
    await setCover(file.id);
    await db.delete(schema.files).where(eq(schema.files.id, file.id));
    const after = one(
      await db.select().from(schema.folders).where(eq(schema.folders.id, folder.id)),
    );
    expect(after.coverFileId).toBeNull();
    expect(after.ownerId).toBe(owner.id);
  });

  it('records the consent language, th by default', async () => {
    const owner = await newOwner();
    const folder = await newFolderOf(owner.id);
    const share = one(
      await db
        .insert(schema.shares)
        .values({
          ownerId: owner.id,
          targetType: 'folder',
          targetFolderId: folder.id,
          token: newToken(),
        })
        .returning(),
    );
    const consent = (locale?: 'th' | 'en' | 'zh') =>
      db
        .insert(schema.consents)
        .values({
          shareId: share.id,
          anonId: randomUUID(),
          policyVersion: '2026-11-11b',
          ipHash: 'h',
          ...(locale !== undefined ? { locale } : {}),
        })
        .returning();
    expect(one(await consent()).locale).toBe('th');
    expect(one(await consent('zh')).locale).toBe('zh');
    expect(
      await pgError(
        db.execute(
          sql`INSERT INTO consents (share_id, anon_id, policy_version, ip_hash, locale) VALUES (${share.id}, ${randomUUID()}, 'v', 'h', 'ja')`,
        ),
      ),
    ).toMatchObject({ code: '22P02' });
  });

  it("stores a session's sign-in methods, known methods only", async () => {
    const user = one(
      await db
        .insert(schema.users)
        .values({ authPool: 'admins', authSubject: `admin:${randomUUID()}`, role: 'admin' })
        .returning(),
    );
    const session = (amr: string[] | null) => {
      const id = randomUUID();
      return db.insert(schema.authSessions).values({
        id,
        userId: user.id,
        pool: 'admins',
        refreshTokenHash: randomBytes(32).toString('hex'),
        familyId: id,
        expiresAt: new Date(Date.now() + 3_600_000),
        amr,
      });
    };
    await session(['pwd']);
    await session(['pwd', 'otp', 'mfa']);
    await session(null);
    for (const bad of [[], ['password'], ['pwd', 'sms']]) {
      expect(await pgError(session(bad)), bad.join(',')).toEqual({
        code: CHECK,
        constraint: 'auth_sessions_amr_valid',
      });
    }
  });
});

describe('share page designs (migration 0013, PGlite)', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzlePglite<typeof schema>>;
  beforeAll(async () => {
    client = await PGlite.create({ extensions: { ltree, pg_trgm, vector } });
    db = drizzlePglite({ client, schema });
    await migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });
  }, 120_000);
  afterAll(async () => {
    await client.close();
  });

  const template = DESIGN_TEMPLATES[0]?.doc;
  if (template === undefined) throw new Error('no template');

  const newOwner = async () =>
    one(
      await db
        .insert(schema.users)
        .values({ authPool: 'users', authSubject: randomUUID(), role: 'photographer' })
        .returning(),
    );
  const newDesign = async (
    ownerId: string,
    values: Partial<typeof schema.shareDesigns.$inferInsert> = {},
  ) =>
    one(
      await db
        .insert(schema.shareDesigns)
        .values({ ownerId, name: 'งานวิ่ง', doc: template, ...values })
        .returning(),
    );
  const newShareOf = async (ownerId: string, designId: string | null) => {
    const folderId = randomUUID();
    await db
      .insert(schema.folders)
      .values({ id: folderId, ownerId, name: `f ${folderId}`, path: folderPath(null, folderId) });
    return db
      .insert(schema.shares)
      .values({
        ownerId,
        targetType: 'folder',
        targetFolderId: folderId,
        token: newToken(),
        designId,
      })
      .returning();
  };

  it('stores a document as sent and starts at revision 1, not the default', async () => {
    const owner = await newOwner();
    const design = await newDesign(owner.id);
    expect(design).toMatchObject({ revision: 1, isDefault: false });
    const [row] = await db
      .select()
      .from(schema.shareDesigns)
      .where(eq(schema.shareDesigns.id, design.id));
    expect(row?.doc).toEqual(template);
    expect(designDocSchema.parse(row?.doc)).toEqual(template);
  });

  it('keeps at most one default per owner', async () => {
    const owner = await newOwner();
    const other = await newOwner();
    await newDesign(owner.id, { isDefault: true });
    await newDesign(owner.id);
    await newDesign(other.id, { isDefault: true });
    expect(await pgError(newDesign(owner.id, { isDefault: true }))).toEqual({
      code: UNIQUE,
      constraint: 'share_designs_one_default_per_owner',
    });
  });

  it('checks the name, the revision and that the document is an object', async () => {
    const owner = await newOwner();
    for (const name of ['', ' padded ', 'x'.repeat(81)]) {
      expect(await pgError(newDesign(owner.id, { name })), name).toEqual({
        code: CHECK,
        constraint: 'share_designs_name_valid',
      });
    }
    await newDesign(owner.id, { name: 'ก'.repeat(80) });
    expect(await pgError(newDesign(owner.id, { revision: 0 }))).toEqual({
      code: CHECK,
      constraint: 'share_designs_revision_positive',
    });
    expect(
      await pgError(
        db.execute(
          sql`INSERT INTO share_designs (owner_id, name, doc) VALUES (${owner.id}, 'x', '[]'::jsonb)`,
        ),
      ),
    ).toEqual({ code: CHECK, constraint: 'share_designs_doc_valid' });
  });

  it("lets a share use only its owner's design and clears it when the design is deleted", async () => {
    const owner = await newOwner();
    const other = await newOwner();
    const design = await newDesign(owner.id);
    const othersDesign = await newDesign(other.id);
    expect(await pgError(newShareOf(owner.id, othersDesign.id))).toEqual({
      code: FOREIGN_KEY,
      constraint: 'shares_design_same_owner_fk',
    });
    const [share] = await newShareOf(owner.id, design.id);
    expect(share?.designId).toBe(design.id);
    const [plain] = await newShareOf(owner.id, null);
    expect(plain?.designId).toBeNull();
    await db.delete(schema.shareDesigns).where(eq(schema.shareDesigns.id, design.id));
    const after = one(
      await db
        .select()
        .from(schema.shares)
        .where(eq(schema.shares.id, share?.id ?? '')),
    );
    expect(after.designId).toBeNull();
    expect(after.ownerId).toBe(owner.id);
  });

  it('keeps design images to JPEG, PNG and WebP, with an expiry while uploading and sizes when ready', async () => {
    const owner = await newOwner();
    const expiresAt = new Date(Date.now() + 3_600_000);
    const asset = (values: Partial<typeof schema.designAssets.$inferInsert>) =>
      db
        .insert(schema.designAssets)
        .values({
          ownerId: owner.id,
          mime: 'image/png',
          sizeBytes: 1024,
          uploadExpiresAt: expiresAt,
          ...values,
        })
        .returning();
    const [uploading] = await asset({});
    expect(uploading).toMatchObject({ status: 'uploading', requeues: 0, width: null });
    for (const mime of ['image/svg+xml', 'image/heic', 'video/mp4', 'IMAGE/PNG']) {
      expect(await pgError(asset({ mime })), mime).toEqual({
        code: CHECK,
        constraint: 'design_assets_mime_allowed',
      });
    }
    expect(await pgError(asset({ sizeBytes: 0 }))).toEqual({
      code: CHECK,
      constraint: 'design_assets_size_positive',
    });
    expect(await pgError(asset({ uploadExpiresAt: null }))).toEqual({
      code: CHECK,
      constraint: 'design_assets_uploading_has_expiry',
    });
    expect(await pgError(asset({ status: 'ready', verifiedAt: new Date() }))).toEqual({
      code: CHECK,
      constraint: 'design_assets_ready_complete',
    });
    await asset({ status: 'ready', verifiedAt: new Date(), width: 2560, height: 1440 });
    expect(await pgError(asset({ width: 0 }))).toEqual({
      code: CHECK,
      constraint: 'design_assets_dimensions_positive',
    });
  });
});
