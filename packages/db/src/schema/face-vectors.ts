import { FACE_MODEL_ID, FACE_RECOGNITION_MODELS } from '@shotx/shared';
import { sql } from 'drizzle-orm';
import { customType, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt } from './columns';

/**
 * pgvector `vector` without a fixed dimension (extension created by migration 0010), so one table
 * holds the embeddings of every model. Values travel as pgvector's text form, `[0.1,0.2,…]`.
 */
export const vector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'vector';
  },
});

/** The HNSW index name of a recognition model (registry id with `-` replaced by `_`). */
export const faceVectorIndexName = (model: string) =>
  `face_vectors_${model.replaceAll('-', '_')}_hnsw`;

/**
 * Face embeddings of the self-hosted FaceProvider (ADR 0009 section 4). This table is the
 * provider's "collection" storage, owned by `@shotx/face`'s PgFaceVectorStore: a row exists from
 * the moment `indexFaces` returns until `deleteFaces`, like a face in a Rekognition collection.
 * The `faces` table stays the record of which faces the platform tracks (`faces.rekognition_face_id`
 * = `face_id`); vectors without a `faces` row are orphans that `faces.reconcile.daily` deletes.
 *
 * No foreign keys on purpose: the provider inserts before the worker commits the `faces` rows
 * (README rules in packages/face), exactly as with Rekognition.
 *
 * Biometric data (PDPA section 26): backups exclude this table's data (ADR 0009 section 6).
 *
 * Every model in FACE_RECOGNITION_MODELS gets a partial HNSW index on its dimension's cast, so
 * adding a model and running `pnpm --filter @shotx/db generate` creates the migration for it.
 */
export const faceVectors = pgTable(
  'face_vectors',
  {
    faceId: uuid('face_id').primaryKey(),
    /** `pg-{photographerId}` (faceCollectionId). */
    collectionId: text('collection_id').notNull(),
    /** The file id (Rekognition's ExternalImageId). */
    externalImageId: text('external_image_id').notNull(),
    /** FACE_RECOGNITION_MODELS id that produced the embedding. */
    model: text('model').notNull(),
    /** L2-normalised embedding of `model`'s dimension. */
    embedding: vector('embedding').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('face_vectors_collection_idx').on(t.collectionId, t.faceId),
    ...Object.entries(FACE_RECOGNITION_MODELS).map(([model, entry]) => {
      if (!FACE_MODEL_ID.test(model)) throw new Error(`Invalid face model id ${model}`);
      return index(faceVectorIndexName(model))
        .using('hnsw', sql.raw(`("embedding"::vector(${entry.dimensions})) vector_cosine_ops`))
        .where(sql.raw(`"model" = '${model}'`));
    }),
  ],
);
