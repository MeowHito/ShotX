'use client';

import { ErrorCode, ME_ROUTES } from '@shotx/shared';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { useApiClient } from '@/components/providers';
import { type ApiClient, createPublicApiClient } from '../api/client';
import { isApiError } from '../api/errors';

/**
 * API access of the share page:
 * - `api`: the public routes at `/api/...`, called directly with credentials (anon, viewer-session
 *   and unlock cookies), never through the BFF;
 * - `ensureViewerSession`: for a signed-in visitor, `POST /bff/me/viewer-session`, whose
 *   Set-Cookie (`shotx_vs`, Path=/api) the BFF forwards, so the public routes know who they are.
 *
 * A stale viewer-session cookie makes public routes answer UNAUTHENTICATED; the client then
 * renews it (signed in) or drops it (signed out) and retries once.
 */
export interface ShareApi {
  api: ApiClient;
  signedIn: boolean;
  ensureViewerSession: () => Promise<boolean>;
}

const ShareApiContext = createContext<ShareApi | null>(null);

export function useShareApi(): ShareApi {
  const value = useContext(ShareApiContext);
  if (value === null) throw new Error('useShareApi outside <ShareApiProvider>');
  return value;
}

export function createShareApi(options: {
  publicApi: ApiClient;
  bffApi: ApiClient;
  signedIn: boolean;
}): ShareApi {
  const { publicApi, bffApi, signedIn } = options;

  async function ensureViewerSession(): Promise<boolean> {
    if (!signedIn) return false;
    try {
      await bffApi.call(ME_ROUTES.createViewerSession);
      return true;
    } catch {
      return false;
    }
  }

  async function recover(): Promise<void> {
    if (await ensureViewerSession()) return;
    // Not signed in (or the session is gone): drop the stale cookie and continue anonymously.
    await publicApi.call(ME_ROUTES.deleteViewerSession).catch(() => undefined);
  }

  const api: ApiClient = {
    async call(route, ...args) {
      try {
        return await publicApi.call(route, ...args);
      } catch (error) {
        if (!isApiError(error, ErrorCode.UNAUTHENTICATED) || route.auth !== 'public') throw error;
        await recover();
        return publicApi.call(route, ...args);
      }
    },
  };
  return { api, signedIn, ensureViewerSession };
}

export function ShareApiProvider({
  children,
  signedIn,
  publicApi,
}: {
  children: ReactNode;
  signedIn: boolean;
  /** Tests inject the fake API; the browser uses `/api` with credentials. */
  publicApi?: ApiClient;
}) {
  const bffApi = useApiClient();
  const [value] = useState(() =>
    createShareApi({ publicApi: publicApi ?? createPublicApiClient(), bffApi, signedIn }),
  );
  return <ShareApiContext.Provider value={value}>{children}</ShareApiContext.Provider>;
}
