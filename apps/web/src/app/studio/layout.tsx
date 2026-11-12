import { redirect } from 'next/navigation';
import { type ReactNode, Suspense } from 'react';
import { SubscriptionBanner } from '@/components/billing/subscription-banner';
import { StudioGate } from '@/components/studio/studio-gate';
import { StudioShell } from '@/components/studio/studio-shell';
import { UploadPanel } from '@/components/upload/upload-panel';
import { FolderSyncProvider } from '@/components/sync/folder-sync-context';
import { UploadProvider } from '@/components/upload/upload-context';
import { AUTH_PATHS } from '@/lib/auth/handlers';
import { viewerLoginIsAvailable, viewerState } from '@/lib/server/auth';
import {
  clientFolderSyncConfig,
  clientStudioConfig,
  clientUploadConfig,
} from '@/lib/server/config';

export default async function StudioLayout({ children }: { children: ReactNode }) {
  const viewer = await viewerState();
  if (!viewer.signedIn) redirect(`${AUTH_PATHS.loginPage}?next=/studio`);
  const user = viewer.user === null ? null : { name: viewer.user.name, email: viewer.user.email };
  const config = clientStudioConfig(process.env, await viewerLoginIsAvailable());

  return (
    // GET /me first: a temporary password goes to the password change, and accounts that aren't
    // photographers' are told to ask the admin (ADR 0010).
    <StudioGate>
      <UploadProvider config={clientUploadConfig()}>
        {/* Folder sync runs for the whole studio session, on every studio page (ADR 0014). */}
        <FolderSyncProvider config={clientFolderSyncConfig()}>
          {/* useSearchParams (the search field) needs a Suspense boundary. */}
          <Suspense>
            <StudioShell
              user={user}
              // Subscriptions only exist with online billing (BILLING_MODE=gateway).
              banner={config.billingMode === 'gateway' ? <SubscriptionBanner /> : undefined}
              config={config}
            >
              {children}
            </StudioShell>
          </Suspense>
        </FolderSyncProvider>
        <UploadPanel />
      </UploadProvider>
    </StudioGate>
  );
}
