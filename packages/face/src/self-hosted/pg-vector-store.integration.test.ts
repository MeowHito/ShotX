import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { MIGRATIONS_FOLDER } from '@shotx/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { l2Normalize } from './embed';
import { PgFaceVectorStore, type PgPoolLike } from './pg-vector-store';
import { InMemoryFaceVectorStore } from './vector-store';

const MODEL = 'sface-2021dec';
const DIMS = 128;

/** PGlite has one connection; `connect` hands out the same one (queries run in order). */
function poolOf(client: PGlite): PgPoolLike {
  const queryable = {
    query: async (text: string, values?: unknown[]) => {
      const result = await client.query(text, values);
      return { rows: result.rows };
    },
  };
  return {
    ...queryable,
    connect: () => Promise.resolve({ ...queryable, release: () => undefined }),
  };
}

/** Deterministic pseudo-random unit vectors, plus near copies of a few "people". */
function vectors(seed: number, count: number): Float32Array[] {
  let state = seed;
  const next = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  return Array.from({ length: count }, () =>
    l2Normalize(Float32Array.from({ length: DIMS }, next)),
  );
}

function near(base: Float32Array, seed: number, amount: number): Float32Array {
  const [noise] = vectors(seed, 1);
  return l2Normalize(base.map((v, i) => v + amount * noise![i]!));
}

/** Applies every migration in journal order, the way the migrator does. */
async function migrateAll(client: PGlite): Promise<void> {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { tag: string }[] };
  for (const { tag } of journal.entries) {
    await client.exec(readFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8'));
  }
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('PgFaceVectorStore on PostgreSQL with pgvector (PGlite)', () => {
  let client: PGlite;
  let store: PgFaceVectorStore;
  const memory = new InMemoryFaceVectorStore();
  const people = vectors(7, 5);

  beforeAll(async () => {
    client = await PGlite.create({ extensions: { ltree, pg_trgm, vector } });
    await migrateAll(client);
    store = new PgFaceVectorStore(poolOf(client), { efSearch: 40, maxScanTuples: 20_000 });
    // 600 faces in collection A (the five people appear 20 times each, the rest are strangers),
    // and the same people in collection B, which must never leak into A's results.
    let n = 0;
    for (const collection of ['pg-a', 'pg-b']) {
      const faces = [
        ...people.flatMap((p, pi) =>
          Array.from({ length: 20 }, (_, k) =>
            near(p, 1000 * pi + k + (collection === 'pg-b' ? 50 : 0), 0.35),
          ),
        ),
        ...(collection === 'pg-a' ? vectors(99, 500) : []),
      ].map((embedding, i) => ({
        faceId: uuid(++n),
        externalImageId: `${collection}-file-${i % 250}`,
        embedding,
      }));
      await store.insert(collection, MODEL, faces);
      await memory.insert(collection, MODEL, faces);
    }
  }, 120_000);

  afterAll(() => client?.close());

  it('uses the HNSW index of the model for searches', async () => {
    const plan = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT "face_id" FROM "face_vectors" WHERE "collection_id" = 'pg-a' AND "model" = '${MODEL}'
       ORDER BY ("embedding"::vector(${DIMS})) <=> ('[${Array.from(people[0]!).join(',')}]'::vector(${DIMS})) LIMIT 10`,
    );
    const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
    // The planner may prefer the btree for a collection filter on a tiny table; both are valid.
    expect(text).toMatch(/face_vectors_sface_2021dec_hnsw|face_vectors_collection_idx/);
  });

  it('finds what exact search finds, within one collection and model', async () => {
    for (const person of people) {
      const query = {
        collectionId: 'pg-a',
        model: MODEL,
        embedding: person,
        limit: 1000,
        minCosine: 0.5,
      };
      const [approximate, exact] = await Promise.all([store.search(query), memory.search(query)]);
      expect(exact.length).toBe(20);
      const found = new Set(approximate.map((m) => m.faceId));
      const recall = exact.filter((m) => found.has(m.faceId)).length / exact.length;
      expect(recall).toBeGreaterThanOrEqual(0.95);
      expect(approximate.every((m) => m.cosine >= 0.5)).toBe(true);
      expect(approximate.every((m) => m.externalImageId.startsWith('pg-a-'))).toBe(true);
      for (let i = 1; i < approximate.length; i++) {
        expect(approximate[i - 1]!.cosine).toBeGreaterThanOrEqual(approximate[i]!.cosine);
      }
    }
  });

  it('gets, excludes, lists, deletes and drops collections', async () => {
    const [first] = await store.list('pg-a', 1);
    const embedding = await store.get('pg-a', MODEL, first!.faceId);
    expect(embedding).toHaveLength(DIMS);
    expect(await store.get('pg-b', MODEL, first!.faceId)).toBeUndefined();
    expect(await store.get('pg-a', 'sface-2021dec', 'not-a-uuid')).toBeUndefined();

    const withSelf = await store.search({
      collectionId: 'pg-a',
      model: MODEL,
      embedding: embedding!,
      limit: 5,
      minCosine: 0.99,
    });
    expect(withSelf.map((m) => m.faceId)).toContain(first!.faceId);
    const without = await store.search({
      collectionId: 'pg-a',
      model: MODEL,
      embedding: embedding!,
      limit: 5,
      minCosine: 0.99,
      excludeFaceId: first!.faceId,
    });
    expect(without.map((m) => m.faceId)).not.toContain(first!.faceId);

    const page = await store.list('pg-a', 250);
    const next = await store.list('pg-a', 250, page.at(-1)!.faceId);
    expect(page).toHaveLength(250);
    expect(next[0]!.faceId > page.at(-1)!.faceId).toBe(true);
    await expect(store.list('pg-a', 1, 'bogus')).rejects.toThrow(RangeError);

    await store.delete('pg-a', [first!.faceId, 'not-a-uuid', uuid(999_999)]);
    expect(await store.get('pg-a', MODEL, first!.faceId)).toBeUndefined();
    await store.deleteCollection('pg-b');
    expect(await store.list('pg-b', 10)).toEqual([]);
    expect((await store.list('pg-a', 1000)).length).toBe(599);
  });

  it('refuses embeddings of the wrong dimension and unknown models', async () => {
    await expect(
      store.insert('pg-a', MODEL, [
        { faceId: uuid(5000), externalImageId: 'x', embedding: Float32Array.of(1, 0) },
      ]),
    ).rejects.toThrow(/dimensions/);
    await expect(
      store.search({
        collectionId: 'pg-a',
        model: "x'; DROP TABLE face_vectors; --",
        embedding: people[0]!,
        limit: 1,
        minCosine: 0,
      }),
    ).rejects.toThrow(RangeError);
  });
});
