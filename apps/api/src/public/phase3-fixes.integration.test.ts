import { activityEvents, consents, faceDeletions, faces, subscriptions } from '@shotx/db';
import { FakeFaceProvider } from '@shotx/face/testing';
import {
  apiPath,
  FACE_DELETION_ALERT_EVENT,
  faceDeletionInfoResponseSchema,
  faceScanResultKey,
  PUBLIC_SHARE_ROUTES as P,
  shareMetaResponseSchema,
} from '@shotx/shared';
import { and, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cloudFrontOriginHeaders, ipHash } from '../http/client';
import { openPglite, type TestDatabase } from '../testing/database';
import { eventPhoto, indexPhoto, selfie, testWorld } from '../testing/faces';
import { type Browser, TestApi } from '../testing/harness';

// Phase 3 review fixes: face deletion gates and alert, consent purposes and versions, meta without
// view events and with the face/zip settings, client address behind CloudFront, atomic scan merge.

const world = testWorld();
const VERSION = '2026-10-25';
const consent = (token: string) => apiPath(P.giveConsent, { token });
const deletion = (token: string) => apiPath(P.faceDeletion, { token });
const deletionInfo = (token: string) => apiPath(P.faceDeletionInfo, { token });
const search = (token: string) => apiPath(P.faceSearch, { token });
const meta = (token: string) => apiPath(P.meta, { token });
const items = (token: string) => apiPath(P.items, { token });
const unlock = (token: string) => apiPath(P.unlock, { token });

function form(...selfies: Buffer[]): FormData {
  const f = new FormData();
  for (const bytes of selfies) {
    f.append('selfie', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), 'selfie.jpg');
  }
  return f;
}

for (const flag of ['true', 'false'] as const) {
  describe(`face deletion with FACE_SEARCH_ENABLED=${flag}`, () => {
    let database: TestDatabase;
    let api: TestApi;
    let provider: FakeFaceProvider;

    beforeAll(async () => {
      database = await openPglite();
      provider = new FakeFaceProvider(world);
      api = await TestApi.start(database.db, {
        faceProvider: provider,
        env: {
          FACE_SEARCH_ENABLED: flag,
          FACE_DELETION_ALERT_PER_SHARE: '2',
          FACE_SEARCH_RATE_PER_IP: '100',
          FACE_SEARCH_RATE_PER_SHARE: '100',
          FACE_SEARCH_RATE_PER_VIEWER: '100',
        },
      });
    }, 120_000);
    afterAll(async () => {
      await api?.close();
      await database?.close();
    });

    async function indexed(options: Parameters<TestApi['share']>[2] = {}) {
      const owner = await api.photographer();
      const root = await api.folder(owner.id, { faceIndex: true });
      const f1 = await api.file(owner.id, root.id);
      const f2 = await api.file(owner.id, root.id);
      await indexPhoto(
        api.db,
        provider,
        owner.id,
        f1.id,
        await eventPhoto(world, [{ personId: 'alice', size: 220 }]),
      );
      await indexPhoto(
        api.db,
        provider,
        owner.id,
        f2.id,
        await eventPhoto(world, [{ personId: 'bob', size: 220 }]),
      );
      const share = await api.share(owner.id, { folderId: root.id }, options);
      return { owner, root, share };
    }

    async function giveDeletionConsent(b: Browser, token: string) {
      const res = await b.request('POST', consent(token), {
        body: { purpose: 'face_deletion', policyVersion: VERSION, accepted: true },
      });
      expect(res).toMatchObject({
        status: 200,
        body: { purpose: 'face_deletion', policyVersion: VERSION },
      });
    }

    const cases = [
      ['revoked', { isActive: false }],
      ['expired', { expiresAt: new Date('2026-01-01T00:00:00Z') }],
      ['password', { password: 'pin-0000' }],
      ['login', { requireLogin: true }],
    ] as const;

    for (const [label, options] of cases) {
      it(`works on a ${label} share with a face_deletion consent only`, async () => {
        const { share, owner } = await indexed(options);
        const b = api.browser();
        // The info route answers where GET /s/:token can't.
        const info = await b.request('GET', deletionInfo(share.token));
        expect(info.status).toBe(200);
        expect(faceDeletionInfoResponseSchema.parse(info.body)).toEqual({
          policyVersion: VERSION,
          consented: false,
          maxSelfies: api.config.face.search.maxSelfies,
          selfieLongEdge: api.config.face.selfie.longEdge,
          selfieJpegQuality: api.config.face.selfie.jpegQuality,
        });
        // No consent yet: CONSENT_REQUIRED (never SHARE_EXPIRED, LOGIN_REQUIRED, ...).
        const calls = provider.calls.searchFacesByImage;
        expect(
          await b.request('POST', deletion(share.token), {
            form: form(await selfie(world, 'alice')),
          }),
        ).toMatchObject({
          status: 403,
          body: { code: 'CONSENT_REQUIRED', details: { policyVersion: VERSION } },
        });
        // A face_search consent is gated like the share (and doesn't count for deletion).
        const searchConsent = await b.request('POST', consent(share.token), {
          body: { policyVersion: VERSION, accepted: true },
        });
        expect(searchConsent.status).not.toBe(200);
        await giveDeletionConsent(b, share.token);
        expect(
          faceDeletionInfoResponseSchema.parse(
            (await b.request('GET', deletionInfo(share.token))).body,
          ).consented,
        ).toBe(true);
        expect(provider.calls.searchFacesByImage).toBe(calls);
        const res = await b.request('POST', deletion(share.token), {
          form: form(await selfie(world, 'alice')),
        });
        expect(res).toMatchObject({ status: 202, body: { facesMatched: 1 } });
        const marked = await api.db
          .select()
          .from(faces)
          .where(and(eq(faces.ownerId, owner.id), isNotNull(faces.deletionId)));
        expect(marked).toHaveLength(1);
        // No activity events from the deletion routes.
        expect(
          await api.db.select().from(activityEvents).where(eq(activityEvents.shareId, share.id)),
        ).toEqual([]);
      });
    }

    it('works when the owner subscription expired (share unavailable)', async () => {
      const { share, owner } = await indexed();
      await api.db
        .update(subscriptions)
        .set({ status: 'expired' })
        .where(eq(subscriptions.photographerId, owner.id));
      expect((await api.request('GET', meta(share.token))).status).toBe(410);
      const b = api.browser();
      await giveDeletionConsent(b, share.token);
      expect(
        await b.request('POST', deletion(share.token), { form: form(await selfie(world, 'bob')) }),
      ).toMatchObject({ status: 202, body: { facesMatched: 1 } });
    });

    it('a face_search consent does not allow a deletion', async () => {
      if (flag === 'false') return;
      const { share } = await indexed();
      const b = api.browser();
      expect(
        (
          await b.request('POST', consent(share.token), {
            body: { purpose: 'face_search', policyVersion: VERSION, accepted: true },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await b.request('POST', deletion(share.token), {
            form: form(await selfie(world, 'alice')),
          })
        ).body,
      ).toMatchObject({ code: 'CONSENT_REQUIRED' });
      const rows = await api.db.select().from(consents).where(eq(consents.shareId, share.id));
      expect(rows.map((r) => r.purpose)).toEqual(['face_search']);
    });

    it('answers 0 without a Rekognition call when the owner has no collection', async () => {
      const owner = await api.photographer();
      const root = await api.folder(owner.id);
      const share = await api.share(owner.id, { folderId: root.id });
      const b = api.browser();
      await giveDeletionConsent(b, share.token);
      const calls = provider.calls.searchFacesByImage;
      expect(
        await b.request('POST', deletion(share.token), {
          form: form(await selfie(world, 'alice')),
        }),
      ).toMatchObject({ status: 202, body: { facesMatched: 0 } });
      expect(provider.calls.searchFacesByImage).toBe(calls);
    });

    it('is NOT_FOUND for unknown tokens', async () => {
      const token = 'A'.repeat(22);
      expect((await api.request('GET', deletionInfo(token))).status).toBe(404);
      expect(
        (
          await api.request('POST', consent(token), {
            body: { purpose: 'face_deletion', policyVersion: VERSION, accepted: true },
          })
        ).status,
      ).toBe(404);
      expect(
        (await api.request('POST', deletion(token), { form: form(await selfie(world, 'alice')) }))
          .status,
      ).toBe(404);
    });

    it('answers CONSENT_VERSION_MISMATCH for a stale face_deletion version', async () => {
      const { share } = await indexed({ isActive: false });
      expect(
        await api.request('POST', consent(share.token), {
          body: { purpose: 'face_deletion', policyVersion: '2025-01-01', accepted: true },
        }),
      ).toMatchObject({
        status: 409,
        body: { code: 'CONSENT_VERSION_MISMATCH', details: { policyVersion: VERSION } },
      });
    });

    it('logs the per-share alert once deletions reach FACE_DELETION_ALERT_PER_SHARE', async () => {
      const { share, owner, root } = await indexed();
      const carol = await api.file(owner.id, root.id);
      await indexPhoto(
        api.db,
        provider,
        owner.id,
        carol.id,
        await eventPhoto(world, [{ personId: 'carol', size: 220 }]),
      );
      const alerts = () =>
        api.events.of(FACE_DELETION_ALERT_EVENT).filter((e) => e.shareId === share.id);
      const remove = async (person: string) => {
        const b = api.browser();
        await giveDeletionConsent(b, share.token);
        const res = await b.request('POST', deletion(share.token), {
          form: form(await selfie(world, person)),
        });
        expect(res).toMatchObject({ status: 202, body: { facesMatched: 1 } });
      };
      await remove('alice');
      expect(alerts()).toEqual([]);
      await remove('bob');
      // One JSON event with a top-level `event` field, ids and counts only.
      expect(alerts()).toEqual([
        {
          level: 'warn',
          event: FACE_DELETION_ALERT_EVENT,
          timestamp: api.clock.now().toISOString(),
          shareId: share.id,
          ownerId: owner.id,
          count: 2,
          threshold: 2,
          windowSeconds: api.config.face.deletion.alert.windowSeconds,
        },
      ]);
      expect(
        await api.db.select().from(faceDeletions).where(eq(faceDeletions.shareId, share.id)),
      ).toHaveLength(2);
      // Outside the window the earlier deletions no longer count.
      const window = (api.config.face.deletion.alert.windowSeconds + 1) * 1000;
      api.clock.advance(window);
      try {
        await remove('carol');
        expect(alerts()).toHaveLength(1);
      } finally {
        api.clock.advance(-window);
      }
    });
  });
}

describe('share meta, activity and the client address', () => {
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
        FACE_MAX_SELFIES: '2',
        FACE_SELFIE_LONG_EDGE: '1024',
        FACE_SELFIE_JPEG_QUALITY: '80',
        SHARE_FACE_ONLY_GRANT_TTL_SECONDS: '7200',
        ZIP_MAX_FILES: '7',
        SHARE_UNLOCK_RATE_PER_IP: '2',
      },
    });
  }, 120_000);
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  it('meta carries the face and zip settings and writes no view event', async () => {
    const owner = await api.photographer();
    const root = await api.folder(owner.id, { faceIndex: true });
    await api.file(owner.id, root.id);
    const share = await api.share(owner.id, { folderId: root.id });
    const b = api.browser();
    const body = shareMetaResponseSchema.parse((await b.request('GET', meta(share.token))).body);
    expect(body.details?.cover?.previewUrl).toContain('Signature=');
    expect(body.faceSearch).toEqual({
      available: true,
      policyVersion: VERSION,
      consented: false,
      maxSelfies: 2,
      selfieLongEdge: 1024,
      selfieJpegQuality: 80,
      resultTtlSeconds: 7200,
    });
    expect(body.zip).toEqual({ maxFiles: 7 });
    for (let i = 0; i < 3; i++) await b.request('GET', meta(share.token));
    expect(
      await api.db.select().from(activityEvents).where(eq(activityEvents.shareId, share.id)),
    ).toEqual([]);
    // The grid's items page is what counts as a view.
    await b.request('GET', items(share.token));
    const events = await api.db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.shareId, share.id));
    expect(events.map((e) => e.type)).toEqual(['view']);
  });

  it('trusts CloudFront-Viewer-Address only on requests that came through CloudFront', async () => {
    const owner = await api.photographer();
    const root = await api.folder(owner.id, { faceIndex: true });
    const share = await api.share(owner.id, { folderId: root.id }, { password: 'pin-9999' });
    const attempt = (b: Browser) =>
      b.request('POST', unlock(share.token), { body: { password: 'wrong' } });

    // Through CloudFront: two viewers, two addresses, separate per-IP limits (2 each).
    const viaCf = (address: string) => {
      const b = api.browser();
      Object.assign(b.headers, cloudFrontOriginHeaders(`${address}:443`));
      return b;
    };
    const a = viaCf('203.0.113.1');
    const c = viaCf('203.0.113.2');
    expect([(await attempt(a)).status, (await attempt(a)).status]).toEqual([403, 403]);
    expect((await attempt(a)).status).toBe(429);
    expect((await attempt(c)).status).toBe(403);

    // Callers without CloudFront's markers (in-VPC SSR passing a header on, or only one marker)
    // all count as the socket address.
    const forged = (address: string, partial?: 'via' | 'cf-id') => {
      const b = api.browser();
      b.headers['cloudfront-viewer-address'] = `${address}:443`;
      const cf = cloudFrontOriginHeaders(`${address}:443`);
      if (partial === 'via') b.headers.via = cf.via ?? '';
      if (partial === 'cf-id') b.headers['x-amz-cf-id'] = cf['x-amz-cf-id'] ?? '';
      return b;
    };
    const share2 = await api.share(owner.id, { folderId: root.id }, { password: 'pin-8888' });
    const attempt2 = (b: Browser) =>
      b.request('POST', unlock(share2.token), { body: { password: 'wrong' } });
    expect((await attempt2(forged('198.51.100.1'))).status).toBe(403);
    expect((await attempt2(forged('198.51.100.2', 'via'))).status).toBe(403);
    expect((await attempt2(forged('198.51.100.3', 'cf-id'))).status).toBe(429);

    // ip_hash follows the same rule.
    const consentShare = await api.share(owner.id, { folderId: root.id });
    const trusted = viaCf('203.0.113.50');
    const spoofed = forged('203.0.113.50');
    for (const b of [trusted, spoofed]) {
      expect(
        (
          await b.request('POST', consent(consentShare.token), {
            body: { policyVersion: VERSION, accepted: true },
          })
        ).status,
      ).toBe(200);
    }
    const rows = await api.db
      .select({ ipHash: consents.ipHash, anonId: consents.anonId })
      .from(consents)
      .where(eq(consents.shareId, consentShare.id));
    const secret = api.config.consent.ipHashSecret;
    const byAnon = new Map(rows.map((r) => [r.anonId, r.ipHash]));
    expect(byAnon.get(trusted.cookie('shotx_anon') ?? '')).toBe(ipHash(secret, '203.0.113.50'));
    expect(byAnon.get(spoofed.cookie('shotx_anon') ?? '')).not.toBe(ipHash(secret, '203.0.113.50'));
    expect(byAnon.get(spoofed.cookie('shotx_anon') ?? '')).toBe(ipHash(secret, '127.0.0.1'));
  });

  it('merges concurrent scans of one viewer without losing matches', async () => {
    const owner = await api.photographer();
    const root = await api.folder(owner.id, { faceIndex: true });
    const both = await api.file(owner.id, root.id);
    const onlyAlice = await api.file(owner.id, root.id);
    const onlyBob = await api.file(owner.id, root.id);
    await indexPhoto(
      api.db,
      provider,
      owner.id,
      both.id,
      await eventPhoto(world, [
        { personId: 'alice', size: 220 },
        { personId: 'bob', size: 100 },
      ]),
    );
    await indexPhoto(
      api.db,
      provider,
      owner.id,
      onlyAlice.id,
      await eventPhoto(world, [{ personId: 'alice', size: 220 }]),
    );
    await indexPhoto(
      api.db,
      provider,
      owner.id,
      onlyBob.id,
      await eventPhoto(world, [{ personId: 'bob', size: 220 }]),
    );
    const share = await api.share(owner.id, { folderId: root.id }, { mode: 'face_only' });
    const b = api.browser();
    Object.assign(b.headers, cloudFrontOriginHeaders('203.0.113.200:443'));
    expect(
      (
        await b.request('POST', consent(share.token), {
          body: { policyVersion: VERSION, accepted: true },
        })
      ).status,
    ).toBe(200);
    const [alice, bob] = await Promise.all([selfie(world, 'alice'), selfie(world, 'bob')]);
    const results = await Promise.all([
      b.request('POST', search(share.token), { form: form(alice) }),
      b.request('POST', search(share.token), { form: form(bob) }),
      b.request('POST', search(share.token), { form: form(alice) }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const stored = await api.store.hashGetAll(
      faceScanResultKey(share.id, { kind: 'anon', anonId: b.cookie('shotx_anon') ?? '' }),
    );
    expect(Object.keys(stored).sort()).toEqual([both.id, onlyAlice.id, onlyBob.id].sort());
    // `both` keeps alice's strong score, not bob's small-face one.
    expect(Number(stored[both.id])).toBeGreaterThanOrEqual(95);
  });
});
