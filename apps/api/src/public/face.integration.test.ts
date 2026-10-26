import { activityEvents, consents, faceDeletions, faceFeedback, faces, folders } from '@shotx/db';
import { faceCollectionId } from '@shotx/face';
import { FakeFaceProvider } from '@shotx/face/testing';
import {
  apiPath,
  DRIVE_ROUTES,
  faceScanResultKey,
  faceSearchResponseSchema,
  ME_ROUTES,
  PUBLIC_SHARE_ROUTES as P,
  SHARE_ROUTES,
  shareItemsResponseSchema,
  shareMetaResponseSchema,
} from '@shotx/shared';
import { and, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openPglite, type TestDatabase } from '../testing/database';
import { emptyPhoto, eventPhoto, indexPhoto, selfie, testWorld } from '../testing/faces';
import { type Browser, TestApi } from '../testing/harness';
import { encodeForm, rawPost } from '../testing/raw-http';
import { cloudFrontOriginHeaders } from '../http/client';
import { unreachableBullMqSender } from '../testing/fakes';

const world = testWorld();
const VERSION = '2026-10-25';
const search = (token: string) => apiPath(P.faceSearch, { token });
const deletion = (token: string) => apiPath(P.faceDeletion, { token });
const consent = (token: string) => apiPath(P.giveConsent, { token });
const feedback = (token: string) => apiPath(P.feedback, { token });
const items = (token: string) => `${apiPath(P.items, { token })}?limit=100`;
const downloads = (token: string) => apiPath(P.downloads, { token });

function form(
  ...parts: { bytes: Buffer; type?: string; name?: string; field?: string }[]
): FormData {
  const f = new FormData();
  for (const p of parts) {
    f.append(
      p.field ?? 'selfie',
      new Blob([new Uint8Array(p.bytes)], { type: p.type ?? 'image/jpeg' }),
      p.name ?? 'selfie.jpg',
    );
  }
  return f;
}

describe('face search with FACE_SEARCH_ENABLED=false', () => {
  let database: TestDatabase;
  let api: TestApi;

  beforeAll(async () => {
    database = await openPglite();
    api = await TestApi.start(database.db);
  }, 120_000);
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  it('answers FEATURE_DISABLED for face-search consent, search, feedback and enabling an index', async () => {
    const owner = await api.photographer();
    const root = await api.folder(owner.id, { faceIndex: true });
    const s = await api.share(owner.id, { folderId: root.id });
    const provider = api.faceProvider as FakeFaceProvider;
    const disabled = {
      status: 404,
      body: { code: 'FEATURE_DISABLED', details: { feature: 'face_search' } },
    };
    const me = await selfie(world, 'alice');
    expect(
      await api.request('POST', consent(s.token), {
        body: { policyVersion: VERSION, accepted: true },
      }),
    ).toMatchObject(disabled);
    expect(await api.request('POST', search(s.token), { form: form({ bytes: me }) })).toMatchObject(
      disabled,
    );
    // Face deletion is a PDPA right: never FEATURE_DISABLED, but it still needs its own consent.
    const b = api.browser();
    expect(await b.request('POST', deletion(s.token), { form: form({ bytes: me }) })).toMatchObject(
      { status: 403, body: { code: 'CONSENT_REQUIRED' } },
    );
    expect(
      await b.request('POST', consent(s.token), {
        body: { purpose: 'face_deletion', policyVersion: VERSION, accepted: true },
      }),
    ).toMatchObject({ status: 200, body: { purpose: 'face_deletion', policyVersion: VERSION } });
    // The owner has no searchable faces: 0 without any Rekognition call.
    expect(await b.request('POST', deletion(s.token), { form: form({ bytes: me }) })).toMatchObject(
      { status: 202, body: { facesMatched: 0 } },
    );
    expect(
      await api.request('POST', feedback(s.token), { body: { fileId: root.id } }),
    ).toMatchObject(disabled);
    expect(
      await api.request('PATCH', apiPath(DRIVE_ROUTES.updateFaceIndex, { id: root.id }), {
        token: owner.token,
        body: { enabled: true, attendeesInformedConfirmed: true },
      }),
    ).toMatchObject(disabled);
    expect(
      await api.request('POST', apiPath(SHARE_ROUTES.create), {
        token: owner.token,
        body: { target: { type: 'folder', folderId: root.id }, mode: 'face_only' },
      }),
    ).toMatchObject(disabled);
    expect(provider.calls.searchFacesByImage).toBe(0);
    // Turning an index off always works.
    const off = await api.request('PATCH', apiPath(DRIVE_ROUTES.updateFaceIndex, { id: root.id }), {
      token: owner.token,
      body: { enabled: false },
    });
    expect(off).toMatchObject({
      status: 200,
      body: { faceIndexEnabled: false, faceIndexExpiresAt: null },
    });
    expect(api.queue.messages('faces')).toEqual([{ type: 'unindex.folder', folderId: root.id }]);
  });

  it('reports face search as unavailable in the share meta and /me', async () => {
    const owner = await api.photographer();
    const root = await api.folder(owner.id, { faceIndex: true });
    const s = await api.share(owner.id, { folderId: root.id });
    const meta = shareMetaResponseSchema.parse(
      (await api.request('GET', apiPath(P.meta, { token: s.token }))).body,
    );
    expect(meta.faceSearch).toEqual({
      available: false,
      policyVersion: null,
      consented: false,
      maxSelfies: api.config.face.search.maxSelfies,
      selfieLongEdge: api.config.face.selfie.longEdge,
      selfieJpegQuality: api.config.face.selfie.jpegQuality,
      resultTtlSeconds: api.config.share.faceOnlyGrantTtlSeconds,
    });
    expect(meta.zip).toEqual({ maxFiles: api.config.share.zip.maxFiles });
    const me = await api.request('GET', apiPath(ME_ROUTES.get), { token: owner.token });
    expect(me.body).toMatchObject({ features: { faceSearch: false } });
  });
});

describe('face search with FACE_SEARCH_ENABLED=true', () => {
  let database: TestDatabase;
  let api: TestApi;
  let provider: FakeFaceProvider;

  beforeAll(async () => {
    database = await openPglite();
    provider = new FakeFaceProvider(world);
    api = await TestApi.start(database.db, {
      faceProvider: provider,
      env: {
        FACE_SEARCH_ENABLED: 'true',
        FACE_SEARCH_MAX_SELFIE_BYTES: String(512 * 1024),
        FACE_SEARCH_MAX_BODY_BYTES: String(3 * 512 * 1024 + 16 * 1024),
        FACE_SEARCH_RATE_PER_VIEWER: '6',
        FACE_SEARCH_RATE_PER_IP: '8',
      },
    });
  }, 120_000);
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  /** An indexed event: alice strong in f1, alice small (maybe) in f2, bob in f3; extras outside. */
  async function event(mode: 'gallery' | 'face_only' = 'gallery') {
    const owner = await api.photographer();
    const root = await api.folder(owner.id, { faceIndex: true });
    const outside = await api.folder(owner.id, { faceIndex: true });
    const f1 = await api.file(owner.id, root.id);
    const f2 = await api.file(owner.id, root.id);
    const f3 = await api.file(owner.id, root.id);
    const out = await api.file(owner.id, outside.id);
    const trashed = await api.file(owner.id, root.id);
    await indexPhoto(
      api.db,
      provider,
      owner.id,
      f1.id,
      await eventPhoto(world, [
        { personId: 'alice', size: 220 },
        { personId: 'bob', size: 220 },
      ]),
    );
    await indexPhoto(
      api.db,
      provider,
      owner.id,
      f2.id,
      await eventPhoto(world, [{ personId: 'alice', size: 100 }]),
    );
    await indexPhoto(
      api.db,
      provider,
      owner.id,
      f3.id,
      await eventPhoto(world, [{ personId: 'bob', size: 220 }]),
    );
    await indexPhoto(
      api.db,
      provider,
      owner.id,
      out.id,
      await eventPhoto(world, [{ personId: 'alice', size: 220 }]),
    );
    await indexPhoto(
      api.db,
      provider,
      owner.id,
      trashed.id,
      await eventPhoto(world, [{ personId: 'alice', size: 220 }]),
    );
    await api.trashFile(trashed.id);
    const share = await api.share(owner.id, { folderId: root.id }, { mode });
    return { owner, root, f1, f2, f3, out, trashed, share };
  }

  let ip = 1;
  /**
   * A browser with its own client address (CloudFront-Viewer-Address, trusted because the request
   * carries CloudFront's markers), so per-IP limits stay apart.
   */
  function browser(address = `198.51.100.${ip++}`): Browser {
    const b = api.browser();
    Object.assign(b.headers, cloudFrontOriginHeaders(`${address}:443`));
    return b;
  }

  async function consented(
    token: string,
    b: Browser = browser(),
    purposes: readonly ('face_search' | 'face_deletion')[] = ['face_search'],
  ): Promise<Browser> {
    for (const purpose of purposes) {
      const res = await b.request('POST', consent(token), {
        body: { purpose, policyVersion: VERSION, accepted: true },
      });
      expect(res.status).toBe(200);
    }
    return b;
  }

  it('requires consent for the current version before any Rekognition call', async () => {
    const { share } = await event();
    const before = provider.calls.searchFacesByImage;
    const res = await browser().request('POST', search(share.token), {
      form: form({ bytes: await selfie(world, 'alice') }),
    });
    expect(res).toMatchObject({
      status: 403,
      body: { code: 'CONSENT_REQUIRED', details: { policyVersion: VERSION } },
    });
    expect(provider.calls.searchFacesByImage).toBe(before);
    // A well-formed but stale version: 409 with the current one. A malformed one: 400.
    const old = await api.request('POST', consent(share.token), {
      body: { policyVersion: '2020-01-01', accepted: true },
    });
    expect(old).toMatchObject({
      status: 409,
      body: { code: 'CONSENT_VERSION_MISMATCH', details: { policyVersion: VERSION } },
    });
    const malformed = await api.request('POST', consent(share.token), {
      body: { policyVersion: '../v1', accepted: true },
    });
    expect(malformed).toMatchObject({ status: 400, body: { code: 'VALIDATION_FAILED' } });
    expect(await api.db.select().from(consents).where(eq(consents.shareId, share.id))).toEqual([]);
  });

  it('records consent idempotently with an ip_hash, never the address', async () => {
    const { share } = await event();
    const b = await consented(share.token);
    const again = await b.request('POST', consent(share.token), {
      body: { policyVersion: VERSION, accepted: true },
    });
    expect(again.body).toMatchObject({ purpose: 'face_search', policyVersion: VERSION });
    const rows = await api.db.select().from(consents).where(eq(consents.shareId, share.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: 'face_search', policyVersion: VERSION });
    expect(rows[0]?.ipHash).toMatch(/^v1:[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(rows)).not.toContain('127.0.0.1');
    const meta = shareMetaResponseSchema.parse(
      (await b.request('GET', apiPath(P.meta, { token: share.token }))).body,
    );
    expect(meta.faceSearch).toMatchObject({
      available: true,
      policyVersion: VERSION,
      consented: true,
    });
  });

  it('buckets matches into strong and maybe, within the share scope only', async () => {
    const { share, f1, f2, owner } = await event();
    const b = await consented(share.token);
    const res = await b.request('POST', search(share.token), {
      form: form({ bytes: await selfie(world, 'alice') }),
    });
    expect(res.status).toBe(200);
    const body = faceSearchResponseSchema.parse(res.body);
    expect(body.strong.map((i) => i.id)).toEqual([f1.id]);
    expect(body.maybe.map((i) => i.id)).toEqual([f2.id]);
    expect(body).toMatchObject({ selfies: 1, selfiesWithoutFace: 0 });
    // Signed thumb/preview URLs only: no face ids, boxes or scores.
    const text = JSON.stringify(res.body);
    const faceIds = (
      await api.db
        .select({ id: faces.rekognitionFaceId })
        .from(faces)
        .where(eq(faces.ownerId, owner.id))
    ).map((f) => f.id);
    for (const id of faceIds) expect(text).not.toContain(id);
    expect(text).not.toMatch(/similarity|bbox|boundingBox/i);
    expect(body.strong[0]?.thumbUrl).toContain('Signature=');

    // The result is stored as fileId -> similarity, with a TTL.
    const key = faceScanResultKey(share.id, { kind: 'anon', anonId: b.cookie('shotx_anon') ?? '' });
    const stored = await api.store.hashGetAll(key);
    expect(Object.keys(stored).sort()).toEqual([f1.id, f2.id].sort());
    expect(Number(stored[f1.id])).toBeGreaterThanOrEqual(95);
    expect(api.store.ttlSeconds(key)).toBe(api.config.share.faceOnlyGrantTtlSeconds);

    // One scan event with counts only, and a view event for the URLs.
    const events = await api.db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.shareId, share.id));
    expect(events.find((e) => e.type === 'scan')).toMatchObject({
      fileId: null,
      bytes: 0,
      meta: { selfies: 1, strong: 1, maybe: 1 },
    });
    expect(events.find((e) => e.type === 'view')).toMatchObject({ meta: { items: 2 } });
    // The search used the share owner's collection.
    expect(provider.storedFaces(faceCollectionId(owner.id)).length).toBeGreaterThan(0);
  });

  it('answers NO_FACE_DETECTED when no selfie has a face, and counts partial misses', async () => {
    const { share } = await event();
    const b = await consented(share.token);
    const none = await b.request('POST', search(share.token), {
      form: form({ bytes: await emptyPhoto(world) }),
    });
    expect(none).toMatchObject({
      status: 422,
      body: { code: 'NO_FACE_DETECTED', details: { selfies: 1, selfiesWithoutFace: 1 } },
    });
    const partial = await b.request('POST', search(share.token), {
      form: form({ bytes: await emptyPhoto(world) }, { bytes: await selfie(world, 'alice') }),
    });
    expect(partial.body).toMatchObject({ selfies: 2, selfiesWithoutFace: 1 });
  });

  it('is FACE_SEARCH_UNAVAILABLE on file shares and shares without an active index', async () => {
    const owner = await api.photographer();
    const f = await api.file(owner.id, null);
    const fileShare = await api.share(owner.id, { fileId: f.id });
    const plain = await api.folder(owner.id);
    const plainShare = await api.share(owner.id, { folderId: plain.id });
    for (const [s, reason] of [
      [fileShare, 'not_folder_share'],
      [plainShare, 'not_indexed'],
    ] as const) {
      const b = await consented(s.token);
      const res = await b.request('POST', search(s.token), {
        form: form({ bytes: await selfie(world, 'alice') }),
      });
      expect(res).toMatchObject({
        status: 409,
        body: { code: 'FACE_SEARCH_UNAVAILABLE', details: { reason } },
      });
    }
  });

  it('enforces the face_only grant on items and downloads; withdrawal revokes it', async () => {
    const { share, f1, f2, f3 } = await event('face_only');
    const b = await consented(share.token);
    const meta = shareMetaResponseSchema.parse(
      (await b.request('GET', apiPath(P.meta, { token: share.token }))).body,
    );
    expect(meta.details).toMatchObject({ itemCount: null, cover: null });
    const ids = async () =>
      shareItemsResponseSchema
        .parse((await b.request('GET', items(share.token))).body)
        .items.map((i) => i.id);
    expect(await ids()).toEqual([]);
    await b.request('POST', search(share.token), {
      form: form({ bytes: await selfie(world, 'alice') }),
    });
    expect((await ids()).sort()).toEqual([f1.id, f2.id].sort());
    expect(
      (await b.request('POST', downloads(share.token), { body: { fileIds: [f3.id] } })).status,
    ).toBe(404);
    expect(
      (await b.request('POST', downloads(share.token), { body: { fileIds: [f1.id] } })).status,
    ).toBe(200);
    // Another browser has no grant.
    expect(
      (await api.browser().request('POST', downloads(share.token), { body: { fileIds: [f1.id] } }))
        .status,
    ).toBe(404);
    // Withdrawal deletes the result, and with it the grant.
    expect((await b.request('DELETE', consent(share.token))).status).toBe(204);
    expect(await ids()).toEqual([]);
    const [row] = await api.db.select().from(consents).where(eq(consents.shareId, share.id));
    expect(row?.withdrawnAt).not.toBeNull();
    const again = await b.request('POST', search(share.token), {
      form: form({ bytes: await selfie(world, 'alice') }),
    });
    expect(again.body).toMatchObject({ code: 'CONSENT_REQUIRED' });
  });

  it('records "not me" feedback with the stored similarity, once', async () => {
    const { share, f2 } = await event('face_only');
    const b = await consented(share.token);
    await b.request('POST', search(share.token), {
      form: form({ bytes: await selfie(world, 'alice') }),
    });
    expect(
      (await b.request('POST', feedback(share.token), { body: { fileId: f2.id } })).status,
    ).toBe(204);
    expect(
      (await b.request('POST', feedback(share.token), { body: { fileId: f2.id } })).status,
    ).toBe(204);
    const rows = await api.db.select().from(faceFeedback).where(eq(faceFeedback.shareId, share.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fileId: f2.id, verdict: 'not_me' });
    expect(rows[0]?.similarity).toBeGreaterThanOrEqual(85);
    expect(rows[0]?.similarity).toBeLessThan(95);
    // The file left the result: in face_only mode the viewer no longer sees it.
    const listed = shareItemsResponseSchema.parse(
      (await b.request('GET', items(share.token))).body,
    );
    expect(listed.items.map((i) => i.id)).not.toContain(f2.id);
  });

  it('marks matched faces for deletion across the whole collection and enqueues delete.faces', async () => {
    const { share, owner, out, f1 } = await event();
    const b = await consented(share.token, browser(), ['face_search', 'face_deletion']);
    const res = await b.request('POST', deletion(share.token), {
      form: form({ bytes: await selfie(world, 'alice') }),
    });
    expect(res.status).toBe(202);
    const { facesMatched } = res.body as { facesMatched: number };
    // f1, out and trashed hold big alice faces (>= 95); the small face in f2 is below the threshold.
    expect(facesMatched).toBe(3);
    const marked = await api.db
      .select({ fileId: faces.fileId })
      .from(faces)
      .where(and(eq(faces.ownerId, owner.id), isNotNull(faces.deletionId)));
    expect(marked.map((m) => m.fileId)).toEqual(expect.arrayContaining([f1.id, out.id]));
    const [record] = await api.db
      .select()
      .from(faceDeletions)
      .where(eq(faceDeletions.shareId, share.id));
    expect(record).toMatchObject({ facesMatched: 3, facesDeleted: null });
    expect(api.queue.messages('faces')).toContainEqual({
      type: 'delete.faces',
      deletionId: record?.id,
    });
    // Hidden from search at once (the faces are still in the collection until the worker runs).
    const after = faceSearchResponseSchema.parse(
      (
        await b.request('POST', search(share.token), {
          form: form({ bytes: await selfie(world, 'alice') }),
        })
      ).body,
    );
    expect(after.strong).toEqual([]);
  });

  it('undoes the marking when delete.faces cannot be sent', async () => {
    const { share, owner } = await event();
    const b = await consented(share.token, browser(), ['face_deletion']);
    api.queue.failing = true;
    try {
      const res = await b.request('POST', deletion(share.token), {
        form: form({ bytes: await selfie(world, 'alice') }),
      });
      expect(res.status).toBe(500);
    } finally {
      api.queue.failing = false;
    }
    const marked = await api.db
      .select()
      .from(faces)
      .where(and(eq(faces.ownerId, owner.id), isNotNull(faces.deletionId)));
    expect(marked).toEqual([]);
    expect(
      await api.db.select().from(faceDeletions).where(eq(faceDeletions.shareId, share.id)),
    ).toEqual([]);
  });

  it('fails (and undoes the marking) instead of hanging when Redis is unreachable', async () => {
    const { share, owner } = await event();
    const b = await consented(share.token, browser(), ['face_deletion']);
    const unreachable = unreachableBullMqSender(300);
    api.queue.delegate = unreachable.sender;
    try {
      const started = Date.now();
      const res = await b.request('POST', deletion(share.token), {
        form: form({ bytes: await selfie(world, 'alice') }),
      });
      expect(res.status).toBe(500);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      api.queue.delegate = null;
      await unreachable.close();
    }
    const marked = await api.db
      .select()
      .from(faces)
      .where(and(eq(faces.ownerId, owner.id), isNotNull(faces.deletionId)));
    expect(marked).toEqual([]);
    expect(
      await api.db.select().from(faceDeletions).where(eq(faceDeletions.shareId, share.id)),
    ).toEqual([]);
  });

  describe('request body', () => {
    let token: string;
    let b: Browser;
    beforeAll(async () => {
      const { share } = await event();
      token = share.token;
    });
    beforeEach(async () => {
      b = await consented(token);
    });

    it('accepts multipart/form-data only', async () => {
      const res = await b.request('POST', search(token), { body: { selfie: 'x' } });
      expect(res).toMatchObject({ status: 400, body: { code: 'VALIDATION_FAILED' } });
    });

    /** POSTs a form over a raw socket, so early answers are read even if the upload is cut off. */
    async function post(f: FormData) {
      const { body, contentType } = await encodeForm(f);
      return rawPost(
        api.baseUrl,
        search(token),
        { ...b.headers, cookie: b.cookieHeader(search(token)), 'content-type': contentType },
        body,
      );
    }

    it('rejects more than FACE_MAX_SELFIES parts and parts of another name', async () => {
      const s = await selfie(world, 'alice');
      const many = await post(form({ bytes: s }, { bytes: s }, { bytes: s }, { bytes: s }));
      expect(many).toMatchObject({ status: 400, body: { code: 'VALIDATION_FAILED' } });
      const named = await post(form({ bytes: s, field: 'photo' }));
      expect(named).toMatchObject({ status: 400, body: { code: 'VALIDATION_FAILED' } });
      const empty = new FormData();
      empty.append('note', 'hello');
      expect((await post(empty)).status).toBe(400);
    });

    it('rejects other types and bytes that are not what they claim', async () => {
      const s = await selfie(world, 'alice');
      const gif = await post(form({ bytes: s, type: 'image/gif', name: 'a.gif' }));
      expect(gif).toMatchObject({
        status: 415,
        body: { code: 'UNSUPPORTED_FILE_TYPE', details: { extension: 'gif' } },
      });
      const fake = await post(form({ bytes: s, type: 'image/png', name: 'a.png' }));
      expect(fake).toMatchObject({ status: 415, body: { code: 'UNSUPPORTED_FILE_TYPE' } });
    });

    it('rejects a selfie over FACE_SEARCH_MAX_SELFIE_BYTES while reading', async () => {
      const big = Buffer.concat([await selfie(world, 'alice'), Buffer.alloc(600 * 1024)]);
      const res = await post(form({ bytes: big }));
      expect(res).toMatchObject({
        status: 413,
        headers: { connection: 'close' },
        body: { code: 'PAYLOAD_TOO_LARGE' },
      });
    });

    it('rejects a declared Content-Length over FACE_SEARCH_MAX_BODY_BYTES before reading', async () => {
      const res = await rawPost(
        api.baseUrl,
        search(token),
        {
          ...b.headers,
          cookie: b.cookieHeader(search(token)),
          'content-type': 'multipart/form-data; boundary=x',
        },
        Buffer.alloc(2 * 1024 * 1024, 0x78),
      );
      expect(res).toMatchObject({ status: 413, body: { code: 'PAYLOAD_TOO_LARGE' } });
    });

    it('aborts a chunked body without Content-Length once it passes the limit', async () => {
      const boundary = 'xBOUNDARYx';
      const total = 64 * 1024 * 1024;
      let sent = 0;
      function* chunks() {
        yield Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="selfie"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
        );
        yield Buffer.from([0xff, 0xd8, 0xff]);
        while (sent < total) {
          sent += 64 * 1024;
          yield Buffer.alloc(64 * 1024, 7);
        }
      }
      const res = await rawPost(
        api.baseUrl,
        search(token),
        {
          ...b.headers,
          cookie: b.cookieHeader(search(token)),
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        { chunks: chunks() },
      );
      expect(res).toMatchObject({ status: 413, body: { code: 'PAYLOAD_TOO_LARGE' } });
      // The server stopped reading long before the client finished.
      expect(sent).toBeLessThan(total);
    });
  });

  it('rate-limits face search per viewer', async () => {
    const { share } = await event();
    const b = await consented(share.token);
    const s = await selfie(world, 'bob');
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push(
        (await b.request('POST', search(share.token), { form: form({ bytes: s }) })).status,
      );
    }
    expect(statuses.slice(0, 6).every((x) => x === 200)).toBe(true);
    expect(statuses[6]).toBe(429);
  });

  it('rate-limits face search and face deletion per IP, across viewers', async () => {
    const { share } = await event();
    const address = '203.0.113.77';
    const s = await selfie(world, 'bob');
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const b = await consented(share.token, browser(address), ['face_search', 'face_deletion']);
      for (let j = 0; j < 3; j++) {
        const path = j === 2 ? deletion(share.token) : search(share.token);
        statuses.push((await b.request('POST', path, { form: form({ bytes: s }) })).status);
      }
    }
    expect(statuses.filter((x) => x === 429)).toHaveLength(1);
    expect(statuses.at(-1)).toBe(429);
  });

  it('never logs selfie bytes, even when the search fails', async () => {
    const { share } = await event();
    const b = await consented(share.token);
    const marker = 'SELFIE-MARKER-7f3a9c';
    const bytes = Buffer.concat([await selfie(world, 'carol'), Buffer.from(marker)]);
    provider.failNext('searchFacesByImage', new Error('Rekognition exploded'));
    const res = await b.request('POST', search(share.token), { form: form({ bytes }) });
    expect(res).toMatchObject({ status: 500, body: { code: 'INTERNAL_ERROR' } });
    const logs = api.logger.text();
    expect(logs).toContain('POST /api/s/:token/face-search failed: Error');
    expect(logs).not.toContain(marker);
    expect(logs).not.toContain(bytes.subarray(0, 48).toString('base64'));
    expect(logs).not.toContain(bytes.subarray(0, 32).toString('hex'));
    expect(logs).not.toContain(bytes.subarray(0, 64).toString('latin1'));
  });

  it('fails closed when Redis is down', async () => {
    const { share } = await event();
    const b = await consented(share.token);
    api.store.failing = true;
    try {
      const res = await b.request('POST', search(share.token), {
        form: form({ bytes: await selfie(world, 'alice') }),
      });
      expect(res.status).toBe(500);
      const owner = await api.photographer();
      const folder = await api.folder(owner.id);
      const locked = await api.share(owner.id, { folderId: folder.id }, { password: 'pin1' });
      // Without an unlock cookie there is nothing to look up: PASSWORD_REQUIRED.
      expect((await api.request('GET', items(locked.token))).status).toBe(403);
      // With one, the lookup fails and the request is denied.
      const withCookie = api.browser();
      withCookie.setCookie('shotx_unlock', 'A'.repeat(22), `/api/s/${locked.token}`);
      expect((await withCookie.request('GET', items(locked.token))).status).toBe(500);
    } finally {
      api.store.failing = false;
    }
  });

  describe('PATCH /drive/folders/:id/face-index', () => {
    const path = (id: string) => apiPath(DRIVE_ROUTES.updateFaceIndex, { id });

    it('needs the attendees-informed confirmation, sets the expiry and sends index.folder once', async () => {
      const owner = await api.photographer();
      const folder = await api.folder(owner.id);
      const missing = await api.request('PATCH', path(folder.id), {
        token: owner.token,
        body: { enabled: true },
      });
      expect(missing).toMatchObject({ status: 400, body: { code: 'VALIDATION_FAILED' } });
      const sent = api.queue.sent.length;
      const on = await api.request('PATCH', path(folder.id), {
        token: owner.token,
        body: { enabled: true, attendeesInformedConfirmed: true },
      });
      const days = api.config.retention.faceIndexExpiryDays;
      expect(on).toMatchObject({
        status: 200,
        body: {
          faceIndexEnabled: true,
          faceIndexExpiresAt: new Date(api.clock.now().getTime() + days * 86_400_000).toISOString(),
        },
      });
      const [row] = await api.db.select().from(folders).where(eq(folders.id, folder.id));
      expect(row?.faceIndexInformedAt).not.toBeNull();
      // Outbox mark for faces.sweep, set with the enabling transaction.
      const queuedAt = api.clock.now();
      expect(row?.faceIndexQueuedAt).toEqual(queuedAt);
      expect(api.queue.sent.slice(sent).map((m) => JSON.parse(m.body) as unknown)).toEqual([
        { type: 'index.folder', folderId: folder.id },
      ]);
      // Extending an active index sends nothing more.
      api.clock.advance(86_400_000);
      const again = await api.request('PATCH', path(folder.id), {
        token: owner.token,
        body: { enabled: true, attendeesInformedConfirmed: true },
      });
      expect((again.body as { faceIndexExpiresAt: string }).faceIndexExpiresAt).toBe(
        new Date(api.clock.now().getTime() + days * 86_400_000).toISOString(),
      );
      expect(api.queue.sent.length).toBe(sent + 1);
      // Extending doesn't move the mark (no index.folder was sent).
      const [extended] = await api.db.select().from(folders).where(eq(folders.id, folder.id));
      expect(extended?.faceIndexQueuedAt).toEqual(queuedAt);
      const off = await api.request('PATCH', path(folder.id), {
        token: owner.token,
        body: { enabled: false },
      });
      expect(off.body).toMatchObject({ faceIndexEnabled: false, faceIndexExpiresAt: null });
      const [offRow] = await api.db.select().from(folders).where(eq(folders.id, folder.id));
      expect(offRow?.faceIndexQueuedAt).toBeNull();
      expect(JSON.parse(api.queue.sent.at(-1)?.body ?? '{}')).toEqual({
        type: 'unindex.folder',
        folderId: folder.id,
      });
    });

    it('is NOT_FOUND for another photographer and SUBSCRIPTION_INACTIVE when expired', async () => {
      const owner = await api.photographer();
      const folder = await api.folder(owner.id);
      const other = await api.photographer();
      const body = { enabled: true, attendeesInformedConfirmed: true };
      expect(
        (await api.request('PATCH', path(folder.id), { token: other.token, body })).status,
      ).toBe(404);
      const lapsed = await api.photographer({ status: 'expired' });
      const lf = await api.folder(lapsed.id);
      expect(await api.request('PATCH', path(lf.id), { token: lapsed.token, body })).toMatchObject({
        status: 403,
        body: { code: 'SUBSCRIPTION_INACTIVE', details: { status: 'expired' } },
      });
    });

    it('undoes enabling when index.folder cannot be sent', async () => {
      const owner = await api.photographer();
      const folder = await api.folder(owner.id);
      api.queue.failing = true;
      try {
        const res = await api.request('PATCH', path(folder.id), {
          token: owner.token,
          body: { enabled: true, attendeesInformedConfirmed: true },
        });
        expect(res.status).toBe(500);
      } finally {
        api.queue.failing = false;
      }
      const [row] = await api.db.select().from(folders).where(eq(folders.id, folder.id));
      expect(row).toMatchObject({
        faceIndexEnabled: false,
        faceIndexExpiresAt: null,
        faceIndexQueuedAt: null,
      });
    });
  });
});
