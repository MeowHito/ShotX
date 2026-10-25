import { activityEvents } from '@shotx/db';
import {
  type ActivityEventInput,
  activityEventInputSchema,
  type Viewer,
  viewerColumns,
} from '@shotx/shared';
import type { z } from 'zod';
import type { Queryable } from '../db/db';

/**
 * Writes one `activity_events` row, validated with activityEventInputSchema (strict, counts only:
 * no face ids, boxes, scores or file names can slip in). Callers write the event before they
 * return the URLs it accounts for, so every issued view, download and zip URL is counted.
 */
export async function recordActivity(
  q: Queryable,
  input: z.input<typeof activityEventInputSchema>,
): Promise<void> {
  const event: ActivityEventInput = activityEventInputSchema.parse(input);
  await q.insert(activityEvents).values({
    type: event.type,
    source: event.source,
    shareId: event.shareId,
    fileId: event.fileId,
    photographerId: event.photographerId,
    viewerId: event.viewerId,
    anonId: event.anonId,
    bytes: event.bytes,
    meta: event.meta,
  });
}

/** The share-source columns of an event for a viewer of a share. */
export function shareEventSource(
  share: { id: string; ownerId: string },
  viewer: Viewer,
): { source: 'share'; shareId: string; photographerId: string } & ReturnType<typeof viewerColumns> {
  return {
    source: 'share',
    shareId: share.id,
    photographerId: share.ownerId,
    ...viewerColumns(viewer),
  };
}
