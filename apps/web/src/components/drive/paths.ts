/** Studio URL of a folder; null is the drive root. */
export function folderHref(folderId: string | null): string {
  return folderId === null ? '/studio' : `/studio/folders/${folderId}`;
}

export const TRASH_HREF = '/studio/trash';

export const SHARES_HREF = '/studio/shares';

export function shareHref(shareId: string): string {
  return `${SHARES_HREF}/${shareId}`;
}
