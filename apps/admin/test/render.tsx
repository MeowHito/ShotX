import type { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement, ReactNode } from 'react';
import { vi } from 'vitest';
import type { AdminMfaMode } from '@shotx/shared';
import { AdminSettingsProvider } from '@/components/admin-settings';
import { createQueryClient, Providers } from '@/components/providers';
import { DEFAULT_LOCALE, type Locale, MESSAGES, TIME_ZONE } from '@/i18n/config';
import { createApiClient } from '@/lib/api/client';
import type { PasswordUiConfig } from '@/lib/users/password';

/** Password settings of the tests: different minimums per pool, as configured by default. */
export const TEST_PASSWORDS: PasswordUiConfig = {
  generatedLength: 20,
  minLength: { admin: 14, photographer: 10 },
};

/**
 * Renders `ui` with i18n (Thai unless `locale` says otherwise), TanStack Query and an API client
 * on `fetchImpl` (base `/bff`).
 */
export function renderWithProviders(
  ui: ReactElement,
  options: {
    fetch: typeof fetch;
    onSessionEnded?: () => void;
    mfaMode?: AdminMfaMode | null;
    locale?: Locale;
  },
) {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const onSessionEnded = options.onSessionEnded ?? vi.fn();
  // The app's client (with the session-ended handlers), without retries.
  const queryClient: QueryClient = createQueryClient(onSessionEnded);
  queryClient.setDefaultOptions({ queries: { retry: false }, mutations: { retry: false } });
  const api = createApiClient({ baseUrl: '/bff', fetch: options.fetch });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone={TIME_ZONE}>
        <Providers apiClient={api} queryClient={queryClient} onSessionEnded={onSessionEnded}>
          <AdminSettingsProvider mfaMode={options.mfaMode ?? 'off'}>
            {children}
          </AdminSettingsProvider>
        </Providers>
      </NextIntlClientProvider>
    );
  }
  return { ...render(ui, { wrapper: Wrapper }), queryClient, onSessionEnded };
}
