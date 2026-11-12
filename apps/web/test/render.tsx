import { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement, ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { UploadProvider } from '@/components/upload/upload-context';
import { DEFAULT_LOCALE, type Locale, MESSAGES, TIME_ZONE } from '@/i18n/config';
import { type ApiClient, createApiClient } from '@/lib/api/client';
import type { ClientUploadConfig } from '@/lib/server/config';
import type { DriveUploaderOptions } from '@/lib/upload/uploader';

export const TEST_UPLOAD_CONFIG: ClientUploadConfig = {
  maxBytes: { image: 100 * 1024 * 1024, video: 5 * 1024 * 1024 * 1024 },
  partBytes: 16 * 1024 * 1024,
  partConcurrency: 4,
};

export function apiClientFor(fetchImpl: typeof fetch): ApiClient {
  return createApiClient({ baseUrl: '/bff', fetch: fetchImpl });
}

export function renderWithProviders(
  ui: ReactElement,
  options: {
    api: ApiClient;
    upload?: { config?: ClientUploadConfig; options?: Partial<DriveUploaderOptions> };
    /** UI language (ADR 0011); Thai by default. */
    locale?: Locale;
  },
) {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone={TIME_ZONE}>
        <Providers apiClient={options.api} queryClient={queryClient}>
          <UploadProvider
            config={options.upload?.config ?? TEST_UPLOAD_CONFIG}
            uploaderOptions={{ retryDelays: [], ...options.upload?.options }}
          >
            {children}
          </UploadProvider>
        </Providers>
      </NextIntlClientProvider>
    );
  }
  return { ...render(ui, { wrapper: Wrapper }), queryClient };
}
