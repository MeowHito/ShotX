/**
 * Files from drag-and-drop or a folder picker, with the folder part of their relative path
 * (`Event/Day 1` for `Event/Day 1/IMG_0001.jpg`), sent as `relativePath` to `POST /uploads/init`.
 */

export interface PickedFile {
  file: File;
  /** Folders between the drop target and the file, `/`-separated; null for loose files. */
  relativePath: string | null;
  /**
   * The idempotency key of upload init to use (a new one when omitted). Folder sync passes the
   * key it saved, so an upload cut off by a reload is resumed rather than started again.
   */
  clientUploadId?: string;
}

/** The folder part of a `webkitRelativePath` (folder picker): `a/b/c.jpg` → `a/b`. */
export function relativeDir(path: string): string | null {
  const parts = path.split('/').filter((p) => p !== '');
  parts.pop();
  return parts.length > 0 ? parts.join('/') : null;
}

/** Files of an `<input type="file">` (with or without `webkitdirectory`). */
export function filesFromInput(files: FileList | readonly File[]): PickedFile[] {
  return Array.from(files, (file) => ({
    file,
    relativePath: relativeDir(file.webkitRelativePath || ''),
  }));
}

// Minimal FileSystem entry types (the DOM lib's are incomplete across browsers).
interface EntryBase {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}
interface FileEntry extends EntryBase {
  file(success: (file: File) => void, failure?: (error: unknown) => void): void;
}
interface DirectoryEntry extends EntryBase {
  createReader(): {
    readEntries(success: (entries: EntryBase[]) => void, failure?: (error: unknown) => void): void;
  };
}

function readFile(entry: FileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** All entries of a directory: readEntries returns at most ~100 per call, so read until empty. */
async function readAll(entry: DirectoryEntry): Promise<EntryBase[]> {
  const reader = entry.createReader();
  const all: EntryBase[] = [];
  for (;;) {
    const batch = await new Promise<EntryBase[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

async function walk(entry: EntryBase, dir: string[], out: PickedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await readFile(entry as FileEntry);
    out.push({ file, relativePath: dir.length > 0 ? dir.join('/') : null });
  } else if (entry.isDirectory) {
    for (const child of await readAll(entry as DirectoryEntry)) {
      await walk(child, [...dir, entry.name], out);
    }
  }
}

/** Every file in a drop, walking dropped folders recursively. Hidden files (`.DS_Store`) are skipped. */
export async function filesFromDataTransfer(dataTransfer: DataTransfer): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  // Entries must be taken synchronously, before the first await, or the list is emptied.
  const entries: EntryBase[] = [];
  const loose: File[] = [];
  for (const item of Array.from(dataTransfer.items ?? [])) {
    if (item.kind !== 'file') continue;
    const entry = (item.webkitGetAsEntry?.() ?? null) as EntryBase | null;
    if (entry !== null) entries.push(entry);
    else {
      const file = item.getAsFile();
      if (file !== null) loose.push(file);
    }
  }
  if (entries.length === 0 && loose.length === 0) {
    loose.push(...Array.from(dataTransfer.files ?? []));
  }
  for (const entry of entries) await walk(entry, [], out);
  for (const file of loose) out.push({ file, relativePath: null });
  return out.filter((picked) => !picked.file.name.startsWith('.'));
}
