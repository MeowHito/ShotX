import 'server-only';
import {
  ANON_ID_COOKIE,
  ErrorCode,
  isShareToken,
  isValidAnonId,
  PUBLIC_SHARE_ROUTES,
  shareExpiredDetailsSchema,
  type ShareMetaResponse,
  type ShareUnavailableReason,
} from '@shotx/shared';
import { createApiClient } from '../api/client';
import { isApiError } from '../api/errors';

export type ServerShareMeta =
  | { kind: 'ok'; meta: ShareMetaResponse }
  | { kind: 'not_found' }
  | { kind: 'expired'; reason: ShareUnavailableReason | null }
  /** The API failed or answered something unexpected: render, and let the client retry. */
  | { kind: 'error' };

/**
 * Share meta for SSR and OG tags, from the API's internal URL. Sent without the viewer's /api
 * cookies (they are scoped to /api and never reach this page) except the anon id, so the view
 * counts as the same visitor; access flags in the answer are therefore those of a fresh visitor
 * and the client fetches its own. No bearer token: link unfurlers and viewers see the same meta.
 */
export async function fetchShareMeta(
  token: string,
  options: { apiInternalUrl: string; anonId?: string; fetch?: typeof fetch },
): Promise<ServerShareMeta> {
  if (!isShareToken(token)) return { kind: 'not_found' };
  const headers: Record<string, string> = {};
  if (options.anonId !== undefined && isValidAnonId(options.anonId)) {
    headers.cookie = `${ANON_ID_COOKIE}=${options.anonId}`;
  }
  const api = createApiClient({
    baseUrl: `${options.apiInternalUrl.replace(/\/+$/, '')}/api`,
    fetch: options.fetch,
    headers,
  });
  try {
    const meta = await api.call(PUBLIC_SHARE_ROUTES.meta, { params: { token } });
    return { kind: 'ok', meta };
  } catch (error) {
    if (isApiError(error, ErrorCode.NOT_FOUND)) return { kind: 'not_found' };
    if (isApiError(error, ErrorCode.SHARE_EXPIRED)) {
      const details = shareExpiredDetailsSchema.safeParse(error.details);
      return { kind: 'expired', reason: details.success ? details.data.reason : null };
    }
    return { kind: 'error' };
  }
}

/** OG/Twitter metadata of a share: the cover preview only in gallery mode, never in face_only. */
export function shareOpenGraph(meta: ShareMetaResponse | null, fallbackTitle: string) {
  const title = meta?.details?.title ?? fallbackTitle;
  const cover = meta?.mode === 'gallery' ? (meta.details?.cover ?? null) : null;
  return {
    title,
    images:
      cover === null
        ? []
        : [
            {
              url: cover.previewUrl,
              ...(cover.width !== null ? { width: cover.width } : {}),
              ...(cover.height !== null ? { height: cover.height } : {}),
            },
          ],
  };
}
