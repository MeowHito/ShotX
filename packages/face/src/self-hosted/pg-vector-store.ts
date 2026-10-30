import { FACE_MODEL_ID, FACE_RECOGNITION_MODELS, type FaceRecognitionModelId } from '@shotx/shared';
import type { FaceVectorStore, StoredFace, VectorMatch, VectorQuery } from './vector-store';

/** What PgFaceVectorStore needs from node-postgres (a `pg.Pool` fits). */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgQueryable & { release(error?: Error | boolean): void }>;
}

export interface PgFaceVectorStoreOptions {
  /** hnsw.ef_search (FACE_HNSW_EF_SEARCH). */
  efSearch: number;
  /** hnsw.max_scan_tuples for iterative scans (FACE_HNSW_MAX_SCAN_TUPLES). */
  maxScanTuples: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** pgvector's text form, `[0.1,-0.2,…]`. */
export function vectorLiteral(embedding: Float32Array): string {
  for (const v of embedding) if (!Number.isFinite(v)) throw new RangeError('Non-finite embedding');
  return `[${Array.from(embedding).join(',')}]`;
}

export function parseVector(text: string): Float32Array {
  return Float32Array.from(JSON.parse(text) as number[]);
}

/**
 * The model's SQL pieces. The model id and dimension are inlined as literals, never parameters:
 * the planner matches a partial index predicate (`model = '<id>'`) only against a literal, and
 * a generic plan for a `$n` parameter would never use the HNSW index. Both come from the
 * registry and the id is checked against FACE_MODEL_ID, so nothing from a request reaches SQL.
 */
function modelSql(model: string): { cast: string; predicate: string } {
  const entry = FACE_RECOGNITION_MODELS[model as FaceRecognitionModelId] as
    (typeof FACE_RECOGNITION_MODELS)[FaceRecognitionModelId] | undefined;
  if (entry === undefined || !FACE_MODEL_ID.test(model)) {
    throw new RangeError(`Unknown face model ${JSON.stringify(model)}`);
  }
  return {
    cast: `::vector(${entry.dimensions})`,
    predicate: `"model" = '${model}'`,
  };
}

/**
 * The self-hosted provider's collections in `face_vectors` (packages/db; ADR 0009 section 4).
 * Searches use the model's partial HNSW index with iterative scans, so the collection filter
 * can't starve the result; the planner may pick an exact scan for small collections instead.
 */
export class PgFaceVectorStore implements FaceVectorStore {
  constructor(
    private readonly pool: PgPoolLike,
    private readonly options: PgFaceVectorStoreOptions,
  ) {}

  async insert(collectionId: string, model: string, faces: readonly StoredFace[]): Promise<void> {
    if (faces.length === 0) return;
    const { cast } = modelSql(model);
    // One statement: all faces are added or none.
    await this.pool.query(
      `INSERT INTO "face_vectors" ("face_id", "collection_id", "external_image_id", "model", "embedding")
       SELECT f.face_id, $1, f.external_image_id, $2, (f.embedding${cast})::vector
       FROM unnest($3::uuid[], $4::text[], $5::text[]) AS f(face_id, external_image_id, embedding)`,
      [
        collectionId,
        model,
        faces.map((f) => f.faceId),
        faces.map((f) => f.externalImageId),
        faces.map((f) => vectorLiteral(f.embedding)),
      ],
    );
  }

  async search(query: VectorQuery): Promise<VectorMatch[]> {
    const { cast, predicate } = modelSql(query.model);
    const client = await this.pool.connect();
    let failed = false;
    try {
      await client.query('BEGIN READ ONLY');
      // Transaction-local settings (set_config(..., true)); they end with the transaction.
      await client.query(
        `SELECT set_config('hnsw.ef_search', $1, true),
                set_config('hnsw.iterative_scan', 'relaxed_order', true),
                set_config('hnsw.max_scan_tuples', $2, true)`,
        [String(this.options.efSearch), String(this.options.maxScanTuples)],
      );
      // pgvector's pattern for a distance cut-off with iterative scans: the nearest rows in a
      // materialised CTE, the cut-off and the exact order outside it.
      const exclude = query.excludeFaceId !== undefined && UUID.test(query.excludeFaceId);
      const { rows } = await client.query(
        `WITH "nearest" AS MATERIALIZED (
           SELECT "face_id", "external_image_id", ("embedding"${cast}) <=> ($1${cast}) AS "distance"
           FROM "face_vectors"
           WHERE "collection_id" = $2 AND ${predicate}${exclude ? ' AND "face_id" <> $5::uuid' : ''}
           ORDER BY ("embedding"${cast}) <=> ($1${cast})
           LIMIT $3
         )
         SELECT "face_id", "external_image_id", "distance" FROM "nearest"
         WHERE "distance" <= $4 ORDER BY "distance", "face_id"`,
        [
          vectorLiteral(query.embedding),
          query.collectionId,
          query.limit,
          1 - query.minCosine,
          ...(exclude ? [query.excludeFaceId] : []),
        ],
      );
      await client.query('COMMIT');
      return (rows as { face_id: string; external_image_id: string; distance: number }[]).map(
        (r) => ({
          faceId: r.face_id,
          externalImageId: r.external_image_id,
          cosine: 1 - Number(r.distance),
        }),
      );
    } catch (error) {
      failed = true;
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release(failed);
    }
  }

  async get(
    collectionId: string,
    model: string,
    faceId: string,
  ): Promise<Float32Array | undefined> {
    const { predicate } = modelSql(model);
    if (!UUID.test(faceId)) return undefined;
    const { rows } = await this.pool.query(
      `SELECT "embedding"::text AS "embedding" FROM "face_vectors"
       WHERE "collection_id" = $1 AND "face_id" = $2::uuid AND ${predicate}`,
      [collectionId, faceId],
    );
    const row = rows[0] as { embedding: string } | undefined;
    return row === undefined ? undefined : parseVector(row.embedding);
  }

  async delete(collectionId: string, faceIds: readonly string[]): Promise<void> {
    const ids = faceIds.filter((id) => UUID.test(id));
    if (ids.length === 0) return;
    await this.pool.query(
      `DELETE FROM "face_vectors" WHERE "collection_id" = $1 AND "face_id" = ANY($2::uuid[])`,
      [collectionId, ids],
    );
  }

  async deleteCollection(collectionId: string): Promise<void> {
    await this.pool.query(`DELETE FROM "face_vectors" WHERE "collection_id" = $1`, [collectionId]);
  }

  async list(collectionId: string, limit: number, after?: string) {
    if (after !== undefined && !UUID.test(after)) throw new RangeError('Invalid list token');
    const { rows } = await this.pool.query(
      `SELECT "face_id", "external_image_id" FROM "face_vectors"
       WHERE "collection_id" = $1 AND ($2::uuid IS NULL OR "face_id" > $2::uuid)
       ORDER BY "face_id" LIMIT $3`,
      [collectionId, after ?? null, limit],
    );
    return (rows as { face_id: string; external_image_id: string }[]).map((r) => ({
      faceId: r.face_id,
      externalImageId: r.external_image_id,
    }));
  }
}
