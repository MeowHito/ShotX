import { ANON_ID_COOKIE } from '@shotx/shared';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { cache } from 'react';
import { ShareUnavailable } from '@/components/share/share-gates';
import { SharePage } from '@/components/share/share-view';
import { viewerState } from '@/lib/server/auth';
import { clientFaceConfig, clientShareConfig, webConfig } from '@/lib/server/config';
import { fetchShareMeta, shareOpenGraph } from '@/lib/server/share';

type Params = Promise<{ token: string }>;

/** One API call per request, shared by generateMetadata and the page. */
const loadMeta = cache(async (token: string) => {
  const store = await cookies();
  return fetchShareMeta(token, {
    apiInternalUrl: webConfig().apiInternalUrl,
    anonId: store.get(ANON_ID_COOKIE)?.value,
  });
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { token } = await params;
  const t = await getTranslations();
  const result = await loadMeta(token);
  const meta = result.kind === 'ok' ? result.meta : null;
  const title = result.kind === 'expired' ? t('share.unavailable.title') : t('metadata.title');
  const og = shareOpenGraph(meta, title);
  const photographer = meta?.details?.photographerName ?? null;
  const description =
    photographer !== null
      ? t('share.byPhotographer', { name: photographer })
      : t('metadata.description');
  return {
    title: og.title,
    description,
    // Share links are private: keep them out of search engines (unfurlers still read OG tags).
    robots: { index: false, follow: false },
    openGraph: { type: 'website', title: og.title, description, images: og.images },
    twitter: {
      card: og.images.length > 0 ? 'summary_large_image' : 'summary',
      title: og.title,
      description,
      images: og.images.map((i) => i.url),
    },
  };
}

export default async function ShareTokenPage({ params }: { params: Params }) {
  const { token } = await params;
  const result = await loadMeta(token);
  if (result.kind === 'not_found') notFound();
  if (result.kind === 'expired') {
    return (
      <main className="px-4">
        <ShareUnavailable reason={result.reason} />
      </main>
    );
  }
  const viewer = await viewerState();
  return (
    <SharePage
      token={token}
      initialMeta={result.kind === 'ok' ? result.meta : null}
      signedIn={viewer.signedIn}
      faceConfig={clientFaceConfig()}
      shareConfig={clientShareConfig()}
    />
  );
}
