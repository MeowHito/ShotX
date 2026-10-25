/** Studio URL of a folder; null is the drive root. */
export function folderHref(folderId: string | null): string {
  return folderId === null ? '/studio' : `/studio/folders/${folderId}`;
}

export const TRASH_HREF = '/studio/trash';
