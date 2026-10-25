import {
  checkUploadDeclaration,
  DRIVE_ROUTES,
  type DriveFile,
  type DriveFolder,
  type DriveUsageResponse,
  driveNameKey,
  ERROR_HTTP_STATUS,
  type ErrorCode,
  multipartPlan,
  type RouteContract,
  UPLOAD_ROUTES,
  uploadFileType,
  validationFailedDetails,
} from '@shotx/shared';
import { matchRoute } from '@/lib/bff/handler';

/**
 * In-memory stand-in for the API, speaking the shared route contracts over `fetch`: request
 * params/query/body are parsed with the contract's zod schemas and every response is a valid
 * contract response. Used by the component and upload tests (the real API runs in another
 * worktree).
 */

const NOW = '2026-10-25T05:00:00.000Z';
const MEDIA = 'https://photos.example.com/media';

class Fail extends Error {
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
  quotaBytes?: number;
  usedBytes?: number;
  uploadsBlockedBy?: DriveUsageResponse['uploadsBlockedBy'];
  partBytes?: number;
  initPresignedParts?: number;
  /** Return a different part size than the client expects (plan mismatch test). */
  partSizeOverride?: number;
}

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
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

  constructor(options: FakeApiOptions = {}) {
    this.options = {
      pageSize: 100,
      quotaBytes: 10 * 1024 ** 3,
      usedBytes: 0,
      uploadsBlockedBy: null,
      partBytes: 16 * 1024 * 1024,
      initPresignedParts: 2,
      ...options,
    };
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

  fetch: typeof fetch = (input, init) => Promise.resolve(this.respond(input, init));

  private respond(input: RequestInfo | URL, init?: RequestInit): Response {
    const href = input instanceof Request ? input.url : input.toString();
    const url = new URL(href, 'http://localhost');
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/bff/, '');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    this.calls.push({ method, path, body });
    const route = matchRoute(method, path);
    if (route === null) return json(404, { code: 'NOT_FOUND', message: 'no route' });
    try {
      const params = route.params ? parse(route.params, paramsOf(route, path), 'params') : {};
      const query = route.query
        ? parse(route.query, Object.fromEntries(url.searchParams), 'query')
        : {};
      const parsedBody = route.body ? parse(route.body, body, 'body') : undefined;
      const result = this.handle(route, params as Record<string, string>, query, parsedBody);
      if (route.status === 204) return new Response(null, { status: 204 });
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

  private folderOrFail(id: string | null) {
    if (id === null) return null;
    const folder = this.folders.get(id);
    if (folder === undefined || folder.deletedAt !== null) throw new Fail('NOT_FOUND');
    return folder;
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

  private page<T>(items: T[], cursor: string | undefined, limit?: number) {
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
        return { folder, ancestors: this.ancestors(folder), items: slice, nextCursor: next };
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
        const b = body as { name?: string; parentId?: string | null };
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
      case DRIVE_ROUTES.usage: {
        const used = this.options.usedBytes;
        return {
          usedBytes: used,
          reservedBytes: this.reservedBytes,
          quotaBytes: this.options.quotaBytes,
          availableBytes: Math.max(0, this.options.quotaBytes - used - this.reservedBytes),
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
        };
        if (this.options.uploadsBlockedBy === 'SUBSCRIPTION_INACTIVE') {
          throw new Fail('SUBSCRIPTION_INACTIVE', { status: 'grace' });
        }
        const decl = checkUploadDeclaration(
          { name: b.name, mime: b.mime, sizeBytes: b.size },
          { image: 100 * 1024 * 1024, video: 5 * 1024 ** 3 },
        );
        if (!decl.ok) throw new Fail(decl.code, decl.details);
        const available = this.options.quotaBytes - this.options.usedBytes - this.reservedBytes;
        if (b.size > available) {
          throw new Fail('QUOTA_EXCEEDED', {
            quotaBytes: this.options.quotaBytes,
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
        this.uploads.set(file.id, { file, partSize, partCount: plan.partCount, parts: new Map() });
        const first = Math.min(this.options.initPresignedParts, plan.partCount);
        return {
          fileId: file.id,
          uploadId: `upload-${file.id}`,
          file,
          createdFolders,
          partSize,
          partCount: plan.partCount,
          maxConcurrency: 4,
          parts: Array.from({ length: first }, (_, i) => this.partUrl(file.id, i + 1)),
          partUrlsExpireAt: '2099-01-01T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
        };
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
  part: 'params' | 'query' | 'body',
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
