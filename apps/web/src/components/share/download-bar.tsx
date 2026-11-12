'use client';

import type { DownloadSize, ShareItem, ZipJobViewStatus } from '@shotx/shared';
import { Alert, Button } from '@shotx/ui';
import { DownloadIcon, ImageDownIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  canShareFiles,
  createZipJob,
  fetchFilesForShare,
  newIdempotencyKey,
  pollZipJob,
  requestSingleDownload,
} from '@/lib/downloads/downloads';
import { isIOS } from '@/lib/face/camera';
import type { ClientShareConfig } from '@/lib/face/config';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useShareApi } from '@/lib/share/share-api';
import { useShareRuntime } from './share-runtime';

/** Download of one item (lightbox button, single selection): a signed URL, then the browser. */
export function useSingleDownload(token: string) {
  const { api } = useShareApi();
  const runtime = useShareRuntime();
  return useCallback(
    async (item: ShareItem) => {
      const download = await requestSingleDownload(api, token, item.id);
      runtime.startDownload(download.url, download.fileName);
    },
    [api, token, runtime],
  );
}

/** `items` in groups of at most `size` (the API's ZIP_MAX_FILES per zip). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) {
    chunks.push(items.slice(i, i + Math.max(1, size)));
  }
  return chunks;
}

export interface DownloaderState {
  busy: boolean;
  error: string | null;
  zipStatus: ZipJobViewStatus | null;
  /** Set while several zips are made one after another (more than ZIP_MAX_FILES photos). */
  part: { current: number; total: number } | null;
}

/**
 * Downloads a set of photos (POST /s/:token/downloads): one file directly; several as zips of at
 * most `maxFiles` (meta.zip.maxFiles) each, one after another, each with a fresh Idempotency-Key
 * and polled until ready. Used by the selection bar ("download selected") and the results
 * ("download all found").
 */
export function useDownloader(token: string, config: ClientShareConfig, maxFiles: number) {
  const describe = useErrorMessage();
  const { api } = useShareApi();
  const runtime = useShareRuntime();
  const single = useSingleDownload(token);
  const [state, setState] = useState<DownloaderState>({
    busy: false,
    error: null,
    zipStatus: null,
    part: null,
  });
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  async function download(items: readonly ShareItem[]) {
    if (items.length === 0) return;
    setState({ busy: true, error: null, zipStatus: null, part: null });
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const parts = chunk(items, maxFiles);
      for (const [index, part] of parts.entries()) {
        if (parts.length > 1) {
          setState((s) => ({ ...s, part: { current: index + 1, total: parts.length } }));
        }
        if (part.length === 1) {
          await single(part[0] as ShareItem);
          continue;
        }
        // One key per click and part: a retried request returns the same job.
        const job = await createZipJob(
          api,
          token,
          part.map((i) => i.id),
          newIdempotencyKey(),
        );
        const ready = await pollZipJob(api, token, job, {
          intervalMs: config.zipPollIntervalMs,
          timeoutMs: config.zipPollTimeoutMs,
          signal: controller.signal,
          sleep: runtime.sleep,
          onUpdate: (j) => setState((s) => ({ ...s, zipStatus: j.status })),
        });
        runtime.startDownload(ready.download.url, ready.download.fileName);
      }
      setState({ busy: false, error: null, zipStatus: null, part: null });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      setState({ busy: false, error: aborted ? null : describe(err), zipStatus: null, part: null });
    }
  }

  return { ...state, download };
}

/** What a download is doing right now, as one status line. */
export function DownloadStatus({ state }: { state: DownloaderState }) {
  const t = useTranslations('downloads');
  return (
    <>
      {state.part !== null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('part', { current: state.part.current, total: state.part.total })}
        </p>
      ) : null}
      {state.zipStatus !== null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t(`zipStatus.${state.zipStatus}`)}
        </p>
      ) : null}
      {state.error !== null ? <Alert variant="destructive">{state.error}</Alert> : null}
    </>
  );
}

/**
 * The selection's actions, sticky at the bottom (safe-area aware): download (one file directly,
 * several as zips) and, on iOS, save the photos to Photos through the Web Share API, since ZIP
 * files are awkward on iPhone.
 */
export function DownloadBar({
  token,
  selection,
  downloadSize,
  config,
  maxFiles,
  onClear,
}: {
  token: string;
  selection: readonly ShareItem[];
  downloadSize: DownloadSize;
  config: ClientShareConfig;
  /** meta.zip.maxFiles. */
  maxFiles: number;
  onClear: () => void;
}) {
  const t = useTranslations('downloads');
  const describe = useErrorMessage();
  const { api } = useShareApi();
  const runtime = useShareRuntime();
  const downloader = useDownloader(token, config, maxFiles);
  const [preparing, setPreparing] = useState<{ done: number; total: number } | null>(null);
  const [preparedFor, setPreparedFor] = useState<{
    selection: readonly ShareItem[];
    files: File[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Photos prepared for another selection don't count.
  const prepared = preparedFor?.selection === selection ? preparedFor.files : null;

  const nav = runtime.navigator();
  const offerPhotos = nav !== undefined && isIOS(nav) && canShareFiles(nav) && selection.length > 0;

  async function prepareForPhotos() {
    if (selection.length > config.iosShareMaxFiles) {
      setError(t('tooManyToSave', { max: config.iosShareMaxFiles }));
      return;
    }
    setError(null);
    setBusy(true);
    setPreparing({ done: 0, total: selection.length });
    try {
      const files = await fetchFilesForShare(
        api,
        token,
        selection.map((i) => i.id),
        (done) => setPreparing({ done, total: selection.length }),
        runtime.fetch,
      );
      setPreparedFor({ selection, files });
    } catch (err) {
      setError(describe(err));
    } finally {
      setPreparing(null);
      setBusy(false);
    }
  }

  async function saveToPhotos() {
    const files = prepared;
    if (files === null || nav === undefined) return;
    // Called straight from the tap: Safari requires a fresh user gesture for share().
    try {
      await nav.share({ files });
      setPreparedFor(null);
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) setError(describe(err));
    }
  }

  if (selection.length === 0) return null;
  const working = busy || downloader.busy;

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-lg backdrop-blur">
      <div className="mx-auto flex max-w-5xl flex-col gap-2">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span role="status" className="font-medium">
            {t('selected', { count: selection.length })}
            <span className="ml-2 text-muted-foreground">
              {t('size', { size: t(`sizes.${downloadSize}`) })}
            </span>
          </span>
          <Button variant="ghost" size="sm" onClick={onClear} aria-label={t('clear')}>
            <XIcon aria-hidden />
          </Button>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          {prepared !== null ? (
            <Button size="lg" className="flex-1" onClick={() => void saveToPhotos()}>
              <ImageDownIcon aria-hidden />
              {t('readyToSave', { count: prepared.length })}
            </Button>
          ) : offerPhotos ? (
            <Button
              size="lg"
              className="flex-1"
              onClick={() => void prepareForPhotos()}
              disabled={working}
            >
              <ImageDownIcon aria-hidden />
              {preparing !== null
                ? t('preparing', { done: preparing.done, total: preparing.total })
                : t('saveToPhotos')}
            </Button>
          ) : null}
          <Button
            size="lg"
            variant={offerPhotos ? 'outline' : 'default'}
            className="flex-1"
            onClick={() => void downloader.download(selection)}
            disabled={working}
          >
            <DownloadIcon aria-hidden />
            {t('downloadSelected', { count: selection.length })}
          </Button>
        </div>
        <DownloadStatus state={downloader} />
        {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      </div>
    </div>
  );
}
