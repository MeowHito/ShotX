import { Inject, Injectable, Logger } from '@nestjs/common';
import { files, storageUsage, users } from '@shotx/db';
import type { AdminSystemResponse } from '@shotx/shared';
import { and, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import type { ApiConfig } from '../config';
import { type Db, rows } from '../db/db';
import {
  API_CONFIG,
  type BucketUsage,
  CLOCK,
  type Clock,
  DATABASE,
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../tokens';
import { type MetricsSource, readServerMetrics } from './server-metrics';

/** The server-metrics reader; tests replace it with fixed kernel files. */
export const METRICS_SOURCE = Symbol('METRICS_SOURCE');

/**
 * GET /admin/system (ADR 0016): what the database records, the media bucket counted by listing
 * it (cached for ADMIN_STORAGE_SCAN_TTL_SECONDS; one scan at a time), and the server's CPU,
 * memory, disk and temperature.
 */
@Injectable()
export class AdminSystemService {
  private readonly logger = new Logger(AdminSystemService.name);
  private bucket: { usage: BucketUsage | null; measuredAt: Date } | null = null;
  private scanning: Promise<void> | null = null;

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(METRICS_SOURCE) private readonly metrics: MetricsSource,
  ) {}

  async overview(): Promise<AdminSystemResponse> {
    const [storage, bucket, server] = await Promise.all([
      this.recorded(),
      this.bucketUsage(),
      readServerMetrics({ diskPath: this.config.adminConsole.systemDiskPath }, this.metrics),
    ]);
    return {
      generatedAt: this.clock.now().toISOString(),
      storage,
      bucket:
        bucket?.usage == null
          ? null
          : {
              name: bucket.usage.bucket,
              objectCount: bucket.usage.objectCount,
              totalBytes: bucket.usage.totalBytes,
              prefixes: bucket.usage.prefixes,
              measuredAt: bucket.measuredAt.toISOString(),
            },
      server,
    };
  }

  private async recorded(): Promise<AdminSystemResponse['storage']> {
    const [usage] = await this.db
      .select({ bytes: sql<string>`coalesce(sum(${storageUsage.usedBytes}), 0)::text` })
      .from(storageUsage);
    const counts = await this.db
      .select({
        image: sql<number>`count(*) filter (where ${like(files.mime, 'image/%')})`.mapWith(Number),
        video: sql<number>`count(*) filter (where ${like(files.mime, 'video/%')})`.mapWith(Number),
      })
      .from(files)
      .where(and(isNull(files.deletedAt), inArray(files.status, ['processing', 'ready'])));
    const [photographers] = await this.db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(users)
      .where(eq(users.role, 'photographer'));
    let databaseBytes: number | null = null;
    try {
      const [size] = await rows<{ bytes: string }>(
        this.db,
        sql`SELECT pg_database_size(current_database())::text AS bytes`,
      );
      databaseBytes = size === undefined ? null : Number(size.bytes);
    } catch {
      databaseBytes = null; // PGlite in tests, or no permission.
    }
    return {
      originalsBytes: Number(usage?.bytes ?? 0),
      photoCount: counts[0]?.image ?? 0,
      videoCount: counts[0]?.video ?? 0,
      photographerCount: photographers?.n ?? 0,
      databaseBytes,
    };
  }

  /**
   * The cached bucket count; a stale or missing one is refreshed. The first request waits for
   * the scan; later ones get the cached count while a refresh runs in the background.
   */
  private async bucketUsage(): Promise<{ usage: BucketUsage | null; measuredAt: Date } | null> {
    const list = this.storage.bucketUsage?.bind(this.storage);
    if (list === undefined) return null;
    const ttlMs = this.config.adminConsole.storageScanTtlSeconds * 1000;
    const fresh =
      this.bucket !== null && this.clock.now().getTime() - this.bucket.measuredAt.getTime() < ttlMs;
    if (!fresh && this.scanning === null) {
      this.scanning = list()
        .then(
          (usage) => {
            this.bucket = { usage, measuredAt: this.clock.now() };
          },
          (error: unknown) => {
            // Listing not allowed or failed: show no bucket rather than a guess, retry after the TTL.
            this.logger.warn(`bucket scan failed: ${String((error as Error)?.name ?? error)}`);
            this.bucket = { usage: null, measuredAt: this.clock.now() };
          },
        )
        .finally(() => {
          this.scanning = null;
        });
    }
    if (this.bucket === null && this.scanning !== null) await this.scanning;
    return this.bucket;
  }
}
