'use client';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@shotx/ui';
import { SUPPORTED_LOCALES } from '@shotx/shared';
import { CheckIcon, KeyboardIcon, LanguagesIcon, LogOutIcon, SettingsIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { SETTINGS_HREF } from '@/components/drive/paths';
import { useChooseLocale } from '@/components/site/language-switcher';
import { AUTH_PATHS } from '@/lib/auth/handlers';
import type { ApiClient } from '@/lib/api/client';
import { shortcutHint } from '@/lib/studio/shortcuts';
import { useLogout } from './logout-button';
import { useStudio } from './studio-context';

export interface StudioUser {
  name: string | null;
  email: string | null;
}

/** The account button (initial) with the name, email, account settings, shortcuts help and logout. */
export function AccountMenu({
  user,
  publicApi,
  onSubmitLogout,
}: {
  user: StudioUser | null;
  /** Tests inject the fake API and observe the logout form. */
  publicApi?: ApiClient;
  onSubmitLogout?: (form: HTMLFormElement) => void;
}) {
  const t = useTranslations('studio');
  const tn = useTranslations('publicNav');
  const language = useChooseLocale();
  const studio = useStudio();
  const { formRef, busy, logout } = useLogout({ publicApi, onSubmitForm: onSubmitLogout });
  const display = user?.name ?? user?.email ?? null;
  const initial = (display ?? '?').trim().charAt(0).toUpperCase() || '?';

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('accountMenu')}
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/12 text-base font-semibold text-primary outline-none hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span aria-hidden>{initial}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" collisionPadding={12} className="min-w-64">
          <DropdownMenuLabel className="space-y-0.5 py-2">
            <span className="block text-xs">{t('account')}</span>
            {user?.name ? (
              <span className="block truncate text-sm font-semibold text-foreground">
                {user.name}
              </span>
            ) : null}
            {user?.email ? (
              <span className="block truncate text-xs font-normal">{user.email}</span>
            ) : null}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href={SETTINGS_HREF}>
              <SettingsIcon aria-hidden />
              {t('settings')}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={studio.showShortcuts}>
            <KeyboardIcon aria-hidden />
            {t('shortcuts')}
            <DropdownMenuShortcut>{shortcutHint('help', studio.apple)}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="flex items-center gap-2 text-xs">
            <LanguagesIcon className="size-3.5" aria-hidden />
            {tn('language')}
          </DropdownMenuLabel>
          {SUPPORTED_LOCALES.map((locale) => (
            <DropdownMenuItem
              key={locale}
              lang={locale}
              aria-current={locale === language.current ? 'true' : undefined}
              onSelect={() => language.choose(locale)}
            >
              <CheckIcon
                className={locale === language.current ? 'opacity-100' : 'opacity-0'}
                aria-hidden
              />
              {tn(`locales.${locale}`)}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={busy} onSelect={() => void logout()}>
            <LogOutIcon aria-hidden />
            {t('logout')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <form ref={formRef} action={AUTH_PATHS.logout} method="post" hidden />
    </>
  );
}
