'use client';

import {
  type CreateShareBody,
  DOWNLOAD_SIZES,
  type DownloadSize,
  type OwnerShare,
  SHARE_MODES,
  SHARE_PASSWORD_MAX_LENGTH,
  SHARE_PASSWORD_MIN_LENGTH,
  type ShareMode,
  type ShareTargetType,
  sharePasswordSchema,
  type UpdateShareBody,
} from '@shotx/shared';
import { Alert, Button, Checkbox, Input, Label } from '@shotx/ui';
import { useTranslations } from 'next-intl';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useStudio } from '@/components/studio/studio-context';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { DesignPicker } from './design-picker';

/** Thailand has no DST: end of a Bangkok day is always 23:59:59.999 at +07:00. */
export function endOfBangkokDay(date: string): string {
  return new Date(`${date}T23:59:59.999+07:00`).toISOString();
}

/** The Bangkok calendar day (`YYYY-MM-DD`) of an instant. */
export function bangkokDate(iso: string): string {
  return new Date(Date.parse(iso) + 7 * 3_600_000).toISOString().slice(0, 10);
}

type Settings = Required<Omit<CreateShareBody, 'target'>>;

export type ShareFormProps =
  | {
      kind: 'create';
      targetType: ShareTargetType;
      faceSearchEnabled: boolean;
      onSubmit: (settings: Settings) => Promise<unknown>;
    }
  | {
      kind: 'edit';
      share: OwnerShare;
      faceSearchEnabled: boolean;
      onSubmit: (changes: UpdateShareBody) => Promise<unknown>;
    };

function Row({ children }: { children: ReactNode }) {
  return <div className="flex items-start gap-3">{children}</div>;
}

/**
 * Share settings: mode (face_only only for folders and only while face search is enabled),
 * downloads and their size, login, password, expiry and the share page design (ADR 0013). Validates with the shared schemas.
 * "Require login" needs a viewer sign-in (studio config viewerLoginAvailable): without one the
 * toggle is hidden with a note, except on an existing require_login share, which can still turn
 * it off (but not back on). An edit sends `requireLogin` only when it changed, so such a share
 * stays editable (the API refuses `requireLogin: true` with LOGIN_PROVIDER_UNAVAILABLE).
 */
export function ShareForm(props: ShareFormProps) {
  const t = useTranslations('shareForm');
  const describe = useErrorMessage();
  const loginAvailable = useStudio().config.viewerLoginAvailable;
  const id = useId();
  const existing = props.kind === 'edit' ? props.share : null;
  const targetType = existing?.target.type ?? (props.kind === 'create' ? props.targetType : 'file');

  const [mode, setMode] = useState<ShareMode>(existing?.mode ?? 'gallery');
  const [allowDownload, setAllowDownload] = useState(existing?.allowDownload ?? true);
  const [downloadSize, setDownloadSize] = useState<DownloadSize>(existing?.downloadSize ?? 'web');
  const [requireLogin, setRequireLogin] = useState(existing?.requireLogin ?? false);
  const [usePassword, setUsePassword] = useState(existing?.passwordProtected ?? false);
  const [password, setPassword] = useState('');
  const [useExpiry, setUseExpiry] = useState(existing?.expiresAt != null);
  const [expiry, setExpiry] = useState(existing?.expiresAt ? bangkokDate(existing.expiresAt) : '');
  const [designId, setDesignId] = useState<string | null>(existing?.designId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // face_only needs a folder and the feature; an existing face_only share keeps showing its mode.
  const modes = SHARE_MODES.filter(
    (m) =>
      m === 'gallery' ||
      (targetType === 'folder' && (props.faceSearchEnabled || existing?.mode === 'face_only')),
  );

  function passwordValue(): { ok: true; value: string | null | undefined } | { ok: false } {
    if (!usePassword) return { ok: true, value: existing?.passwordProtected ? null : undefined };
    if (password === '' && existing?.passwordProtected) return { ok: true, value: undefined };
    return sharePasswordSchema.safeParse(password).success
      ? { ok: true, value: password }
      : { ok: false };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const pw = passwordValue();
    if (!pw.ok) {
      setError(
        t('passwordInvalid', { min: SHARE_PASSWORD_MIN_LENGTH, max: SHARE_PASSWORD_MAX_LENGTH }),
      );
      return;
    }
    let expiresAt: string | null = null;
    if (useExpiry) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(expiry) ||
        Date.parse(endOfBangkokDay(expiry)) <= Date.now()
      ) {
        setError(t('expiryInvalid'));
        return;
      }
      expiresAt = endOfBangkokDay(expiry);
    }
    setError(null);
    setBusy(true);
    try {
      if (props.kind === 'create') {
        await props.onSubmit({
          mode,
          allowDownload,
          downloadSize,
          requireLogin: loginAvailable && requireLogin,
          password: pw.value ?? null,
          expiresAt,
          designId,
        });
      } else {
        await props.onSubmit({
          mode,
          allowDownload,
          downloadSize,
          ...(requireLogin !== props.share.requireLogin ? { requireLogin } : {}),
          expiresAt,
          ...(designId !== props.share.designId ? { designId } : {}),
          ...(pw.value !== undefined ? { password: pw.value } : {}),
        });
      }
      setPassword('');
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-4" noValidate>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{t('mode')}</legend>
        {modes.map((m) => (
          <label key={m} className="flex items-start gap-2 rounded-lg border p-3 text-sm">
            <input
              type="radio"
              name={`${id}-mode`}
              value={m}
              checked={mode === m}
              onChange={() => setMode(m)}
              className="mt-0.5 size-4"
            />
            {t(`modes.${m}`)}
          </label>
        ))}
        {targetType === 'file' && props.faceSearchEnabled ? (
          <p className="text-xs text-muted-foreground">{t('faceOnlyFolderOnly')}</p>
        ) : null}
      </fieldset>

      <Row>
        <Checkbox
          id={`${id}-download`}
          checked={allowDownload}
          onCheckedChange={(v) => setAllowDownload(v === true)}
        />
        <Label htmlFor={`${id}-download`}>{t('allowDownload')}</Label>
      </Row>
      {allowDownload ? (
        <div className="grid gap-2 pl-7">
          <Label htmlFor={`${id}-size`}>{t('downloadSize')}</Label>
          <select
            id={`${id}-size`}
            value={downloadSize}
            onChange={(e) => setDownloadSize(e.target.value as DownloadSize)}
            className="h-10 rounded-md border bg-background px-3 text-sm"
          >
            {DOWNLOAD_SIZES.map((size) => (
              <option key={size} value={size}>
                {t(`downloadSizes.${size}`)}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {loginAvailable || existing?.requireLogin === true ? (
        <Row>
          <Checkbox
            id={`${id}-login`}
            checked={requireLogin}
            // Without a viewer sign-in it can only be turned off.
            disabled={!loginAvailable && !requireLogin}
            onCheckedChange={(v) => setRequireLogin(v === true)}
          />
          <div className="grid gap-0.5">
            <Label htmlFor={`${id}-login`}>{t('requireLogin')}</Label>
            <span className="text-xs text-muted-foreground">
              {loginAvailable ? t('requireLoginHint') : t('requireLoginTurnOffOnly')}
            </span>
          </div>
        </Row>
      ) : (
        <p className="text-xs text-muted-foreground">{t('requireLoginUnavailable')}</p>
      )}

      <Row>
        <Checkbox
          id={`${id}-use-password`}
          checked={usePassword}
          onCheckedChange={(v) => setUsePassword(v === true)}
        />
        <Label htmlFor={`${id}-use-password`}>{t('usePassword')}</Label>
      </Row>
      {usePassword ? (
        <div className="grid gap-2 pl-7">
          <Label htmlFor={`${id}-password`}>{t('password')}</Label>
          <Input
            id={`${id}-password`}
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
            placeholder={existing?.passwordProtected ? t('keepPassword') : undefined}
          />
          <span className="text-xs text-muted-foreground">
            {t('passwordHint', { min: SHARE_PASSWORD_MIN_LENGTH })}
          </span>
        </div>
      ) : null}

      <Row>
        <Checkbox
          id={`${id}-use-expiry`}
          checked={useExpiry}
          onCheckedChange={(v) => setUseExpiry(v === true)}
        />
        <Label htmlFor={`${id}-use-expiry`}>{t('useExpiry')}</Label>
      </Row>
      {useExpiry ? (
        <div className="grid gap-2 pl-7">
          <Label htmlFor={`${id}-expiry`}>{t('expiry')}</Label>
          <Input
            id={`${id}-expiry`}
            type="date"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
          />
        </div>
      ) : null}

      <DesignPicker value={designId} onChange={setDesignId} preselectDefault={existing === null} />

      {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      <Button type="submit" disabled={busy}>
        {props.kind === 'create' ? t('create') : t('save')}
      </Button>
    </form>
  );
}
