import {
  allowedDuringPasswordChange,
  checkUploadDeclaration,
  DRIVE_ROUTES,
  type DriveFile,
  type DriveFolder,
  type DriveUsageResponse,
  availableDriveName,
  driveNameKey,
  ERROR_HTTP_STATUS,
  IDEMPOTENCY_KEY_HEADER,
  type ErrorCode,
  ME_ROUTES,
  type MeResponse,
  multipartPlan,
  type OwnerShare,
  type RouteContract,
  UPLOAD_ROUTES,
  uploadFileType,
  validationFailedDetails,
  type ZipJobView,
} from '@shotx/shared';
import { matchRoute } from '@/lib/bff/handler';
import { FakeBilling, handleBilling } from './fake-billing-api';
import { FakeDesigns, handleDesigns } from './fake-design-api';
import {
  createPublicShare,
  handlePhase3,
  NOT_HANDLED,
  type PublicShareFixture,
} from './fake-share-api';

export { shareItem, type PublicShareFixture } from './fake-share-api';
export { FakeDesigns, STORAGE_ORIGIN } from './fake-design-api';

/**
 * In-memory stand-in for the API, speaking the shared route contracts over `fetch`: request
 * params/query/body are parsed with the contract's zod schemas and every response is a valid
 * contract response. Used by the component and upload tests (the real API runs in another
 * worktree).
 */

export const NOW = '2026-10-25T05:00:00.000Z';
export const MEDIA = 'https://photos.example.com/media';

export class Fail extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly details?: unknown,
  ) {
    super(code);
  }
}

interface Upload {
  file: DriveFile;
  partSize: number;
  partCount: number;
  parts: Map<number, { etag: string; size: number }>;
}

export interface FakeApiOptions {
  pageSize?: number;
  /** The plan quota; null while STORAGE_QUOTA_ENFORCED=false (ADR 0010: no storage limit). */
  quotaBytes?: number | null;
  usedBytes?: number;
  uploadsBlockedBy?: DriveUsageResponse['uploadsBlockedBy'];
  /** ADR 0023: all-time share downloads in GET /drive/stats. */
  downloads?: number;
  partBytes?: number;
  initPresignedParts?: number;
  /** Return a different part size than the client expects (plan mismatch test). */
  partSizeOverride?: number;
  /** me.role (`user` until onboarding). */
  role?: MeResponse['role'];
  /** FACE_SEARCH_ENABLED as the API reports it (me.features.faceSearch). */
  faceSearch?: boolean;
  /**
   * A restricted session (ADR 0010): me.passwordChangeRequired, and every photographer or user
   * route but PASSWORD_CHANGE_ALLOWED_ROUTES answers PASSWORD_CHANGE_REQUIRED.
   */
  passwordChangeRequired?: boolean;
  /** ADR 0018: GET /me reports an admin acting in the account. */
  actingAdmin?: { id: string; name: string | null; email: string | null } | null;
  /**
   * viewerLoginAvailable at the API (LINE/Google or dev login on). False: POST /shares and
   * PATCH /shares/:id with `requireLogin: true` answer LOGIN_PROVIDER_UNAVAILABLE.
   */
  viewerLoginAvailable?: boolean;
  /** ZIP_MAX_FILES (share meta `zip.maxFiles`). */
  zipMaxFiles?: number;
  /** ZIP_MAX_BYTES (each fake file is 1000 bytes). */
  zipMaxBytes?: number;
  /** FACE_MAX_SELFIES, FACE_SELFIE_LONG_EDGE, FACE_SELFIE_JPEG_QUALITY (share meta). */
  maxSelfies?: number;
  selfieLongEdge?: number;
  selfieJpegQuality?: number;
  /** SHARE_FACE_ONLY_GRANT_TTL_SECONDS (share meta `faceSearch.resultTtlSeconds`). */
  resultTtlSeconds?: number;
  /** Polls of GET /s/:token/zip-jobs/:id before the job is done. */
  zipPollsUntilDone?: number;
  zipOutcome?: 'ready' | 'failed';
}

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
  /** `/bff` or `/api`. */
  prefix: string;
  credentials: RequestCredentials | undefined;
  headers: Record<string, string>;
}

export class FakeApi {
  folders = new Map<string, DriveFolder>();
  files = new Map<string, DriveFile>();
  uploads = new Map<string, Upload>();
  calls: RecordedCall[] = [];
  /** Part numbers per fileId the fake S3 received, for assertions. */
  s3Puts: { fileId: string; partNumber: number; size: number }[] = [];
  readonly options: Required<Omit<FakeApiOptions, 'partSizeOverride'>> &
    Pick<FakeApiOptions, 'partSizeOverride'>;
  private reservedBytes = 0;
  /** clientUploadId -> the upload it started and its declaration. */
  clientUploads = new Map<string, { fileId: string; declaration: string }>();
  /** Process the request, then fail the fetch as if the response was lost (once per route). */
  dropResponseOnce = new Set<RouteContract>();

  me: MeResponse;
  /** A viewer session exists (POST /me/viewer-session went through the BFF). */
  viewerSession = false;
  ownerShares = new Map<string, { share: OwnerShare; password: string | null; paused?: boolean }>();
  publicShares = new Map<string, PublicShareFixture>();
  /** How each public share route call named its share (ADR 0011: slug once, then the token). */
  refKinds: ('token' | 'slug')[] = [];
  feedback: { token: string; fileId: string }[] = [];
  /** Selfie parts received per face request (sizes and types only). */
  selfieUploads: { route: 'search' | 'deletion'; sizes: number[]; types: string[] }[] = [];
  /** Every CAPTCHA_TOKEN_HEADER value received on face search and face deletion. */
  captchaTokens: string[] = [];
  zipJobs = new Map<string, { job: ZipJobView; polls: number; token: string }>();
  /** Owner folder ZIPs (POST /drive/folders/:id/download), and their Idempotency-Keys. */
  ownerZipJobs = new Map<string, { job: ZipJobView; polls: number }>();
  ownerZipKeys = new Map<string, { folderId: string; jobId: string }>();
  /** clientCopyId -> the copy it made (and its source and target), for idempotent copies. */
  copies = new Map<string, { fileId: string; sourceId: string; target: string | null }>();
  /** Copies still `processing`: listings left until the fake worker makes them `ready`. */
  pendingCopies = new Map<string, number>();
  /** Listings a copy stays `processing` for. */
  copyReadyAfterListings = 1;
  zipKeys = new Map<string, { ids: string; jobId: string }>();
  /** Plans, subscription and payments of the billing routes. */
  billing = new FakeBilling();
  /** Share page designs and design images (ADR 0013). */
  designs = new FakeDesigns();

  constructor(options: FakeApiOptions = {}) {
    this.options = {
      pageSize: 100,
      quotaBytes: 10 * 1024 ** 3,
      usedBytes: 0,
      uploadsBlockedBy: null,
      downloads: 0,
      partBytes: 16 * 1024 * 1024,
      initPresignedParts: 2,
      role: 'photographer',
      faceSearch: false,
      passwordChangeRequired: false,
      actingAdmin: null,
      viewerLoginAvailable: true,
      zipMaxFiles: 500,
      zipMaxBytes: 2 * 1024 ** 3,
      maxSelfies: 3,
      selfieLongEdge: 1280,
      selfieJpegQuality: 90,
      resultTtlSeconds: 24 * 3600,
      zipPollsUntilDone: 2,
      zipOutcome: 'ready',
      ...options,
    };
    this.me = {
      id: crypto.randomUUID(),
      role: this.options.role,
      email: 'photographer@example.com',
      name: 'Somchai',
      createdAt: NOW,
      subscription: this.options.role === 'photographer' ? TRIAL : null,
      features: { faceSearch: this.options.faceSearch },
      passwordChangeRequired: this.options.passwordChangeRequired,
      actingAdmin: this.options.actingAdmin,
    };
  }

  /** Seeds a share for the public routes. */
  addPublicShare(fixture: Partial<PublicShareFixture> & { itemCount?: number } = {}) {
    const share = createPublicShare(fixture);
    this.publicShares.set(share.token, share);
    return share;
  }

  // --- Seeding ---------------------------------------------------------------------------

  addFolder(name: string, parentId: string | null = null, deletedAt: string | null = null) {
    const folder: DriveFolder = {
      kind: 'folder',
      id: crypto.randomUUID(),
      parentId,
      name,
      createdAt: NOW,
      deletedAt,
      faceIndexEnabled: false,
      faceIndexExpiresAt: null,
      coverFileId: null,
    };
    this.folders.set(folder.id, folder);
    return folder;
  }

  addFile(name: string, folderId: string | null = null, extra: Partial<DriveFile> = {}) {
    const id = crypto.randomUUID();
    const file: DriveFile = {
      kind: 'file',
      id,
      folderId,
      name,
      mime: 'image/jpeg',
      mediaKind: 'image',
      sizeBytes: 1000,
      status: 'ready',
      width: 6000,
      height: 4000,
      takenAt: null,
      faceCount: null,
      createdAt: NOW,
      deletedAt: null,
      thumbUrl: `${MEDIA}/derived/p/${id}/thumb.webp?Signature=x`,
      ...extra,
    };
    this.files.set(id, file);
    return file;
  }

  callsTo(route: RouteContract): RecordedCall[] {
    const pattern = new RegExp(`^${route.path.replace(/:[A-Za-z]+/g, '[^/]+')}$`);
    return this.calls.filter((c) => c.method === route.method && pattern.test(c.path));
  }

  // --- fetch ------------------------------------------------------------------------------

  /** When set, requests whose path ends with this wait for `release` (e.g. a slow face search). */
  hold: { pathSuffix: string; release: Promise<void> } | null = null;

  fetch: typeof fetch = async (input, init) => {
    const href = input instanceof Request ? input.url : input.toString();
    if (
      this.hold !== null &&
      new URL(href, 'http://localhost').pathname.endsWith(this.hold.pathSuffix)
    ) {
      await this.hold.release;
    }
    return this.respond(input, init);
  };

  private respond(input: RequestInfo | URL, init?: RequestInit): Response {
    const href = input instanceof Request ? input.url : input.toString();
    const url = new URL(href, 'http://localhost');
    const method = init?.method ?? 'GET';
    const prefix = /^\/(bff|api)(?=\/)/.exec(url.pathname)?.[0] ?? '';
    const path = url.pathname.slice(prefix.length);
    const form = init?.body instanceof FormData ? init.body : undefined;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    this.calls.push({
      method,
      path,
      body: body ?? form,
      prefix,
      credentials: init?.credentials,
      headers,
    });
    const route = matchRoute(method, path);
    if (route === null) return json(404, { code: 'NOT_FOUND', message: 'no route' });
    // Public routes are called directly at /api, everything else through the BFF.
    if ((route.auth === 'public') !== (prefix === '/api')) {
      return json(404, { code: 'NOT_FOUND', message: `wrong prefix ${prefix}` });
    }
    try {
      if (
        this.me.passwordChangeRequired &&
        (route.auth === 'photographer' || route.auth === 'user') &&
        !allowedDuringPasswordChange(route)
      ) {
        throw new Fail('PASSWORD_CHANGE_REQUIRED');
      }
      const params = route.params ? parse(route.params, paramsOf(route, path), 'params') : {};
      const query = route.query
        ? parse(route.query, Object.fromEntries(url.searchParams), 'query')
        : {};
      const parsedBody = route.body ? parse(route.body, body, 'body') : undefined;
      const parsedHeaders = route.headers ? parse(route.headers, headers, 'headers') : {};
      if (route.multipart !== undefined && form === undefined) throw new Fail('VALIDATION_FAILED');
      const extra = { headers: parsedHeaders as Record<string, string | undefined>, form };
      const billing = handleBilling(
        this,
        route,
        params as Record<string, string>,
        parsedBody,
        extra.headers,
      );
      const designs =
        billing !== NOT_HANDLED
          ? billing
          : handleDesigns(this, route, params as Record<string, string>, query, parsedBody);
      const phase3 =
        designs !== NOT_HANDLED
          ? designs
          : handlePhase3(this, route, params as Record<string, string>, query, parsedBody, extra);
      this.lastHeaders = Object.fromEntries(
        Object.entries(extra.headers).filter((e): e is [string, string] => e[1] !== undefined),
      );
      const result =
        phase3 === NOT_HANDLED
          ? this.handle(route, params as Record<string, string>, query, parsedBody)
          : phase3;
      if (this.dropResponseOnce.delete(route)) throw new TypeError('Failed to fetch');
      if (route.status === 204) {
        const response = new Response(null, { status: 204 });
        if (route === ME_ROUTES.createViewerSession) {
          response.headers.append('set-cookie', 'shotx_vs=vs-token; Path=/api; HttpOnly; Secure');
        }
        return response;
      }
      // Make sure the fake never answers outside the contract.
      return json(route.status, route.response?.parse(result) ?? result);
    } catch (error) {
      if (error instanceof Fail) {
        return json(ERROR_HTTP_STATUS[error.code], {
          code: error.code,
          message: error.code,
          ...(error.details !== undefined ? { details: error.details } : {}),
        });
      }
      throw error;
    }
  }

  /** Fake S3 part upload (Uppy `uploadPartBytes`): records the PUT and returns an ETag. */
  /** Delays each part PUT (ms), to observe concurrency. */
  s3DelayMs = 0;
  /** Part PUTs in flight right now, and the most at once. */
  s3InFlight = 0;
  s3MaxInFlight = 0;
  /** When it returns true for a part, the PUT waits until its signal aborts (pause/cancel tests). */
  holdPart: ((fileId: string, partNumber: number) => boolean) | null = null;

  uploadPartBytes = async ({
    signature,
    body,
    onProgress,
    onComplete,
    signal,
  }: {
    signature: { url: string };
    body: FormData | Blob;
    onProgress: (e: { loaded: number; lengthComputable: boolean }) => void;
    onComplete: (etag: string) => void;
    signal?: AbortSignal;
  }) => {
    const url = new URL(signature.url);
    const fileId = url.pathname.split('/')[2] ?? '';
    const partNumber = Number(url.searchParams.get('partNumber'));
    const size = (body as Blob).size;
    this.s3InFlight++;
    this.s3MaxInFlight = Math.max(this.s3MaxInFlight, this.s3InFlight);
    try {
      if (this.holdPart?.(fileId, partNumber)) {
        await new Promise<never>((_, reject) => {
          const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (signal?.aborted) abort();
          signal?.addEventListener('abort', abort);
        });
      }
      if (this.s3DelayMs > 0) await new Promise((r) => setTimeout(r, this.s3DelayMs));
    } finally {
      this.s3InFlight--;
    }
    this.s3Puts.push({ fileId, partNumber, size });
    const upload = this.uploads.get(fileId);
    const etag = `"etag-${partNumber}"`;
    upload?.parts.set(partNumber, { etag, size });
    onProgress({ loaded: size, lengthComputable: true });
    onComplete(etag);
    return { ETag: etag };
  };

  // --- Routes -----------------------------------------------------------------------------

  private live<T extends { deletedAt: string | null }>(items: Iterable<T>) {
    return [...items].filter((i) => i.deletedAt === null);
  }

  /** The event view of a folder in a listing (ADR 0016), as the api computes it. */
  eventOf(folder: DriveFolder): NonNullable<DriveFolder['event']> {
    const images = this.live(this.files.values()).filter(
      (f) =>
        f.status === 'ready' &&
        f.mediaKind === 'image' &&
        f.folderId !== null &&
        this.isDescendant(f.folderId, folder.id),
    );
    const cover = images.find((f) => f.id === folder.coverFileId) ?? images[0];
    const link = [...this.ownerShares.values()]
      .map((e) => e.share)
      .filter((s) => s.target.type === 'folder' && s.target.id === folder.id)
      .filter((s) => s.status !== 'revoked')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
    return {
      coverThumbUrl: cover?.thumbUrl ?? null,
      link:
        link === undefined
          ? null
          : { shareId: link.id, status: link.status, path: link.path, url: link.url },
    };
  }

  folderOrFail(id: string | null) {
    if (id === null) return null;
    const folder = this.folders.get(id);
    if (folder === undefined || folder.deletedAt !== null) throw new Fail('NOT_FOUND');
    return folder;
  }

  /** Owner ZIP archive names (the folder's name + .zip). */
  ownerZipNames = new Map<string, string>();
  /** Headers of the request being handled (Idempotency-Key of the folder ZIP). */
  private lastHeaders: Record<string, string> = {};

  /** The fake worker: copies become `ready` (with a thumbnail) after a few listings. */
  private advanceCopies() {
    for (const [id, left] of this.pendingCopies) {
      if (left > 1) {
        this.pendingCopies.set(id, left - 1);
        continue;
      }
      this.pendingCopies.delete(id);
      const file = this.files.get(id);
      if (file !== undefined) {
        this.files.set(id, {
          ...file,
          status: 'ready',
          thumbUrl: `${MEDIA}/derived/p/${id}/thumb.webp?Signature=x`,
        });
      }
    }
  }

  /** Breadcrumbs of a file's location: down to (and including) its own folder. */
  private fileAncestors(folderId: string | null) {
    if (folderId === null) return [];
    const folder = this.folders.get(folderId);
    if (folder === undefined) return [];
    return [...this.ancestors(folder), { id: folder.id, name: folder.name }];
  }

  private ancestors(folder: DriveFolder | null) {
    const chain: { id: string; name: string }[] = [];
    let parentId = folder?.parentId ?? null;
    while (parentId !== null) {
      const parent = this.folders.get(parentId);
      if (parent === undefined) break;
      chain.unshift({ id: parent.id, name: parent.name });
      parentId = parent.parentId;
    }
    return chain;
  }

  private assertFreeName(
    kind: 'folder' | 'file',
    parentId: string | null,
    name: string,
    self?: string,
  ) {
    const siblings =
      kind === 'folder'
        ? this.live(this.folders.values()).filter((f) => f.parentId === parentId)
        : this.live(this.files.values()).filter((f) => f.folderId === parentId);
    if (siblings.some((s) => s.id !== self && driveNameKey(s.name) === driveNameKey(name))) {
      throw new Fail('NAME_TAKEN', { kind, name });
    }
  }

  private isDescendant(folderId: string, ancestorId: string): boolean {
    let current: string | null = folderId;
    while (current !== null) {
      if (current === ancestorId) return true;
      current = this.folders.get(current)?.parentId ?? null;
    }
    return false;
  }

  page<T>(items: T[], cursor: string | undefined, limit?: number) {
    const start = cursor ? Number(cursor) : 0;
    const size = limit ?? this.options.pageSize;
    const slice = items.slice(start, start + size);
    const next = start + size < items.length ? String(start + size) : null;
    return { slice, next };
  }

  private trashTree(folderId: string, at: string) {
    for (const child of this.folders.values()) {
      if (child.parentId === folderId && child.deletedAt === null) {
        child.deletedAt = at;
        this.trashTree(child.id, at);
      }
    }
    for (const file of this.files.values()) {
      if (file.folderId === folderId && file.deletedAt === null) file.deletedAt = at;
    }
  }

  private handle(
    route: RouteContract,
    params: Record<string, string>,
    query: unknown,
    body: unknown,
  ): unknown {
    const q = query as { cursor?: string; limit?: number };
    switch (route) {
      case DRIVE_ROUTES.listChildren: {
        this.advanceCopies();
        const folderId = params.id === 'root' ? null : (params.id ?? null);
        const folder = this.folderOrFail(folderId);
        const items = [
          ...this.live(this.folders.values())
            .filter((f) => f.parentId === folderId)
            .sort((a, b) => a.name.localeCompare(b.name)),
          ...this.live(this.files.values())
            .filter((f) => f.folderId === folderId)
            .sort((a, b) => a.name.localeCompare(b.name)),
        ];
        const { slice, next } = this.page(items, q.cursor, q.limit);
        return {
          folder,
          ancestors: this.ancestors(folder),
          items: slice.map((item) =>
            item.kind === 'folder' ? { ...item, event: this.eventOf(item) } : item,
          ),
          nextCursor: next,
        };
      }
      case DRIVE_ROUTES.createFolder: {
        const b = body as { parentId: string | null; name: string };
        this.folderOrFail(b.parentId);
        this.assertFreeName('folder', b.parentId, b.name);
        return this.addFolder(b.name, b.parentId);
      }
      case DRIVE_ROUTES.updateFolder: {
        const folder = this.folderOrFail(params.id ?? null);
        if (folder === null) throw new Fail('NOT_FOUND');
        const b = body as { name?: string; parentId?: string | null; coverFileId?: string | null };
        if (b.coverFileId !== undefined && b.coverFileId !== null) {
          const cover = this.files.get(b.coverFileId);
          if (cover === undefined) throw new Fail('NOT_FOUND');
          const reason =
            cover.deletedAt !== null
              ? 'not_live'
              : cover.status !== 'ready'
                ? 'not_ready'
                : cover.mediaKind !== 'image'
                  ? 'not_image'
                  : cover.folderId === null ||
                      (cover.folderId !== folder.id &&
                        !this.isDescendant(cover.folderId, folder.id))
                    ? 'outside_folder'
                    : null;
          if (reason !== null) throw new Fail('COVER_FILE_INVALID', { reason });
        }
        if (b.coverFileId !== undefined) folder.coverFileId = b.coverFileId;
        const parentId = b.parentId === undefined ? folder.parentId : b.parentId;
        if (parentId !== null) {
          this.folderOrFail(parentId);
          if (this.isDescendant(parentId, folder.id)) throw new Fail('INVALID_MOVE');
        }
        const name = b.name ?? folder.name;
        this.assertFreeName('folder', parentId, name, folder.id);
        Object.assign(folder, { name, parentId });
        return folder;
      }
      case DRIVE_ROUTES.updateFile: {
        const file = this.files.get(params.id ?? '');
        if (file === undefined || file.deletedAt !== null) throw new Fail('NOT_FOUND');
        const b = body as { name?: string; folderId?: string | null };
        const folderId = b.folderId === undefined ? file.folderId : b.folderId;
        this.folderOrFail(folderId);
        const name = b.name ?? file.name;
        if (uploadFileType(name, file.mime) === null) {
          throw new Fail('UNSUPPORTED_FILE_TYPE', { extension: null, hint: null });
        }
        this.assertFreeName('file', folderId, name, file.id);
        Object.assign(file, { name, folderId });
        return file;
      }
      case DRIVE_ROUTES.trashItems: {
        const at = NOW;
        const items = (body as { items: { kind: 'folder' | 'file'; id: string }[] }).items;
        for (const ref of items) {
          const item = ref.kind === 'folder' ? this.folders.get(ref.id) : this.files.get(ref.id);
          if (item === undefined) throw new Fail('NOT_FOUND');
        }
        for (const ref of items) {
          if (ref.kind === 'folder') {
            const folder = this.folders.get(ref.id);
            if (folder && folder.deletedAt === null) {
              folder.deletedAt = at;
              this.trashTree(folder.id, at);
            }
          } else {
            const file = this.files.get(ref.id);
            if (file && file.deletedAt === null) file.deletedAt = at;
          }
        }
        return { items: items.map((i) => ({ ...i, deletedAt: at })) };
      }
      case DRIVE_ROUTES.restoreItems: {
        const items = (body as { items: { kind: 'folder' | 'file'; id: string }[] }).items;
        const restored = items.map((ref) => {
          const item = ref.kind === 'folder' ? this.folders.get(ref.id) : this.files.get(ref.id);
          if (item === undefined || item.deletedAt === null) throw new Fail('NOT_FOUND');
          item.deletedAt = null;
          return item;
        });
        return { items: restored };
      }
      case DRIVE_ROUTES.listTrash: {
        const isTop = (item: DriveFolder | DriveFile) => {
          const parentId = item.kind === 'folder' ? item.parentId : item.folderId;
          return parentId === null || this.folders.get(parentId)?.deletedAt === null;
        };
        const purge = { purgeAt: '2026-11-24T05:00:00.000Z' };
        const items = [
          ...[...this.folders.values()].filter((f) => f.deletedAt !== null && isTop(f)),
          ...[...this.files.values()].filter((f) => f.deletedAt !== null && isTop(f)),
        ].map((i) => ({ ...i, ...purge }));
        const { slice, next } = this.page(items, q.cursor, q.limit);
        return { items: slice, nextCursor: next };
      }
      case DRIVE_ROUTES.emptyTrash: {
        let folders = 0;
        let files = 0;
        let bytes = 0;
        for (const [id, f] of this.folders) {
          if (f.deletedAt !== null) {
            this.folders.delete(id);
            folders++;
          }
        }
        for (const [id, f] of this.files) {
          if (f.deletedAt !== null) {
            this.files.delete(id);
            files++;
            bytes += f.sizeBytes;
          }
        }
        return { folders, files, bytes };
      }
      case DRIVE_ROUTES.copyFile: {
        const b = body as {
          targetFolderId: string | null;
          name?: string;
          onNameConflict: 'rename' | 'fail';
          clientCopyId?: string;
        };
        const source = this.files.get(params.id ?? '');
        if (source === undefined || source.deletedAt !== null) throw new Fail('NOT_FOUND');
        if (source.status !== 'ready') throw new Fail('CONFLICT');
        this.folderOrFail(b.targetFolderId);
        if (b.clientCopyId !== undefined) {
          const previous = this.copies.get(b.clientCopyId);
          if (previous !== undefined) {
            if (previous.sourceId !== source.id || previous.target !== b.targetFolderId) {
              throw new Fail('IDEMPOTENCY_KEY_REUSED');
            }
            return this.files.get(previous.fileId);
          }
        }
        if (this.options.uploadsBlockedBy === 'SUBSCRIPTION_INACTIVE') {
          throw new Fail('SUBSCRIPTION_INACTIVE', { status: 'expired' });
        }
        const siblings = this.live(this.files.values()).filter(
          (f) => f.folderId === b.targetFolderId,
        );
        const taken = (name: string) =>
          siblings.some((f) => driveNameKey(f.name) === driveNameKey(name));
        const wanted = b.name ?? source.name;
        if (b.onNameConflict === 'fail' && taken(wanted)) {
          throw new Fail('NAME_TAKEN', { kind: 'file', name: wanted });
        }
        const copy = this.addFile(availableDriveName(wanted, 'file', taken), b.targetFolderId, {
          mime: source.mime,
          mediaKind: source.mediaKind,
          sizeBytes: source.sizeBytes,
          width: source.width,
          height: source.height,
          takenAt: source.takenAt,
          status: 'processing',
          thumbUrl: undefined,
        });
        this.pendingCopies.set(copy.id, this.copyReadyAfterListings);
        if (b.clientCopyId !== undefined) {
          this.copies.set(b.clientCopyId, {
            fileId: copy.id,
            sourceId: source.id,
            target: b.targetFolderId,
          });
        }
        return copy;
      }
      case DRIVE_ROUTES.downloadFolder: {
        const folder = this.folderOrFail(params.id ?? null);
        if (folder === null) throw new Fail('NOT_FOUND');
        const files = this.live(this.files.values()).filter(
          (f) =>
            f.status === 'ready' && f.folderId !== null && this.isDescendant(f.folderId, folder.id),
        );
        if (files.length === 0) throw new Fail('CONFLICT');
        const key = this.lastHeaders[IDEMPOTENCY_KEY_HEADER];
        if (key !== undefined) {
          const previous = this.ownerZipKeys.get(key);
          if (previous !== undefined) {
            if (previous.folderId !== folder.id) throw new Fail('IDEMPOTENCY_KEY_REUSED');
            return { job: this.ownerZipJobs.get(previous.jobId)?.job };
          }
        }
        const job: ZipJobView = {
          id: crypto.randomUUID(),
          status: 'queued',
          fileCount: files.length,
          totalBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
          createdAt: NOW,
          download: null,
          availableUntil: null,
          errorCode: null,
        };
        this.ownerZipJobs.set(job.id, { job, polls: 0 });
        if (key !== undefined) this.ownerZipKeys.set(key, { folderId: folder.id, jobId: job.id });
        this.ownerZipNames.set(job.id, `${folder.name}.zip`);
        return { job };
      }
      case DRIVE_ROUTES.ownerZipJob: {
        const entry = this.ownerZipJobs.get(params.id ?? '');
        if (entry === undefined) throw new Fail('NOT_FOUND');
        entry.polls++;
        if (entry.polls < this.options.zipPollsUntilDone) {
          entry.job = { ...entry.job, status: 'running' };
        } else {
          entry.job = {
            ...entry.job,
            status: 'ready',
            download: {
              url: `${MEDIA}/tmp/zips/${entry.job.id}.zip?Signature=x`,
              fileName: this.ownerZipNames.get(entry.job.id) ?? 'folder.zip',
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
            availableUntil: '2099-01-01T00:00:00.000Z',
          };
        }
        return entry.job;
      }
      case DRIVE_ROUTES.recent: {
        this.advanceCopies();
        const files = this.live(this.files.values())
          .filter((f) => f.status === 'ready' || f.status === 'processing')
          .reverse();
        const { slice, next } = this.page(files, q.cursor, q.limit);
        return { items: slice, nextCursor: next };
      }
      case DRIVE_ROUTES.search: {
        const sq = query as {
          q?: string;
          type: 'any' | 'image' | 'video';
          takenFrom?: string;
          takenTo?: string;
          uploadedFrom?: string;
          uploadedTo?: string;
          folderId?: string;
          cursor?: string;
          limit?: number;
        };
        if (sq.folderId !== undefined) this.folderOrFail(sq.folderId);
        const text = sq.q?.toLowerCase();
        const within = (parentId: string | null) =>
          sq.folderId === undefined ||
          (parentId !== null && this.isDescendant(parentId, sq.folderId));
        const inRange = (iso: string | null, from?: string, to?: string) =>
          (from === undefined && to === undefined) ||
          (iso !== null &&
            (from === undefined || Date.parse(iso) >= Date.parse(from)) &&
            (to === undefined || Date.parse(iso) < Date.parse(to)));
        const filesOnly =
          sq.type !== 'any' || sq.takenFrom !== undefined || sq.takenTo !== undefined;
        const folders = filesOnly
          ? []
          : this.live(this.folders.values()).filter(
              (f) =>
                (text === undefined || f.name.toLowerCase().includes(text)) &&
                within(f.parentId) &&
                f.id !== sq.folderId &&
                inRange(f.createdAt, sq.uploadedFrom, sq.uploadedTo),
            );
        const files = this.live(this.files.values()).filter(
          (f) =>
            (f.status === 'ready' || f.status === 'processing') &&
            (text === undefined || f.name.toLowerCase().includes(text)) &&
            (sq.type === 'any' || f.mediaKind === sq.type) &&
            within(f.folderId) &&
            inRange(f.takenAt, sq.takenFrom, sq.takenTo) &&
            inRange(f.createdAt, sq.uploadedFrom, sq.uploadedTo),
        );
        const results = [...folders, ...files].map((item) => ({
          item,
          ancestors:
            item.kind === 'folder' ? this.ancestors(item) : this.fileAncestors(item.folderId),
        }));
        const { slice, next } = this.page(results, sq.cursor, sq.limit);
        return { items: slice, nextCursor: next, truncated: false };
      }
      case DRIVE_ROUTES.getFile: {
        const file = this.files.get(params.id ?? '');
        if (file === undefined) throw new Fail('NOT_FOUND');
        return { file, ancestors: this.fileAncestors(file.folderId) };
      }
      case DRIVE_ROUTES.folderSummary: {
        const folder = this.folderOrFail(params.id ?? null);
        if (folder === null) throw new Fail('NOT_FOUND');
        const files = this.live(this.files.values()).filter(
          (f) =>
            (f.status === 'ready' || f.status === 'processing') &&
            f.folderId !== null &&
            this.isDescendant(f.folderId, folder.id),
        );
        return {
          folder,
          ancestors: this.ancestors(folder),
          fileCount: files.length,
          imageCount: files.filter((f) => f.mediaKind === 'image').length,
          videoCount: files.filter((f) => f.mediaKind === 'video').length,
          folderCount: this.live(this.folders.values()).filter(
            (f) =>
              f.id !== folder.id && f.parentId !== null && this.isDescendant(f.parentId, folder.id),
          ).length,
          totalBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
        };
      }
      case DRIVE_ROUTES.stats: {
        const days = (query as { days?: number }).days ?? 30;
        const photos = this.live(this.files.values()).filter((f) => f.mime.startsWith('image/'));
        const to = NOW.slice(0, 10);
        const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const list = Array.from({ length: days }, (_, i) => {
          const date = new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000)
            .toISOString()
            .slice(0, 10);
          return { date, photos: date === to ? photos.length : 0, downloads: 0, visitors: 0 };
        });
        return {
          from,
          to,
          totals: { photos: photos.length, downloads: this.options.downloads, visitors: 0 },
          period: { photos: photos.length, downloads: 0, visitors: 0 },
          previous: { photos: 0, downloads: 0, visitors: 0 },
          days: list,
        };
      }
      case DRIVE_ROUTES.usage: {
        const used = this.options.usedBytes;
        const quota = this.options.quotaBytes;
        return {
          usedBytes: used,
          reservedBytes: this.reservedBytes,
          quotaBytes: quota,
          availableBytes: quota === null ? null : Math.max(0, quota - used - this.reservedBytes),
          trashBytes: 0,
          subscription: {
            status: 'active',
            planCode: 'standard',
            periodEnd: '2026-12-01T00:00:00.000Z',
          },
          uploadsBlockedBy: this.options.uploadsBlockedBy,
        };
      }
      case UPLOAD_ROUTES.init: {
        const b = body as {
          name: string;
          size: number;
          mime: string;
          folderId: string | null;
          relativePath?: string[];
          clientUploadId?: string;
        };
        const declaration = JSON.stringify([b.name, b.size, b.mime, b.folderId, b.relativePath]);
        if (b.clientUploadId !== undefined) {
          const previous = this.clientUploads.get(b.clientUploadId);
          if (previous !== undefined) {
            if (previous.declaration !== declaration) throw new Fail('IDEMPOTENCY_KEY_REUSED');
            const open = this.uploads.get(previous.fileId);
            if (open === undefined) throw new Fail('CONFLICT');
            return this.initResponse(open, []);
          }
        }
        if (this.options.uploadsBlockedBy === 'SUBSCRIPTION_INACTIVE') {
          throw new Fail('SUBSCRIPTION_INACTIVE', { status: 'grace' });
        }
        const decl = checkUploadDeclaration(
          { name: b.name, mime: b.mime, sizeBytes: b.size },
          { image: 100 * 1024 * 1024, video: 5 * 1024 ** 3 },
        );
        if (!decl.ok) throw new Fail(decl.code, decl.details);
        const quota = this.options.quotaBytes;
        const available =
          quota === null
            ? Number.POSITIVE_INFINITY
            : quota - this.options.usedBytes - this.reservedBytes;
        if (quota !== null && b.size > available) {
          throw new Fail('QUOTA_EXCEEDED', {
            quotaBytes: quota,
            usedBytes: this.options.usedBytes,
            reservedBytes: this.reservedBytes,
            requestedBytes: b.size,
            availableBytes: Math.max(0, available),
          });
        }
        let folderId = b.folderId;
        this.folderOrFail(folderId);
        const createdFolders: DriveFolder[] = [];
        for (const name of b.relativePath ?? []) {
          const existing = this.live(this.folders.values()).find(
            (f) => f.parentId === folderId && driveNameKey(f.name) === driveNameKey(name),
          );
          if (existing) folderId = existing.id;
          else {
            const created = this.addFolder(name, folderId);
            createdFolders.push(created);
            folderId = created.id;
          }
        }
        const file = this.addFile(b.name, folderId, {
          mime: decl.fileType.mime,
          mediaKind: decl.fileType.kind,
          sizeBytes: b.size,
          status: 'uploading',
          thumbUrl: undefined,
          width: null,
          height: null,
        });
        this.reservedBytes += b.size;
        const plan = multipartPlan(b.size, this.options.partBytes);
        const partSize = this.options.partSizeOverride ?? plan.partSize;
        const upload: Upload = { file, partSize, partCount: plan.partCount, parts: new Map() };
        this.uploads.set(file.id, upload);
        if (b.clientUploadId !== undefined) {
          this.clientUploads.set(b.clientUploadId, { fileId: file.id, declaration });
        }
        return this.initResponse(upload, createdFolders);
      }
      case UPLOAD_ROUTES.signParts: {
        const upload = this.uploadOrFail(params.id);
        const numbers = (body as { partNumbers: number[] }).partNumbers;
        if (numbers.some((n) => n > upload.partCount)) throw new Fail('VALIDATION_FAILED');
        return {
          parts: numbers.map((n) => this.partUrl(upload.file.id, n)),
          expiresAt: '2099-01-01T00:00:00.000Z',
        };
      }
      case UPLOAD_ROUTES.listParts: {
        const upload = this.uploadOrFail(params.id);
        return {
          parts: [...upload.parts.entries()]
            .sort(([a], [b]) => a - b)
            .map(([partNumber, p]) => ({ partNumber, etag: p.etag, size: p.size })),
        };
      }
      case UPLOAD_ROUTES.complete: {
        const upload = this.uploadOrFail(params.id);
        const parts = (body as { parts: { partNumber: number; etag: string }[] }).parts;
        const ok =
          parts.length === upload.partCount &&
          parts.every(
            (p, i) => p.partNumber === i + 1 && upload.parts.get(p.partNumber)?.etag === p.etag,
          );
        if (!ok) throw new Fail('UPLOAD_PARTS_INVALID');
        upload.file.status = 'processing';
        this.reservedBytes -= upload.file.sizeBytes;
        this.uploads.delete(upload.file.id);
        return { file: upload.file };
      }
      case UPLOAD_ROUTES.abort: {
        const upload = this.uploadOrFail(params.id);
        this.reservedBytes -= upload.file.sizeBytes;
        this.uploads.delete(upload.file.id);
        this.files.delete(upload.file.id);
        return undefined;
      }
      default:
        throw new Error(`FakeApi: unhandled route ${route.method} ${route.path}`);
    }
  }

  private initResponse(upload: Upload, createdFolders: DriveFolder[]) {
    const { file } = upload;
    const first = Math.min(this.options.initPresignedParts, upload.partCount);
    return {
      fileId: file.id,
      uploadId: `upload-${file.id}`,
      file,
      createdFolders,
      partSize: upload.partSize,
      partCount: upload.partCount,
      maxConcurrency: 4,
      parts: Array.from({ length: first }, (_, i) => this.partUrl(file.id, i + 1)),
      partUrlsExpireAt: '2099-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
  }

  private uploadOrFail(id: string | undefined): Upload {
    const upload = this.uploads.get(id ?? '');
    if (upload === undefined) throw new Fail('UPLOAD_NOT_FOUND');
    return upload;
  }

  private partUrl(fileId: string, partNumber: number) {
    return {
      partNumber,
      url: `https://shotx-test-media.s3.ap-southeast-1.amazonaws.com/originals/${fileId}/x?partNumber=${partNumber}&uploadId=u&X-Amz-Signature=s`,
    };
  }
}

const TRIAL: NonNullable<MeResponse['subscription']> = {
  status: 'trial',
  planCode: 'trial',
  periodEnd: '2026-11-08T05:00:00.000Z',
  cancelAtPeriodEnd: false,
};

function paramsOf(route: RouteContract, path: string): Record<string, string> {
  const names = route.path.split('/');
  const values = path.split('/');
  const params: Record<string, string> = {};
  names.forEach((segment, i) => {
    if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(values[i] ?? '');
  });
  return params;
}

function parse(
  schema: NonNullable<RouteContract['body']>,
  value: unknown,
  part: 'params' | 'query' | 'body' | 'headers',
): unknown {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Fail('VALIDATION_FAILED', validationFailedDetails(part, result.error));
  return result.data;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
