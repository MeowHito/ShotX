import {
  IDEMPOTENCY_KEY_HEADER,
  DRIVE_ROUTES,
  PUBLIC_SHARE_ROUTES,
  type SignedDownload,
  type ZipJobView,
} from '@shotx/shared';
import type { ApiClient } from '../api/client';
import { ClientError } from '../errors/messages';

/**
 * Share-page downloads. One file: a signed URL (Content-Disposition: attachment). Several: a zip
 * job created with a fresh Idempotency-Key per click (a retried request after a lost response
 * gets the same job), then polled until ready. On iOS the page may instead fetch each photo and
 * hand them to the Web Share API so they can be saved to Photos.
 */

/** Starts a browser download of a signed URL (same-origin `/media/...`). */
export function startBrowserDownload(url: string, fileName?: string): void {
  const a = document.createElement('a');
  a.href = url;
  if (fileName !== undefined) a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export async function requestSingleDownload(
  api: ApiClient,
  token: string,
  fileId: string,
): Promise<SignedDownload> {
  const res = await api.call(PUBLIC_SHARE_ROUTES.downloads, {
    params: { token },
    body: { fileIds: [fileId] },
  });
  if (res.kind !== 'file') throw new ClientError('client.contract');
  return res.file;
}

export async function createZipJob(
  api: ApiClient,
  token: string,
  fileIds: string[],
  idempotencyKey: string,
): Promise<ZipJobView> {
  const call = () =>
    api.call(PUBLIC_SHARE_ROUTES.downloads, {
      params: { token },
      headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      body: { fileIds },
    });
  let res;
  try {
    res = await call();
  } catch (error) {
    // A lost response is safe to retry with the same key: the API returns the same job.
    if (error instanceof Error && error.name === 'NetworkError') res = await call();
    else throw error;
  }
  if (res.kind !== 'zip') throw new ClientError('client.contract');
  return res.job;
}

export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
  onUpdate?: (job: ZipJobView) => void;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      },
      { once: true },
    );
  });
}

export type ReadyZipJob = ZipJobView & { download: NonNullable<ZipJobView['download']> };

/**
 * Polls GET /s/:token/zip-jobs/:id until the job is ready; the ready job has its download URL.
 * The route lives under the share's path so the share's unlock cookie reaches it.
 */
export function pollZipJob(
  api: ApiClient,
  token: string,
  job: ZipJobView,
  options: PollOptions,
): Promise<ReadyZipJob> {
  return pollUntilReady(
    (id, signal) => api.call(PUBLIC_SHARE_ROUTES.zipJob, { params: { token, id }, signal }),
    job,
    options,
  );
}

/** The owner's ZIP (a folder from the studio): polls GET /drive/zip-jobs/:id the same way. */
export function pollOwnerZipJob(
  api: ApiClient,
  job: ZipJobView,
  options: PollOptions,
): Promise<ReadyZipJob> {
  return pollUntilReady(
    (id, signal) => api.call(DRIVE_ROUTES.ownerZipJob, { params: { id }, signal }),
    job,
    options,
  );
}

async function pollUntilReady(
  fetchJob: (id: string, signal: AbortSignal | undefined) => Promise<ZipJobView>,
  job: ZipJobView,
  options: PollOptions,
): Promise<ReadyZipJob> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  let current = job;
  for (;;) {
    options.onUpdate?.(current);
    if (current.status === 'ready' && current.download !== null) {
      return { ...current, download: current.download };
    }
    if (current.status === 'failed') throw new ClientError('client.zipFailed');
    if (current.status === 'expired') throw new ClientError('client.zipExpired');
    if (now() >= deadline) throw new ClientError('client.zipTimeout');
    await sleep(options.intervalMs, options.signal);
    current = await fetchJob(current.id, options.signal);
  }
}

/** True when this browser can share image files (iOS Safari 15+, Android Chrome). */
export function canShareFiles(nav: Navigator | undefined): boolean {
  if (nav === undefined || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') {
    return false;
  }
  try {
    return nav.canShare({ files: [new File([], 'x.jpg', { type: 'image/jpeg' })] });
  } catch {
    return false;
  }
}

/**
 * Fetches one file's signed download into memory as a File, for navigator.share({ files }).
 * The photos are the photographer's (not biometrics) and are only held until shared.
 */
export async function fetchFileForShare(
  api: ApiClient,
  token: string,
  fileId: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  signal?: AbortSignal,
): Promise<File> {
  const download = await requestSingleDownload(api, token, fileId);
  // Signed URLs may be cross-origin (R2 with MEDIA_URL_SIGNER=s3-presign): a plain CORS GET
  // without cookies or custom headers, so no preflight; the bucket's CORS must allow GET from
  // the site's origin. The signature is in the URL, never in a header.
  const response = await fetchImpl(download.url, { credentials: 'omit', mode: 'cors', signal });
  if (!response.ok) throw new ClientError('client.saveFailed');
  const blob = await response.blob();
  return new File([blob], download.fileName, { type: blob.type || 'image/jpeg' });
}

/** {@link fetchFileForShare} for several files, one after another. */
export async function fetchFilesForShare(
  api: ApiClient,
  token: string,
  fileIds: string[],
  onProgress: (done: number) => void,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<File[]> {
  const files: File[] = [];
  for (const id of fileIds) {
    files.push(await fetchFileForShare(api, token, id, fetchImpl));
    onProgress(files.length);
  }
  return files;
}
