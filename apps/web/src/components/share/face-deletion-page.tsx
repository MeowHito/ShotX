'use client';

import { shareRefPath } from '@shotx/shared';
import { Alert, Button } from '@shotx/ui';
import { useTranslations } from 'next-intl';
import { PublicTopBar } from '@/components/site/public-top-bar';
import type { ApiClient } from '@/lib/api/client';
import type { ClientFaceConfig } from '@/lib/face/config';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useFaceDeletionInfo } from '@/lib/share/queries';
import { ShareApiProvider } from '@/lib/share/share-api';
import { type FaceTools, FaceToolsProvider } from './scan/face-tools';
import { ScanFlow } from './scan/scan-flow';

export interface FaceDeletionPageProps {
  token: string;
  signedIn: boolean;
  faceConfig: ClientFaceConfig;
  /** Tests: the fake API, canvas and camera, and navigation. */
  testing?: {
    publicApi?: ApiClient;
    faceTools?: Partial<Omit<FaceTools, 'config'>>;
    onClose?: () => void;
  };
}

/**
 * `/s/[ref]/delete-my-face`: "delete my face" (unlinked, ADR 0011). Reads `GET /s/:ref/face-deletion`, which
 * checks the token only, so it works when the share is expired or revoked, behind a password or
 * sign-in, and when face search is switched off (PDPA; ADR 0007). Asks for the `face_deletion`
 * consent, then takes selfies (camera only: no gallery pick, so nobody deletes another person's
 * faces from a saved photo by accident) and posts them to `POST /s/:token/face-deletion`.
 */
export function FaceDeletionPage({ testing, ...props }: FaceDeletionPageProps) {
  return (
    <ShareApiProvider signedIn={props.signedIn} publicApi={testing?.publicApi}>
      <FaceToolsProvider config={props.faceConfig} overrides={testing?.faceTools}>
        <PublicTopBar />
        <main className="mx-auto max-w-xl px-3 py-6 sm:px-4">
          <FaceDeletion token={props.token} onClose={testing?.onClose} />
        </main>
      </FaceToolsProvider>
    </ShareApiProvider>
  );
}

function FaceDeletion({ token, onClose }: { token: string; onClose?: () => void }) {
  const t = useTranslations();
  const describe = useErrorMessage();
  const info = useFaceDeletionInfo(token);
  const close = onClose ?? (() => window.location.assign(shareRefPath(token)));

  if (info.isPending) {
    return (
      <p className="py-10 text-center text-muted-foreground" role="status">
        {t('common.loading')}
      </p>
    );
  }
  if (info.isError) {
    return (
      <div className="space-y-3 py-10">
        <h1 className="text-xl font-bold">{t('faceDeletion.title')}</h1>
        <Alert variant="destructive" className="flex items-center justify-between gap-2">
          <span>
            {t('faceDeletion.loadError')}: {describe(info.error)}
          </span>
          <Button size="sm" variant="outline" onClick={() => void info.refetch()}>
            {t('common.retry')}
          </Button>
        </Alert>
      </div>
    );
  }
  return (
    <ScanFlow
      token={token}
      purpose="delete"
      consent={{
        policyVersion: info.data.policyVersion,
        consented: info.data.consented,
        resultTtlSeconds: null,
      }}
      limits={{
        maxSelfies: info.data.maxSelfies,
        selfie: {
          longEdge: info.data.selfieLongEdge,
          jpegQuality: info.data.selfieJpegQuality,
        },
      }}
      allowGallery={false}
      onClose={close}
    />
  );
}
