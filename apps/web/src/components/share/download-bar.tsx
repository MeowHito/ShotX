'use client';

import type { DownloadSize, ShareItem, ZipJobViewStatus } from '@shotx/shared';
import { Alert, Button } from '@shotx/ui';
import { DownloadIcon, ImageDownIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
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
  return async (item: ShareItem) => {
    const download = await requestSingleDownload(api, token, item.id);
    runtime.startDownload(download.url, download.fileName);
  };
}

/**
 * The selection's actions, sticky at the bottom on phones: download (one file directly, several
 * as a zip with a fresh Idempotency-Key per click, polled until ready) and, on iOS, save the
 * photos to Photos through the Web Share API, since ZIP files are awkward on iPhone.
 */
export function DownloadBar({
  token,
  selection,
  downloadSize,
  config,
  onClear,
}: {
  token: string;
  selection: readonly ShareItem[];
  downloadSize: DownloadSize;
  config: ClientShareConfig;
  onClear: () => void;
}) {
  const t = useTranslations('downloads');
  const describe = useErrorMessage();
  const { api } = useShareApi();
  const runtime = useShareRuntime();
  const single = useSingleDownload(token);
  const [zipStatus, setZipStatus] = useState<ZipJobViewStatus | null>(null);
  const [preparing, setPreparing] = useState<{ done: number; total: number } | null>(null);
  const [preparedFor, setPreparedFor] = useState<{
    selection: readonly ShareItem[];
    files: File[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  // Photos prepared for another selection don't count.
  const prepared = preparedFor?.selection === selection ? preparedFor.files : null;

  const nav = runtime.navigator();
  const offerPhotos = nav !== undefined && isIOS(nav) && canShareFiles(nav) && selection.length > 0;

  async function download() {
    setError(null);
    setBusy(true);
    try {
      if (selection.length === 1) {
        await single(selection[0] as ShareItem);
        return;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      // One key per click: a retried request returns the same job, a new click a new job.
      const job = await createZipJob(
        api,
        token,
        selection.map((i) => i.id),
        newIdempotencyKey(),
      );
      const ready = await pollZipJob(api, token, job, {
        intervalMs: config.zipPollIntervalMs,
        timeoutMs: config.zipPollTimeoutMs,
        signal: controller.signal,
        sleep: runtime.sleep,
        onUpdate: (j) => setZipStatus(j.status),
      });
      runtime.startDownload(ready.download.url, ready.download.fileName);
    } catch (err) {
      setZipStatus(null);
      if (!(err instanceof Error && err.name === 'AbortError')) setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

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
              disabled={busy}
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
            onClick={() => void download()}
            disabled={busy}
          >
            <DownloadIcon aria-hidden />
            {t('downloadSelected', { count: selection.length })}
          </Button>
        </div>
        {zipStatus !== null ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t(`zipStatus.${zipStatus}`)}
          </p>
        ) : null}
        {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      </div>
    </div>
  );
}
