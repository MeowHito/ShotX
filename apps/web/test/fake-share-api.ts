import {
  CAPTCHA_TOKEN_HEADER,
  type CaptchaAction,
  type CaptchaRejectReason,
  LATEST_CONSENT_POLICY_VERSION,
  type CreateShareBody,
  DRIVE_ROUTES,
  generateShareToken,
  ME_ROUTES,
  type OwnerShare,
  PUBLIC_SHARE_ROUTES,
  type RouteContract,
  SELFIE_FIELD_NAME,
  SELFIE_MIME_TYPES,
  SHARE_ROUTES,
  type ShareItem,
  type ShareMode,
  type ShareStatsResponse,
  type ShareUnavailableReason,
  type UpdateShareBody,
  type ZipJobView,
} from '@shotx/shared';
// Circular at module level only; every use is inside a function that runs after both load.
import { type FakeApi, Fail, MEDIA, NOW } from './fake-api';

/**
 * Phase 3 routes of the fake API: me, owner shares, face index, owner download and the public
 * share routes. The fake models one browser: `viewerSession` is its viewer-session cookie and
 * each share fixture holds its unlock, consent and face-search state.
 */

export const NOT_HANDLED = Symbol('not handled');

/** A share as the public routes see it, with the state of this (single) test browser. */
export interface PublicShareFixture {
  token: string;
  targetType: 'file' | 'folder';
  mode: ShareMode;
  allowDownload: boolean;
  downloadSize: 'web' | 'original';
  requireLogin: boolean;
  password: string | null;
  expiresAt: string | null;
  title: string;
  photographerName: string | null;
  items: ShareItem[];
  /** meta.faceSearch.available (FACE_SEARCH_ENABLED and an indexed folder share). */
  faceSearchAvailable: boolean;
  /** SHARE_EXPIRED with this reason when set. */
  expiredReason: ShareUnavailableReason | null;
  unlocked: boolean;
  /** A current `face_search` consent of this browser. */
  consented: boolean;
  /** A current `face_deletion` consent of this browser. */
  deletionConsented: boolean;
  /** CONSENT_POLICY_VERSION of the API; a consent of another version is a mismatch. */
  serverPolicyVersion: string;
  /** The next consent POST answers CONSENT_VERSION_MISMATCH whatever its version. */
  consentMismatchOnce: boolean;
  /** The next face search answers CONSENT_VERSION_MISMATCH (the policy changed after consent). */
  searchConsentStale: boolean;
  /** What face search finds (ids of `items`). */
  faceMatches: { strong: string[]; maybe: string[] };
  /** The viewer's face-search result (the face_only grant). */
  grant: Set<string>;
  /** Face search answers NO_FACE_DETECTED. */
  noFace: boolean;
  /** facesMatched of face deletion. */
  deletionMatches: number;
  /**
   * Face search and face deletion are over a FACE_SEARCH_RATE_* limit: RATE_LIMITED before any
   * selfie is read. With `captcha`, a token in CAPTCHA_TOKEN_HEADER is judged by `tokens`
   * (unknown tokens are `invalid`); an `ok` token lifts the limit (the API's grant).
   */
  rateLimit: {
    captcha: boolean;
    retryAfterSeconds: number;
    tokens: Record<string, 'ok' | CaptchaRejectReason>;
  } | null;
}

/** A ready image as the share page sees it. */
export function shareItem(name: string, extra: Partial<ShareItem> = {}): ShareItem {
  const id = crypto.randomUUID();
  return {
    id,
    name,
    mediaKind: 'image',
    width: 6000,
    height: 4000,
    takenAt: null,
    thumbUrl: `${MEDIA}/derived/p/${id}/thumb.webp?Signature=x`,
    previewUrl: `${MEDIA}/derived/p/${id}/preview.webp?Signature=x`,
    urlsExpireAt: '2099-01-01T00:00:00.000Z',
    ...extra,
  };
}

export function createPublicShare(
  fixture: Partial<PublicShareFixture> & { itemCount?: number },
): PublicShareFixture {
  const { itemCount = 3, ...rest } = fixture;
  const items =
    rest.items ??
    Array.from({ length: itemCount }, (_, i) =>
      shareItem(`IMG_${String(i + 1).padStart(4, '0')}.jpg`),
    );
  return {
    token: generateShareToken(),
    targetType: 'folder',
    mode: 'gallery',
    allowDownload: true,
    downloadSize: 'web',
    requireLogin: false,
    password: null,
    expiresAt: null,
    title: 'Bangkok Marathon 2026',
    photographerName: 'Somchai',
    faceSearchAvailable: false,
    expiredReason: null,
    unlocked: false,
    consented: false,
    deletionConsented: false,
    serverPolicyVersion: LATEST_CONSENT_POLICY_VERSION,
    consentMismatchOnce: false,
    searchConsentStale: false,
    faceMatches: { strong: [], maybe: [] },
    grant: new Set(),
    noFace: false,
    deletionMatches: 0,
    rateLimit: null,
    ...rest,
    items,
  };
}

/** Canned stats of a share. */
export function statsFor(shareId: string): ShareStatsResponse {
  const day = (date: string, n: number) => ({
    date,
    visitors: 10 * n,
    scanners: 4 * n,
    scans: 5 * n,
    downloads: 7 * n,
    uniqueDownloaders: 3 * n,
    zips: n,
    bytesOut: n * 1024 ** 2,
  });
  return {
    shareId,
    from: '2026-09-26',
    to: '2026-10-25',
    totals: {
      visitors: 30,
      scanners: 12,
      scans: 15,
      downloads: 21,
      uniqueDownloaders: 9,
      zips: 3,
      bytesOut: 3 * 1024 ** 2,
    },
    days: [day('2026-10-23', 1), day('2026-10-24', 2)],
    rolledUpAt: '2026-10-25T04:00:00.000Z',
  };
}

function publicShareOrFail(api: FakeApi, token: string | undefined) {
  const share = api.publicShares.get(token ?? '');
  if (share === undefined) throw new Fail('NOT_FOUND');
  return share;
}

function ownerShareOrFail(api: FakeApi, id: string | undefined) {
  const entry = api.ownerShares.get(id ?? '');
  if (entry === undefined) throw new Fail('NOT_FOUND');
  return entry;
}

/** Availability, then require_login, then password (the gate order of api/share-page). */
function gate(api: FakeApi, share: PublicShareFixture, until: 'login' | 'all' = 'all') {
  if (share.expiredReason !== null)
    throw new Fail('SHARE_EXPIRED', { reason: share.expiredReason });
  if (share.requireLogin && !api.viewerSession) throw new Fail('LOGIN_REQUIRED');
  if (until === 'login') return;
  if (share.password !== null && !share.unlocked) throw new Fail('PASSWORD_REQUIRED');
}

function visibleItems(share: PublicShareFixture) {
  return share.mode === 'face_only'
    ? share.items.filter((i) => share.grant.has(i.id))
    : share.items;
}

function faceGate(share: PublicShareFixture) {
  if (!share.faceSearchAvailable) throw new Fail('FEATURE_DISABLED', { feature: 'face_search' });
  if (!share.consented) {
    throw new Fail('CONSENT_REQUIRED', { policyVersion: LATEST_CONSENT_POLICY_VERSION });
  }
}

/** Checks the selfie parts like the API (count, field name, type) and records sizes only. */
/** RATE_LIMITED (RateLimitedDetails) unless the share is under its limit or the token passes. */
function rateGate(
  api: FakeApi,
  share: PublicShareFixture,
  headers: Record<string, string | undefined>,
  action: CaptchaAction,
) {
  const limit = share.rateLimit;
  const token = headers[CAPTCHA_TOKEN_HEADER];
  if (token !== undefined) api.captchaTokens.push(token);
  if (limit === null) return;
  const verdict = limit.captcha && token !== undefined ? (limit.tokens[token] ?? 'invalid') : null;
  if (verdict === 'ok') {
    share.rateLimit = null;
    return;
  }
  throw new Fail('RATE_LIMITED', {
    retryAfterSeconds: limit.retryAfterSeconds,
    captcha: limit.captcha ? { provider: 'turnstile', action, rejected: verdict } : null,
  });
}

function selfies(api: FakeApi, form: FormData | undefined, kind: 'search' | 'deletion') {
  const names = [...(form?.keys() ?? [])];
  const parts = form?.getAll(SELFIE_FIELD_NAME) ?? [];
  if (
    parts.length < 1 ||
    parts.length > api.options.maxSelfies ||
    names.some((n) => n !== SELFIE_FIELD_NAME)
  ) {
    throw new Fail('VALIDATION_FAILED');
  }
  const blobs = parts.filter((p): p is File => typeof p !== 'string');
  if (blobs.some((b) => !(SELFIE_MIME_TYPES as readonly string[]).includes(b.type))) {
    throw new Fail('UNSUPPORTED_FILE_TYPE', { extension: null, hint: null });
  }
  api.selfieUploads.push({
    route: kind,
    sizes: blobs.map((b) => b.size),
    types: blobs.map((b) => b.type),
  });
  return blobs.length;
}

function signedDownload(fileId: string, name: string) {
  return {
    fileId,
    url: `${MEDIA}/derived/p/${fileId}/web.jpg?response-content-disposition=attachment&Signature=x`,
    fileName: name,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
}

function shareStatus(share: OwnerShare): OwnerShare['status'] {
  if (share.status === 'revoked') return 'revoked';
  return share.expiresAt !== null && share.expiresAt < NOW ? 'expired' : 'active';
}

const FEATURE_OFF = { feature: 'face_search' } as const;

export function handlePhase3(
  api: FakeApi,
  route: RouteContract,
  params: Record<string, string>,
  query: unknown,
  body: unknown,
  extra: { headers: Record<string, string | undefined>; form?: FormData },
): unknown {
  switch (route) {
    // --- me ---------------------------------------------------------------------------------
    case ME_ROUTES.get:
      return api.me;
    case ME_ROUTES.becomePhotographer:
      // ADR 0010: accounts come from admins only.
      throw new Fail('FORBIDDEN');
    case ME_ROUTES.createViewerSession:
      api.viewerSession = true;
      return undefined;
    case ME_ROUTES.deleteViewerSession:
      api.viewerSession = false;
      return undefined;

    // --- drive additions ----------------------------------------------------------------------
    case DRIVE_ROUTES.updateFaceIndex: {
      const folder = api.folderOrFail(params.id ?? null);
      if (folder === null) throw new Fail('NOT_FOUND');
      const enabled = (body as { enabled: boolean }).enabled;
      if (enabled && !api.options.faceSearch) throw new Fail('FEATURE_DISABLED', FEATURE_OFF);
      folder.faceIndexEnabled = enabled;
      folder.faceIndexExpiresAt = enabled ? '2027-01-23T05:00:00.000Z' : null;
      return folder;
    }
    case DRIVE_ROUTES.downloadFile: {
      const file = api.files.get(params.id ?? '');
      if (file === undefined) throw new Fail('NOT_FOUND');
      return signedDownload(file.id, file.name);
    }

    // --- owner shares -------------------------------------------------------------------------
    case SHARE_ROUTES.create: {
      const b = body as Required<CreateShareBody>;
      const target =
        b.target.type === 'folder'
          ? api.folders.get(b.target.folderId)
          : api.files.get(b.target.fileId);
      if (target === undefined || target.deletedAt !== null) throw new Fail('NOT_FOUND');
      if (b.mode === 'face_only' && !api.options.faceSearch) {
        throw new Fail('FEATURE_DISABLED', FEATURE_OFF);
      }
      const token = generateShareToken();
      const share: OwnerShare = {
        id: crypto.randomUUID(),
        token,
        url: `https://photos.example.com/s/${token}`,
        target: { type: b.target.type, id: target.id, name: target.name, unavailable: false },
        mode: b.mode,
        allowDownload: b.allowDownload,
        downloadSize: b.downloadSize,
        requireLogin: b.requireLogin,
        passwordProtected: b.password !== null,
        expiresAt: b.expiresAt,
        status: 'active',
        createdAt: NOW,
      };
      api.ownerShares.set(share.id, { share, password: b.password });
      return share;
    }
    case SHARE_ROUTES.list: {
      const lq = query as { cursor?: string; limit?: number; fileId?: string; folderId?: string };
      const items = [...api.ownerShares.values()]
        .map((e) => e.share)
        .filter((s) => lq.fileId === undefined || s.target.id === lq.fileId)
        .filter((s) => lq.folderId === undefined || s.target.id === lq.folderId)
        .reverse();
      const { slice, next } = api.page(items, lq.cursor, lq.limit);
      return { items: slice, nextCursor: next };
    }
    case SHARE_ROUTES.get:
      return ownerShareOrFail(api, params.id).share;
    case SHARE_ROUTES.update: {
      const entry = ownerShareOrFail(api, params.id);
      if (entry.share.status === 'revoked') throw new Fail('CONFLICT');
      const { password, ...settings } = body as UpdateShareBody;
      if (settings.mode === 'face_only' && !api.options.faceSearch) {
        throw new Fail('FEATURE_DISABLED', FEATURE_OFF);
      }
      const defined = Object.fromEntries(
        Object.entries(settings).filter(([, v]) => v !== undefined),
      );
      entry.share = { ...entry.share, ...defined };
      if (password !== undefined) {
        entry.password = password;
        entry.share.passwordProtected = password !== null;
      }
      entry.share.status = shareStatus(entry.share);
      return entry.share;
    }
    case SHARE_ROUTES.revoke: {
      const entry = ownerShareOrFail(api, params.id);
      entry.share = { ...entry.share, status: 'revoked' };
      return undefined;
    }
    case SHARE_ROUTES.stats:
      return statsFor(ownerShareOrFail(api, params.id).share.id);

    // --- public share page --------------------------------------------------------------------
    case PUBLIC_SHARE_ROUTES.meta: {
      const share = publicShareOrFail(api, params.token);
      if (share.expiredReason !== null) {
        throw new Fail('SHARE_EXPIRED', { reason: share.expiredReason });
      }
      const loginRequired = share.requireLogin && !api.viewerSession;
      const locked = share.password !== null && !share.unlocked;
      const cover = share.items.find((i) => i.mediaKind === 'image');
      return {
        token: share.token,
        targetType: share.targetType,
        mode: share.mode,
        allowDownload: share.allowDownload,
        downloadSize: share.downloadSize,
        requireLogin: share.requireLogin,
        passwordProtected: share.password !== null,
        expiresAt: share.expiresAt,
        access: { loginRequired, locked },
        details:
          loginRequired || locked
            ? null
            : {
                title: share.title,
                photographerName: share.photographerName,
                itemCount: share.mode === 'face_only' ? null : share.items.length,
                cover:
                  share.mode === 'face_only' || cover === undefined
                    ? null
                    : { previewUrl: cover.previewUrl, width: cover.width, height: cover.height },
              },
        faceSearch: {
          available: share.faceSearchAvailable,
          policyVersion: share.faceSearchAvailable ? LATEST_CONSENT_POLICY_VERSION : null,
          consented: share.consented,
          maxSelfies: api.options.maxSelfies,
          selfieLongEdge: api.options.selfieLongEdge,
          selfieJpegQuality: api.options.selfieJpegQuality,
          resultTtlSeconds: api.options.resultTtlSeconds,
        },
        zip: { maxFiles: api.options.zipMaxFiles },
      };
    }
    case PUBLIC_SHARE_ROUTES.faceDeletionInfo: {
      // Token lookup only: expired, revoked, locked shares and the flag off all answer.
      const share = publicShareOrFail(api, params.token);
      return {
        policyVersion: LATEST_CONSENT_POLICY_VERSION,
        consented: share.deletionConsented,
        maxSelfies: api.options.maxSelfies,
        selfieLongEdge: api.options.selfieLongEdge,
        selfieJpegQuality: api.options.selfieJpegQuality,
      };
    }
    case PUBLIC_SHARE_ROUTES.items: {
      const share = publicShareOrFail(api, params.token);
      gate(api, share);
      const iq = query as { cursor?: string; limit?: number };
      const { slice, next } = api.page(visibleItems(share), iq.cursor, iq.limit);
      return { items: slice, nextCursor: next };
    }
    case PUBLIC_SHARE_ROUTES.unlock: {
      const share = publicShareOrFail(api, params.token);
      gate(api, share, 'login');
      if (share.password !== null && (body as { password: string }).password !== share.password) {
        throw new Fail('PASSWORD_INCORRECT');
      }
      share.unlocked = true;
      return undefined;
    }
    case PUBLIC_SHARE_ROUTES.giveConsent: {
      const share = publicShareOrFail(api, params.token);
      const b = body as { purpose: 'face_search' | 'face_deletion'; policyVersion: string };
      // CONSENT_PURPOSE_GATES: face_deletion checks the token only.
      if (b.purpose === 'face_search') {
        gate(api, share);
        if (!share.faceSearchAvailable) throw new Fail('FEATURE_DISABLED', FEATURE_OFF);
      }
      if (share.consentMismatchOnce || b.policyVersion !== share.serverPolicyVersion) {
        share.consentMismatchOnce = false;
        throw new Fail('CONSENT_VERSION_MISMATCH', { policyVersion: share.serverPolicyVersion });
      }
      if (b.purpose === 'face_search') share.consented = true;
      else share.deletionConsented = true;
      return { purpose: b.purpose, policyVersion: b.policyVersion, acceptedAt: NOW };
    }
    case PUBLIC_SHARE_ROUTES.withdrawConsent: {
      // Token lookup only: withdrawal always works, for every purpose.
      const share = publicShareOrFail(api, params.token);
      share.consented = false;
      share.deletionConsented = false;
      share.grant.clear();
      return undefined;
    }
    case PUBLIC_SHARE_ROUTES.faceSearch: {
      const share = publicShareOrFail(api, params.token);
      gate(api, share);
      faceGate(share);
      if (share.searchConsentStale) {
        share.searchConsentStale = false;
        share.consented = false;
        throw new Fail('CONSENT_VERSION_MISMATCH', { policyVersion: share.serverPolicyVersion });
      }
      rateGate(api, share, extra.headers, 'face_search');
      const count = selfies(api, extra.form, 'search');
      if (share.noFace) {
        throw new Fail('NO_FACE_DETECTED', { selfies: count, selfiesWithoutFace: count });
      }
      for (const id of [...share.faceMatches.strong, ...share.faceMatches.maybe]) {
        share.grant.add(id);
      }
      const pick = (ids: string[]) => share.items.filter((i) => ids.includes(i.id));
      return {
        strong: pick(share.faceMatches.strong),
        maybe: pick(share.faceMatches.maybe),
        selfies: count,
        selfiesWithoutFace: 0,
      };
    }
    case PUBLIC_SHARE_ROUTES.faceDeletion: {
      // Token plus a face_deletion consent only: never SHARE_EXPIRED, LOGIN_REQUIRED,
      // PASSWORD_REQUIRED or FEATURE_DISABLED.
      const share = publicShareOrFail(api, params.token);
      if (!share.deletionConsented) {
        throw new Fail('CONSENT_REQUIRED', { policyVersion: share.serverPolicyVersion });
      }
      rateGate(api, share, extra.headers, 'face_deletion');
      const count = selfies(api, extra.form, 'deletion');
      if (share.noFace) {
        throw new Fail('NO_FACE_DETECTED', { selfies: count, selfiesWithoutFace: count });
      }
      return { facesMatched: share.deletionMatches };
    }
    case PUBLIC_SHARE_ROUTES.feedback: {
      const share = publicShareOrFail(api, params.token);
      gate(api, share);
      if (!share.faceSearchAvailable) throw new Fail('FEATURE_DISABLED', FEATURE_OFF);
      const { fileId } = body as { fileId: string };
      api.feedback.push({ token: share.token, fileId });
      share.grant.delete(fileId);
      return undefined;
    }
    case PUBLIC_SHARE_ROUTES.downloads: {
      const share = publicShareOrFail(api, params.token);
      gate(api, share);
      if (!share.allowDownload) throw new Fail('DOWNLOAD_NOT_ALLOWED');
      const ids = (body as { fileIds: string[] }).fileIds;
      const visible = visibleItems(share);
      const files = ids.map((id) => visible.find((i) => i.id === id));
      if (files.some((f) => f === undefined)) throw new Fail('NOT_FOUND');
      if (ids.length === 1) {
        const file = files[0] as ShareItem;
        return { kind: 'file', file: signedDownload(file.id, file.name) };
      }
      const key = extra.headers['idempotency-key'];
      if (key === undefined) {
        throw new Fail('VALIDATION_FAILED', {
          issues: [{ path: ['headers', 'idempotency-key'], message: 'required' }],
        });
      }
      if (ids.length > api.options.zipMaxFiles || ids.length * 1000 > api.options.zipMaxBytes) {
        throw new Fail('ZIP_TOO_LARGE', {
          maxFiles: api.options.zipMaxFiles,
          maxBytes: api.options.zipMaxBytes,
          files: ids.length,
          bytes: ids.length * 1000,
        });
      }
      const idsKey = [...ids].sort().join(',');
      const previous = api.zipKeys.get(key);
      if (previous !== undefined) {
        if (previous.ids !== idsKey) throw new Fail('IDEMPOTENCY_KEY_REUSED');
        return { kind: 'zip', job: api.zipJobs.get(previous.jobId)?.job };
      }
      const job: ZipJobView = {
        id: crypto.randomUUID(),
        status: 'queued',
        fileCount: ids.length,
        totalBytes: ids.length * 1000,
        createdAt: NOW,
        download: null,
        availableUntil: null,
        errorCode: null,
      };
      api.zipJobs.set(job.id, { job, polls: 0, token: share.token });
      api.zipKeys.set(key, { ids: idsKey, jobId: job.id });
      return { kind: 'zip', job };
    }
    case PUBLIC_SHARE_ROUTES.zipJob: {
      // Looked up by id AND the token's share; the share's gates apply.
      const share = publicShareOrFail(api, params.token);
      gate(api, share);
      const entry = api.zipJobs.get(params.id ?? '');
      if (entry === undefined || entry.token !== share.token) throw new Fail('NOT_FOUND');
      entry.polls++;
      if (entry.polls < api.options.zipPollsUntilDone) {
        entry.job = { ...entry.job, status: 'running' };
      } else if (api.options.zipOutcome === 'ready') {
        entry.job = {
          ...entry.job,
          status: 'ready',
          download: {
            url: `${MEDIA}/tmp/zips/${entry.job.id}.zip?Signature=x`,
            fileName: 'photos.zip',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
          availableUntil: '2099-01-01T00:00:00.000Z',
        };
      } else {
        entry.job = { ...entry.job, status: 'failed', errorCode: 'INTERNAL_ERROR' };
      }
      return entry.job;
    }
    default:
      return NOT_HANDLED;
  }
}
