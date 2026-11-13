import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { FaceDeletionPage } from '@/components/share/face-deletion-page';
import { viewerState } from '@/lib/server/auth';
import { shareRefFromPath } from '@/lib/share/ref';
import { clientFaceConfig } from '@/lib/server/config';

type Params = Promise<{ ref: string }>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('faceDeletion');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * "delete my face" of a share, `/{ref}/delete-my-face`. ADR 0011 decision 2: linked from
 * nowhere (the company sends it to a person who asks), but it keeps working. Rendered for any
 * well-formed ref (slug or token), without asking the share meta (which answers SHARE_EXPIRED for
 * expired shares): the client reads `GET /s/:ref/face-deletion`, which only checks the ref.
 */
export default async function DeleteMyFacePage({ params }: { params: Params }) {
  const token = shareRefFromPath((await params).ref);
  if (token === null) notFound();
  const viewer = await viewerState();
  return (
    <FaceDeletionPage token={token} signedIn={viewer.signedIn} faceConfig={clientFaceConfig()} />
  );
}
