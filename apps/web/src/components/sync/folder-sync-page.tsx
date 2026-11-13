'use client';

import { Alert, Button, Checkbox, cn, Label } from '@shotx/ui';
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CopyCheckIcon,
  FolderIcon,
  FolderOpenIcon,
  LaptopIcon,
  PauseIcon,
  PlayIcon,
  SkipForwardIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { type ReactNode, useId, useState } from 'react';
import { MoveDialog } from '@/components/drive/move-dialog';
import { folderHref } from '@/components/drive/paths';
import type { RecentOutcome, SyncSnapshot } from '@/lib/sync/engine';
import { pickSyncFolder, type SyncDirectoryHandle } from '@/lib/sync/fs-access';
import type { SyncDestination } from '@/lib/sync/store';
import { useFolderSync } from './folder-sync-context';
import { WatermarkCard } from './watermark-card';

/** The studio folder sync page (ADR 0014): set up, watch and stop the sync. */
export function FolderSyncPage() {
  const t = useTranslations('folderSync');
  const { snapshot } = useFolderSync();

  return (
    <div className="w-full space-y-6">
      <header className="space-y-1">
        <h1 className="font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
          {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </header>

      {snapshot.status === 'loading' ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : snapshot.status === 'unsupported' ? (
        <Alert variant="warning" data-testid="sync-unsupported">
          <p className="font-semibold">{t('unsupportedTitle')}</p>
          <p className="mt-1">{t('unsupportedBody')}</p>
        </Alert>
      ) : snapshot.status === 'idle' ? (
        <SetupForm />
      ) : (
        <SyncStatus snapshot={snapshot} />
      )}

      {snapshot.status !== 'unsupported' && snapshot.status !== 'loading' ? (
        <WatermarkCard />
      ) : null}

      {snapshot.status !== 'unsupported' ? <Tips /> : null}
    </div>
  );
}

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn('space-y-4 rounded-xl border bg-background p-4 md:p-5', className)}>
      {children}
    </section>
  );
}

function SetupForm() {
  const t = useTranslations('folderSync');
  const tDrive = useTranslations('drive');
  const id = useId();
  const { setup } = useFolderSync();
  const [source, setSource] = useState<SyncDirectoryHandle | null>(null);
  const [destination, setDestination] = useState<SyncDestination>({
    id: null,
    name: tDrive('root'),
  });
  const [picking, setPicking] = useState(false);
  const [includeSubfolders, setIncludeSubfolders] = useState(true);
  const [includeExisting, setIncludeExisting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function chooseSource() {
    setError(null);
    try {
      const handle = await pickSyncFolder();
      if (handle !== null) setSource(handle);
    } catch {
      setError(t('pickFailed'));
    }
  }

  async function start() {
    if (source === null) return;
    setBusy(true);
    try {
      await setup({ handle: source, destination, includeSubfolders, includeExisting });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="font-semibold">{t('setup.title')}</h2>

      <div className="space-y-2">
        <p className="text-sm font-medium">{t('setup.source')}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" onClick={() => void chooseSource()}>
            <LaptopIcon aria-hidden />
            {source === null ? t('setup.chooseSource') : t('setup.changeSource')}
          </Button>
          {source !== null ? (
            <span className="flex min-w-0 items-center gap-2 text-sm" data-testid="sync-source">
              <FolderOpenIcon className="size-4 shrink-0 text-amber-500" aria-hidden />
              <span className="truncate font-medium">{source.name}</span>
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{t('setup.sourceHint')}</span>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">{t('setup.destination')}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" onClick={() => setPicking(true)}>
            <FolderIcon aria-hidden />
            {t('setup.chooseDestination')}
          </Button>
          <span className="flex min-w-0 items-center gap-2 text-sm" data-testid="sync-destination">
            <FolderIcon className="size-4 shrink-0 text-amber-500" aria-hidden />
            <span className="truncate font-medium">{destination.name}</span>
          </span>
        </div>
      </div>

      <div className="flex items-start gap-3">
        <Checkbox
          id={`${id}-sub`}
          checked={includeSubfolders}
          onCheckedChange={(v) => setIncludeSubfolders(v === true)}
        />
        <Label htmlFor={`${id}-sub`}>{t('setup.includeSubfolders')}</Label>
      </div>
      <div className="flex items-start gap-3">
        <Checkbox
          id={`${id}-existing`}
          checked={includeExisting}
          onCheckedChange={(v) => setIncludeExisting(v === true)}
        />
        <div className="grid gap-0.5">
          <Label htmlFor={`${id}-existing`}>{t('setup.includeExisting')}</Label>
          <span className="text-xs text-muted-foreground">{t('setup.includeExistingHint')}</span>
        </div>
      </div>

      {error !== null ? <Alert variant="destructive">{error}</Alert> : null}

      <Button
        type="button"
        className="w-full sm:w-auto"
        disabled={source === null || busy}
        onClick={() => void start()}
      >
        <PlayIcon aria-hidden />
        {t('setup.start')}
      </Button>

      <MoveDialog
        open={picking}
        onOpenChange={setPicking}
        items={[]}
        title={t('setup.destinationTitle')}
        confirmLabel={t('setup.destinationConfirm')}
        onMove={(folderId, name) => {
          setDestination({ id: folderId, name });
          return Promise.resolve();
        }}
      />
    </Card>
  );
}

/** The statuses this card shows (setup, loading and unsupported have their own views). */
function statusLabel(status: SyncSnapshot['status']) {
  return status === 'running' || status === 'needsPermission' || status === 'error'
    ? status
    : 'paused';
}

const STAT_KEYS = ['uploaded', 'uploading', 'waiting', 'exists', 'skipped', 'failed'] as const;

function SyncStatus({ snapshot }: { snapshot: SyncSnapshot }) {
  const t = useTranslations('folderSync');
  const format = useFormatter();
  const { resume, pause, stop } = useFolderSync();
  const [busy, setBusy] = useState(false);
  const job = snapshot.job;
  const folder = job?.folderName ?? '';

  async function act(run: () => Promise<void> | void) {
    setBusy(true);
    try {
      await run();
    } finally {
      setBusy(false);
    }
  }

  const status = snapshot.status;
  const badge =
    status === 'running'
      ? 'bg-green-500/15 text-green-700 dark:text-green-400'
      : status === 'error'
        ? 'bg-destructive/10 text-destructive'
        : 'bg-muted text-muted-foreground';

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span
            className={cn(
              'inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold',
              badge,
            )}
            data-testid="sync-status"
            data-status={status}
          >
            {status === 'running' ? (
              <span className="size-2 rounded-full bg-green-500 motion-safe:animate-pulse" />
            ) : null}
            {t(`status.${statusLabel(status)}`)}
          </span>
          {snapshot.lastScanAt !== null ? (
            <span className="text-xs text-muted-foreground">
              {t('lastScan', {
                time: format.dateTime(new Date(snapshot.lastScanAt), {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                }),
              })}
            </span>
          ) : null}
        </div>

        {job !== null ? (
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <LaptopIcon className="size-4 text-muted-foreground" aria-hidden />
            <span className="font-medium">{job.folderName}</span>
            <span aria-hidden>→</span>
            <FolderIcon className="size-4 text-amber-500" aria-hidden />
            <Link
              className="font-medium underline-offset-4 hover:underline"
              href={folderHref(job.destination.id)}
            >
              {job.destination.name}
            </Link>
          </p>
        ) : null}

        {status === 'needsPermission' ? (
          <Alert variant="warning">{t('permissionBody', { folder })}</Alert>
        ) : null}
        {status === 'error' && snapshot.error !== null ? (
          <Alert variant="destructive" data-testid="sync-error">
            {t(`errors.${snapshot.error}`, { folder })}
          </Alert>
        ) : null}

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {STAT_KEYS.map((key) => (
            <div key={key} className="rounded-lg bg-surface px-3 py-2">
              <dt className="text-xs text-muted-foreground">{t(`stats.${key}`)}</dt>
              <dd className="text-lg font-semibold tabular-nums" data-testid={`sync-stat-${key}`}>
                {format.number(snapshot.stats[key])}
              </dd>
            </div>
          ))}
        </dl>
        {snapshot.stats.ignored > 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('ignored', { count: snapshot.stats.ignored })}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {status === 'running' ? (
            <Button type="button" variant="outline" disabled={busy} onClick={() => pause()}>
              <PauseIcon aria-hidden />
              {t('pause')}
            </Button>
          ) : (
            <Button type="button" disabled={busy} onClick={() => void act(resume)}>
              <PlayIcon aria-hidden />
              {status === 'needsPermission' ? t('allow') : t('resume')}
            </Button>
          )}
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void act(stop)}>
            {t('stop')}
          </Button>
        </div>
      </Card>

      <Card>
        <h2 className="font-semibold">{t('recentTitle')}</h2>
        {snapshot.recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('recentEmpty')}</p>
        ) : (
          <ul className="divide-y" data-testid="sync-recent">
            {snapshot.recent.map((item) => (
              <li key={`${item.path}-${item.at}`} className="flex items-center gap-3 py-2">
                <OutcomeIcon outcome={item.outcome} />
                <span className="min-w-0 flex-1 truncate text-sm" title={item.path}>
                  {item.path}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t(`outcome.${item.outcome}`)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function OutcomeIcon({ outcome }: { outcome: RecentOutcome }) {
  const className = 'size-4 shrink-0';
  switch (outcome) {
    case 'uploaded':
      return <CheckCircle2Icon className={cn(className, 'text-green-600')} aria-hidden />;
    case 'exists':
      return <CopyCheckIcon className={cn(className, 'text-muted-foreground')} aria-hidden />;
    case 'skipped':
      return <SkipForwardIcon className={cn(className, 'text-muted-foreground')} aria-hidden />;
    case 'failed':
      return <CircleAlertIcon className={cn(className, 'text-destructive')} aria-hidden />;
  }
}

function Tips() {
  const t = useTranslations('folderSync');
  return (
    <section className="space-y-2 rounded-xl bg-surface p-4 text-sm md:p-5">
      <h2 className="font-semibold">{t('tips.title')}</h2>
      <ol className="list-decimal space-y-1.5 pl-5 text-muted-foreground">
        <li>{t('tips.lightroom')}</li>
        <li>{t('tips.keepOpen')}</li>
        <li>{t('tips.noSleep')}</li>
        <li>{t('tips.noDuplicates')}</li>
      </ol>
    </section>
  );
}
