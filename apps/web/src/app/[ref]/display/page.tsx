import { SHARE_PAGE_ROBOTS } from '@shotx/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { DisplayPage } from '@/components/share/display-view';
import { viewerLoginOptions, viewerState } from '@/lib/server/auth';
import { clientShareConfig } from '@/lib/server/config';
import { shareRefFromPath } from '@/lib/share/ref';

type Params = Promise<{ ref: string }>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('share.display');
  return { title: t('title'), robots: SHARE_PAGE_ROBOTS };
}

/**
 * ADR 0033: the event screen of a share, `/{ref}/display` (a monitor at the event: the newest
 * photos and the link's QR code). Client-rendered: it reads the meta and GET /s/:token/display
 * with this browser's cookies (a password share is unlocked on the screen once).
 */
export default async function DisplayRoute({ params }: { params: Params }) {
  const ref = shareRefFromPath((await params).ref);
  if (ref === null) notFound();
  const viewer = await viewerState();
  return (
    <DisplayPage
      shareRef={ref}
      signedIn={viewer.signedIn}
      viewerLogin={await viewerLoginOptions()}
      shareConfig={clientShareConfig()}
    />
  );
}
