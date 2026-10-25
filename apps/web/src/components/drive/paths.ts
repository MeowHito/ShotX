import { BILLING_PAGE_PATH } from '@shotx/shared';

/** Studio URL of a folder; null is the drive root. */
export function folderHref(folderId: string | null): string {
  return folderId === null ? '/studio' : `/studio/folders/${folderId}`;
}

export const TRASH_HREF = '/studio/trash';

export const SHARES_HREF = '/studio/shares';

/** The studio billing page (shared BILLING_PAGE_PATH; emails link to it too). */
export const BILLING_HREF = BILLING_PAGE_PATH;

export function shareHref(shareId: string): string {
  return `${SHARES_HREF}/${shareId}`;
}
