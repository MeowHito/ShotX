/**
 * The parts of the File System Access API that folder sync uses (ADR 0014). Chrome and Edge on
 * computers have `showDirectoryPicker`; Safari, Firefox and phones don't, and the studio says so.
 * The DOM lib doesn't type the permission methods or the picker yet, so they are declared here.
 */

export type SyncPermissionState = 'granted' | 'denied' | 'prompt';

export interface SyncFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}

export interface SyncDirectoryHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<SyncFileHandle | SyncDirectoryHandle>;
  queryPermission?(descriptor: { mode: 'read' }): Promise<SyncPermissionState>;
  requestPermission?(descriptor: { mode: 'read' }): Promise<SyncPermissionState>;
}

interface PickerWindow {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: string;
  }) => Promise<SyncDirectoryHandle>;
}

/** Whether this browser can watch a folder on the computer (secure context + the picker). */
export function folderSyncSupported(win: unknown = globalThis): boolean {
  const w = win as PickerWindow & { isSecureContext?: boolean; indexedDB?: unknown };
  return (
    typeof w.showDirectoryPicker === 'function' &&
    w.isSecureContext !== false &&
    w.indexedDB !== undefined
  );
}

/**
 * Opens the folder picker (must run inside a click). Null when the person closes it. The `id`
 * makes the picker open where it was last time (the export folder).
 */
export async function pickSyncFolder(
  win: unknown = globalThis,
): Promise<SyncDirectoryHandle | null> {
  const picker = (win as PickerWindow).showDirectoryPicker;
  if (picker === undefined) return null;
  try {
    return await picker.call(win, { id: 'snap-folder-sync', mode: 'read', startIn: 'pictures' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
}

/** The read permission now; browsers without the query method keep it for the page's life. */
export async function readPermission(handle: SyncDirectoryHandle): Promise<SyncPermissionState> {
  if (handle.queryPermission === undefined) return 'granted';
  return handle.queryPermission({ mode: 'read' });
}

/** Asks again after a reload (must run inside a click). */
export async function requestReadPermission(
  handle: SyncDirectoryHandle,
): Promise<SyncPermissionState> {
  if (handle.requestPermission === undefined) return 'granted';
  return handle.requestPermission({ mode: 'read' });
}
