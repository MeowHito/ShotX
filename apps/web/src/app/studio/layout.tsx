import { redirect } from 'next/navigation';
import { type ReactNode, Suspense } from 'react';
import { SubscriptionBanner } from '@/components/billing/subscription-banner';
import { StudioGate } from '@/components/studio/studio-gate';
import { StudioShell } from '@/components/studio/studio-shell';
import { UploadPanel } from '@/components/upload/upload-panel';
import { UploadProvider } from '@/components/upload/upload-context';
import { AUTH_PATHS } from '@/lib/auth/handlers';
import { viewerState } from '@/lib/server/auth';
import { clientStudioConfig, clientUploadConfig } from '@/lib/server/config';

export default async function StudioLayout({ children }: { children: ReactNode }) {
  const viewer = await viewerState();
  if (!viewer.signedIn) redirect(`${AUTH_PATHS.loginPage}?next=/studio`);
  const user = viewer.user === null ? null : { name: viewer.user.name, email: viewer.user.email };

  return (
    // GET /me first: viewers who aren't photographers yet get the onboarding screen.
    <StudioGate>
      <UploadProvider config={clientUploadConfig()}>
        {/* useSearchParams (the search field) needs a Suspense boundary. */}
        <Suspense>
          <StudioShell user={user} banner={<SubscriptionBanner />} config={clientStudioConfig()}>
            {children}
          </StudioShell>
        </Suspense>
        <UploadPanel />
      </UploadProvider>
    </StudioGate>
  );
}
