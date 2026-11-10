'use client';

import { Alert } from '@shotx/ui';
import { useTranslations } from 'next-intl';
import { type ReactNode, useMemo } from 'react';
import { groupSecret, parseOtpauthUri } from '@/lib/totp';
import { QrCode } from './qr-code';

/**
 * The `enrol_totp` step: the admin's own new TOTP secret as a QR code and as text, shown once
 * (the API returns it only in this sign-in's answer; the creating admin never sees it). It lives
 * only in this step's props: not in storage, the URL or logs, and it is gone when the step ends.
 */
export function TotpEnrolment({
  otpauthUri,
  children,
}: {
  otpauthUri: string;
  children: ReactNode;
}) {
  const t = useTranslations('login.enrol');
  const parts = useMemo(() => parseOtpauthUri(otpauthUri), [otpauthUri]);

  if (parts === null) return <Alert variant="destructive">{t('invalidUri')}</Alert>;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <Alert variant="warning">{t('once')}</Alert>
      <QrCode text={otpauthUri} label={t('qrLabel')} />
      <details className="rounded-xl border bg-sidebar px-4 py-3 text-sm">
        <summary className="cursor-pointer font-medium">{t('manual')}</summary>
        <dl className="mt-3 space-y-2">
          <div>
            <dt className="text-muted-foreground">{t('secret')}</dt>
            <dd className="font-mono text-base break-all select-all" data-testid="totp-secret">
              {groupSecret(parts.secret)}
            </dd>
          </div>
          {parts.account !== null ? (
            <div>
              <dt className="text-muted-foreground">{t('account')}</dt>
              <dd className="break-all">{parts.account}</dd>
            </div>
          ) : null}
          {parts.issuer !== null ? (
            <div>
              <dt className="text-muted-foreground">{t('issuer')}</dt>
              <dd>{parts.issuer}</dd>
            </div>
          ) : null}
          <dd className="text-muted-foreground">
            {t('timeBased', { digits: parts.digits, period: parts.periodSeconds })}
          </dd>
        </dl>
      </details>
      {children}
    </div>
  );
}
