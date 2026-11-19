import { BILLING_PAGE_PATH } from '@shotx/shared';

/** Studio URL of a folder; null is the drive root. */
export function folderHref(folderId: string | null): string {
  return folderId === null ? '/studio' : `/studio/folders/${folderId}`;
}

export const TRASH_HREF = '/studio/trash';

export const RECENT_HREF = '/studio/recent';

export const SHARES_HREF = '/studio/shares';

/** Share page designs (ADR 0013). */
export const DESIGNS_HREF = '/studio/designs';

export function designHref(designId: string): string {
  return `${DESIGNS_HREF}/${designId}`;
}

/** Folder sync from the computer (ADR 0014). */
export const SYNC_HREF = '/studio/sync';

/** Print orders from share viewers (ADR 0031). */
export const PRINT_HREF = '/studio/print';

/** Account settings: name, email and the password change (ADR 0010). */
export const SETTINGS_HREF = '/studio/settings';

/** The studio billing page (shared BILLING_PAGE_PATH; emails link to it too). */
export const BILLING_HREF = BILLING_PAGE_PATH;

export function shareHref(shareId: string): string {
  return `${SHARES_HREF}/${shareId}`;
}
