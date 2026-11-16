import { ANON_ID_COOKIE, SHARE_PAGE_ROBOTS } from '@shotx/shared';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { cache } from 'react';
import { ShareUnavailable } from '@/components/share/share-gates';
import { SharePage } from '@/components/share/share-view';
import { PublicTopBar } from '@/components/site/public-top-bar';
import { requestServerCallContext, viewerLoginOptions, viewerState } from '@/lib/server/auth';
import { shareRefFromPath } from '@/lib/share/ref';
import { clientFaceConfig, clientShareConfig, webConfig } from '@/lib/server/config';
import { fetchShareMeta, shareOpenGraph } from '@/lib/server/share';

type Params = Promise<{ ref: string }>;

/** One API call per request, shared by generateMetadata and the page. */
const loadMeta = cache(async (ref: string) => {
  const store = await cookies();
  return fetchShareMeta(ref, {
    apiInternalUrl: webConfig().apiInternalUrl,
    anonId: store.get(ANON_ID_COOKIE)?.value,
    context: await requestServerCallContext(),
  });
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { ref } = await params;
  const t = await getTranslations();
  const result = await loadMeta(ref);
  const meta = result.kind === 'ok' ? result.meta : null;
  const title =
    result.kind !== 'expired'
      ? t('metadata.title')
      : result.reason === 'plan_expired'
        ? t('share.unavailable.closedTitle')
        : t('share.unavailable.title');
  const og = shareOpenGraph(meta, title);
  // ADR 0011: the page no longer names the photographer; the unfurl shows the event only.
  const description = t('metadata.shareDescription');
  return {
    title: og.title,
    description,
    // Share links are private, and slugs are guessable (ADR 0011 risk 3): keep them out of
    // search engines (SHARE_PAGE_ROBOTS; unfurlers still read OG tags).
    robots: SHARE_PAGE_ROBOTS,
    // The canonical page is the slug URL, whatever ref was used to get here.
    ...(meta !== null ? { alternates: { canonical: meta.path } } : {}),
    openGraph: { type: 'website', title: og.title, description, images: og.images },
    twitter: {
      card: og.images.length > 0 ? 'summary_large_image' : 'summary',
      title: og.title,
      description,
      images: og.images.map((i) => i.url),
    },
  };
}

/**
 * `/{ref}`: a share page by slug (ADR 0011; at the site root since ADR 0015) or by a token
 * link. The ref is resolved once
 * (SSR here, then the browser's meta); every further public call uses `meta.token`.
 */
export default async function SharePageRoute({ params }: { params: Params }) {
  const raw = (await params).ref;
  const ref = shareRefFromPath(raw);
  if (ref === null) notFound();
  const result = await loadMeta(raw);
  if (result.kind === 'not_found') notFound();
  if (result.kind === 'expired') {
    return (
      <>
        <PublicTopBar />
        <main className="px-4">
          <ShareUnavailable reason={result.reason} />
        </main>
      </>
    );
  }
  const viewer = await viewerState();
  // Only a require_login share needs to know how viewers can sign in (one API call).
  const meta = result.kind === 'ok' ? result.meta : null;
  const viewerLogin =
    meta === null || meta.access.loginRequired ? await viewerLoginOptions() : undefined;
  return (
    <SharePage
      shareRef={ref}
      initialMeta={result.kind === 'ok' ? result.meta : null}
      signedIn={viewer.signedIn}
      viewerLogin={viewerLogin}
      faceConfig={clientFaceConfig()}
      shareConfig={clientShareConfig()}
    />
  );
}
