import { isShareToken } from '@shotx/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { FaceDeletionPage } from '@/components/share/face-deletion-page';
import { viewerState } from '@/lib/server/auth';
import { clientFaceConfig } from '@/lib/server/config';

type Params = Promise<{ token: string }>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('faceDeletion');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * "delete my face" of a share. Rendered for any well-formed token, without asking the share
 * meta (which answers SHARE_EXPIRED for expired shares): the client reads
 * `GET /s/:token/face-deletion`, which only checks that the token exists.
 */
export default async function DeleteMyFacePage({ params }: { params: Params }) {
  const { token } = await params;
  if (!isShareToken(token)) notFound();
  const viewer = await viewerState();
  return (
    <FaceDeletionPage token={token} signedIn={viewer.signedIn} faceConfig={clientFaceConfig()} />
  );
}
