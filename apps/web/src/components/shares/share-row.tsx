'use client';

import { type OwnerShare, shareFaceDeletionPagePath, shareRefOf } from '@shotx/shared';
import {
  Alert,
  Button,
  buttonVariants,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@shotx/ui';
import { BarChart3Icon, CopyIcon, FileIcon, FolderIcon, LinkIcon, UserXIcon } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { shareHref } from '@/components/drive/paths';
import { ClientError } from '@/lib/errors/messages';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useRevokeShare } from '@/lib/studio/queries';

async function copyText(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
    throw new ClientError('client.copyFailed');
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    throw new ClientError('client.copyFailed');
  }
}

/**
 * The absolute link of a share's "delete my face" page (`/{slug or token}/delete-my-face`).
 * ADR 0011 decision 2: the public pages never link to it; the photographer sends it to a person
 * who asks for their face data to be deleted (the consent text tells people to ask them).
 */
export function faceDeletionUrl(share: Pick<OwnerShare, 'url' | 'slug' | 'token'>): string {
  return `${new URL(share.url).origin}${shareFaceDeletionPagePath(shareRefOf(share))}`;
}

/**
 * One share as its owner sees it: link, flags, status, copy, revoke, stats, and the "delete my
 * face" link to send on request (studio only).
 */
export function ShareRow({
  share,
  showTarget = true,
}: {
  share: OwnerShare;
  showTarget?: boolean;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const describe = useErrorMessage();
  const revoke = useRevokeShare();
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const active = share.status === 'active';

  async function copy() {
    try {
      await copyText(share.url);
      setMessage({ kind: 'info', text: t('shares.copied') });
    } catch (err) {
      setMessage({ kind: 'error', text: describe(err) });
    }
  }

  async function copyDeletionLink() {
    try {
      await copyText(faceDeletionUrl(share));
      setMessage({ kind: 'info', text: t('shares.deletionLinkCopied') });
    } catch (err) {
      setMessage({ kind: 'error', text: describe(err) });
    }
  }

  async function doRevoke() {
    try {
      await revoke.mutateAsync(share.id);
      setConfirming(false);
      setMessage({ kind: 'info', text: t('shares.revoked') });
    } catch (err) {
      setMessage({ kind: 'error', text: describe(err) });
    }
  }

  const flags = [
    share.mode === 'face_only' ? t('shares.faceOnly') : null,
    share.passwordProtected ? t('shares.passwordProtected') : null,
    share.requireLogin ? t('shares.requireLogin') : null,
    share.allowDownload ? null : t('shares.noDownload'),
    share.expiresAt !== null
      ? t('shares.expiresAt', {
          date: format.dateTime(new Date(share.expiresAt), { dateStyle: 'medium' }),
        })
      : null,
  ].filter((f): f is string => f !== null);

  return (
    <div className="space-y-2 rounded-xl border p-3">
      <div className="flex flex-wrap items-center gap-2">
        {showTarget ? (
          <span className="flex min-w-0 items-center gap-1.5 font-medium">
            {share.target.type === 'folder' ? (
              <FolderIcon
                className="size-4 shrink-0 text-amber-500"
                aria-label={t('shares.folder')}
              />
            ) : (
              <FileIcon className="size-4 shrink-0" aria-label={t('shares.file')} />
            )}
            <span className="truncate">{share.target.name}</span>
          </span>
        ) : null}
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs',
            active ? 'bg-emerald-100 text-emerald-800' : 'bg-muted text-muted-foreground',
          )}
        >
          {t(`shares.status.${share.status}`)}
        </span>
      </div>
      <p className="flex items-center gap-1.5 text-sm break-all text-muted-foreground">
        <LinkIcon className="size-3.5 shrink-0" aria-hidden />
        {share.url}
      </p>
      {flags.length > 0 ? (
        <p className="text-xs text-muted-foreground">{flags.join(' · ')}</p>
      ) : null}
      {share.target.unavailable ? (
        <Alert variant="warning">{t('shares.targetUnavailable')}</Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {active ? (
          <Button size="sm" variant="outline" onClick={() => void copy()}>
            <CopyIcon aria-hidden />
            {t('shares.copy')}
          </Button>
        ) : null}
        <Link
          href={shareHref(share.id)}
          className={buttonVariants({ size: 'sm', variant: 'outline' })}
        >
          <BarChart3Icon aria-hidden />
          {t('shares.stats')}
        </Link>
        {share.status !== 'revoked' ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            onClick={() => setConfirming(true)}
          >
            {t('shares.revoke')}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Button
          size="sm"
          variant="ghost"
          className="h-8 px-2 text-muted-foreground"
          onClick={() => void copyDeletionLink()}
        >
          <UserXIcon aria-hidden />
          {t('shares.copyDeletionLink')}
        </Button>
        <span className="text-xs text-muted-foreground">{t('shares.deletionLinkHint')}</span>
      </div>
      {message !== null ? (
        <p
          role="status"
          className={cn(
            'text-sm',
            message.kind === 'error' ? 'text-destructive' : 'text-emerald-700',
          )}
        >
          {message.text}
        </p>
      ) : null}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{t('shares.revokeTitle')}</DialogTitle>
            <DialogDescription>{t('shares.revokeBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void doRevoke()}
              disabled={revoke.isPending}
            >
              {t('shares.revoke')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
