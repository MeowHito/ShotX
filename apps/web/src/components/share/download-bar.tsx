'use client';

import type { DownloadSize, ShareItem } from '@shotx/shared';
import { Alert, Button } from '@shotx/ui';
import { CircleCheckIcon, DownloadIcon, ImageDownIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { canShareFiles, fetchFileForShare, requestSingleDownload } from '@/lib/downloads/downloads';
import { isIOS } from '@/lib/face/camera';
import type { ClientShareConfig } from '@/lib/face/config';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useShareApi } from '@/lib/share/share-api';
import { useShareRuntime } from './share-runtime';
import type { LightboxDownload } from './use-lightbox';

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

/** Photos the lightbox keeps fetched ahead of the tap: the one on screen and the last ones seen. */
const LIGHTBOX_PREFETCH_KEEP = 3;

interface PreparedPhoto {
  controller: AbortController;
  promise: Promise<File>;
  file: File | null;
}

/**
 * The lightbox's download button. On iOS with the share sheet (Safari): "save to Photos" — the
 * photo on screen is fetched as soon as it shows, so one tap opens the share sheet ("Save
 * Image") straight from the gesture, as Safari requires; a plain download would only reach the
 * Files app (owner, 2026-11-13). Tapped before the photo is in: the sheet opens once it is, or,
 * when Safari has let the tap expire, the button asks for one more tap. Videos are fetched only
 * on tap. Elsewhere: the file downloads, as before.
 */
export function useLightboxDownload(
  token: string,
  onError: (error: unknown) => void,
): LightboxDownload {
  const tLightbox = useTranslations('lightbox');
  const { api } = useShareApi();
  const runtime = useShareRuntime();
  const single = useSingleDownload(token);
  const nav = runtime.navigator();
  const savesToPhotos = nav !== undefined && isIOS(nav) && canShareFiles(nav);
  const cache = useRef(new Map<string, PreparedPhoto>());
  const errorRef = useRef(onError);
  useEffect(() => {
    errorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    const map = cache.current;
    return () => {
      for (const entry of map.values()) entry.controller.abort();
      map.clear();
    };
  }, []);

  return useMemo<LightboxDownload>(() => {
    const prepare = (item: ShareItem): PreparedPhoto => {
      const map = cache.current;
      const existing = map.get(item.id);
      if (existing !== undefined) {
        // Most recently seen last: the oldest is dropped first.
        map.delete(item.id);
        map.set(item.id, existing);
        return existing;
      }
      const controller = new AbortController();
      const entry: PreparedPhoto = {
        controller,
        file: null,
        promise: fetchFileForShare(api, token, item.id, runtime.fetch, controller.signal),
      };
      entry.promise.then(
        (file) => {
          entry.file = file;
        },
        () => {
          // A failed fetch is tried again on the next tap.
          if (map.get(item.id) === entry) map.delete(item.id);
        },
      );
      map.set(item.id, entry);
      while (map.size > LIGHTBOX_PREFETCH_KEEP) {
        const [oldestId, oldest] = map.entries().next().value as [string, PreparedPhoto];
        oldest.controller.abort();
        map.delete(oldestId);
      }
      return entry;
    };

    if (!savesToPhotos || nav === undefined) {
      return {
        onClick: (item) => {
          single(item).catch((err: unknown) => errorRef.current(err));
        },
      };
    }

    const share = async (file: File, setLabel: (label: string) => void) => {
      try {
        await nav.share({ files: [file] });
        setLabel(tLightbox('saved'));
      } catch (err) {
        if (err instanceof Error && err.name === 'NotAllowedError') setLabel(tLightbox('tapAgain'));
        else if (err instanceof Error && err.name === 'AbortError') setLabel(tLightbox('saveShort'));
        else {
          setLabel(tLightbox('saveShort'));
          errorRef.current(err);
        }
      }
    };

    return {
      label: tLightbox('saveShort'),
      title: tLightbox('save'),
      onShow: (item) => {
        if (item.mediaKind === 'image') prepare(item);
      },
      onClose: () => {
        for (const entry of cache.current.values()) entry.controller.abort();
        cache.current.clear();
      },
      onClick: (item, setLabel) => {
        const entry = prepare(item);
        // Straight from the tap when the photo is in: Safari requires a fresh user gesture.
        if (entry.file !== null) {
          void share(entry.file, setLabel);
          return;
        }
        setLabel(tLightbox('preparing'));
        entry.promise.then(
          (file) => void share(file, setLabel),
          (err: unknown) => {
            setLabel(tLightbox('saveShort'));
            if (!(err instanceof Error && err.name === 'AbortError')) errorRef.current(err);
          },
        );
      },
    };
  }, [api, token, runtime, nav, savesToPhotos, single, tLightbox]);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The selected photos fetched into memory ahead of the tap (ADR 0012), so "save to Photos" can
 * call navigator.share() straight from the tap: Safari needs a fresh user gesture for share(),
 * and fetching after the tap used to cost a second tap. Fetches at most `concurrency` at once;
 * a deselected photo is aborted and dropped. `files` lists the selection's files in order once
 * every one is in, else null.
 */
function usePreparedPhotos(
  token: string,
  selection: readonly ShareItem[],
  enabled: boolean,
  concurrency: number,
) {
  const { api } = useShareApi();
  const runtime = useShareRuntime();
  const [ready, setReady] = useState<ReadonlyMap<string, File>>(new Map());
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const [round, setRound] = useState(0);
  // Wanted photos: their abort controller and whether their fetch has started.
  const jobs = useRef(new Map<string, { controller: AbortController; started: boolean }>());

  useEffect(() => {
    const wanted = new Set(enabled ? selection.map((i) => i.id) : []);
    const map = jobs.current;
    for (const [id, job] of map) {
      if (!wanted.has(id)) {
        job.controller.abort();
        map.delete(id);
      }
    }
    for (const id of wanted) {
      if (!map.has(id)) map.set(id, { controller: new AbortController(), started: false });
    }
    const keep = <T,>(prev: ReadonlyMap<string, T>) => {
      if ([...prev.keys()].every((id) => map.has(id))) return prev;
      return new Map([...prev].filter(([id]) => map.has(id)));
    };
    // Drop deselected photos from memory.
    setReady(keep);
    setFailed((prev) => {
      const next = new Set([...prev].filter((id) => map.has(id)));
      return next.size === prev.size ? prev : next;
    });

    const pump = () => {
      let active = 0;
      for (const job of map.values()) if (job.started && !job.controller.signal.aborted) active++;
      for (const [id, job] of map) {
        if (active >= concurrency) break;
        if (job.started) continue;
        job.started = true;
        active++;
        fetchFileForShare(api, token, id, runtime.fetch, job.controller.signal)
          .then(
            (file) => {
              if (map.get(id) === job) setReady((prev) => new Map(prev).set(id, file));
            },
            () => {
              if (map.get(id) === job) setFailed((prev) => new Set(prev).add(id));
            },
          )
          .finally(() => {
            // Done (or failed): no longer counts as active.
            if (map.get(id) === job) job.controller.abort();
            pump();
          });
      }
    };
    pump();
  }, [api, token, runtime, selection, enabled, concurrency, round]);

  // Unmount: stop every fetch.
  useEffect(() => {
    const map = jobs.current;
    return () => {
      for (const job of map.values()) job.controller.abort();
      map.clear();
    };
  }, []);

  const done = selection.filter((i) => ready.has(i.id)).length;
  const files =
    enabled && selection.length > 0 && done === selection.length
      ? selection.map((i) => ready.get(i.id) as File)
      : null;
  const anyFailed = selection.some((i) => failed.has(i.id));

  /** Fetches the failed photos again. */
  const retry = useCallback(() => {
    for (const id of failed) jobs.current.delete(id);
    setFailed(new Set());
    setRound((r) => r + 1);
  }, [failed]);

  return { files, done, anyFailed, retry };
}

/**
 * The selection's action, sticky at the bottom (safe-area aware), one large button (ADR 0012):
 * - iOS (and any browser that can share files on iOS): "save to Photos". The photos are fetched
 *   as soon as they are selected, so one tap opens the share sheet with them. Tapped before
 *   they're in: the button shows the progress and opens the sheet when they are; if Safari has
 *   let the tap expire by then, the button asks for one more tap.
 * - Elsewhere: each photo downloads as its own file, one after another. No zip on share pages.
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
  const runtime = useShareRuntime();
  const single = useSingleDownload(token);
  const nav = runtime.navigator();
  const savesToPhotos = nav !== undefined && isIOS(nav) && canShareFiles(nav);
  const tooMany = selection.length > config.iosShareMaxFiles;
  const prepared = usePreparedPhotos(
    token,
    selection,
    savesToPhotos && !tooMany,
    config.photoPrefetchConcurrency,
  );
  const [error, setError] = useState<string | null>(null);
  // Per selection: tapped before the photos were in / the tap expired before the share sheet.
  const [waitingFor, setWaitingFor] = useState<readonly ShareItem[] | null>(null);
  const [tapAgainFor, setTapAgainFor] = useState<readonly ShareItem[] | null>(null);
  const [downloading, setDownloading] = useState<{ done: number; total: number } | null>(null);
  // Owner, 2026-11-13: a clear "done" with a check once the photos are on the phone.
  const [savedFor, setSavedFor] = useState<readonly ShareItem[] | null>(null);
  const saved = savedFor === selection;
  const waiting = waitingFor === selection;
  const tapAgain = tapAgainFor === selection;

  const share = useCallback(
    async (files: File[], forSelection: readonly ShareItem[]) => {
      if (nav === undefined) return;
      try {
        await nav.share({ files });
        setTapAgainFor(null);
        // The share sheet resolves once an action (e.g. "Save Images") finished; cancel rejects.
        setSavedFor(forSelection);
      } catch (err) {
        if (err instanceof Error && err.name === 'NotAllowedError') setTapAgainFor(forSelection);
        else if (!(err instanceof Error && err.name === 'AbortError')) setError(describe(err));
      }
    },
    [nav, describe],
  );

  // Tapped while the photos were still loading: open the share sheet once they are in (once
  // per selection).
  const files = prepared.files;
  const sharedWhenReady = useRef<readonly ShareItem[] | null>(null);
  useEffect(() => {
    if (!waiting || files === null || sharedWhenReady.current === selection) return;
    sharedWhenReady.current = selection;
    void share(files, selection);
  }, [waiting, files, selection, share]);

  function saveToPhotos() {
    setError(null);
    if (tooMany) {
      setError(t('tooManyToSave', { max: config.iosShareMaxFiles }));
      return;
    }
    // Straight from the tap when the photos are in: Safari requires a fresh user gesture.
    if (files !== null) {
      void share(files, selection);
      return;
    }
    if (prepared.anyFailed) prepared.retry();
    setWaitingFor(selection);
  }

  async function downloadEach() {
    setError(null);
    const items = [...selection];
    const sleep = runtime.sleep ?? defaultSleep;
    setDownloading({ done: 0, total: items.length });
    try {
      for (const [index, item] of items.entries()) {
        if (index > 0) await sleep(config.downloadGapMs);
        await single(item);
        setDownloading({ done: index + 1, total: items.length });
      }
      setSavedFor(selection);
    } catch (err) {
      setError(describe(err));
    } finally {
      setDownloading(null);
    }
  }

  if (selection.length === 0) return null;

  if (saved) {
    return (
      <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-lg backdrop-blur sm:inset-x-4 sm:bottom-24 sm:mx-auto sm:max-w-md sm:rounded-2xl sm:border">
        <div
          role="status"
          className="mx-auto flex max-w-5xl flex-col items-center gap-2 text-center"
        >
          <CircleCheckIcon className="size-12 text-emerald-500" aria-hidden />
          <p className="text-lg font-semibold">
            {savesToPhotos
              ? t('savedTitle', { count: selection.length })
              : t('downloadedTitle', { count: selection.length })}
          </p>
          <p className="text-sm text-muted-foreground">
            {savesToPhotos ? t('savedBody') : t('downloadedBody')}
          </p>
          <Button
            size="lg"
            className="mt-1 h-12 w-full max-w-xs rounded-full"
            onClick={() => {
              setSavedFor(null);
              onClear();
            }}
          >
            {t('savedDone')}
          </Button>
        </div>
      </div>
    );
  }

  let label: string;
  if (!savesToPhotos) {
    label =
      downloading !== null
        ? t('downloading', { done: downloading.done, total: downloading.total })
        : t('downloadSelected', { count: selection.length });
  } else if (waiting && files === null) {
    label = t('preparing', { done: prepared.done, total: selection.length });
  } else if (tapAgain) {
    label = t('readyToSave', { count: selection.length });
  } else {
    label = t('saveToPhotos');
  }
  const Icon = savesToPhotos ? ImageDownIcon : DownloadIcon;

  return (
    // Phones: a full-width bar at the bottom. Wider screens: a floating card raised above the
    // bottom edge, where a macOS Dock that never hides would cover it (owner, ADR 0015).
    <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-lg backdrop-blur sm:inset-x-4 sm:bottom-24 sm:mx-auto sm:max-w-md sm:rounded-2xl sm:border sm:pb-3">
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
        <Button
          size="lg"
          className="h-14 w-full rounded-full text-base"
          onClick={() => (savesToPhotos ? saveToPhotos() : void downloadEach())}
          disabled={(savesToPhotos && waiting && files === null) || downloading !== null}
        >
          <Icon className="size-6" aria-hidden />
          {label}
        </Button>
        {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      </div>
    </div>
  );
}
