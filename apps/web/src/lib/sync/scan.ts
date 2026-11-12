import { fileExtension, UPLOAD_FILE_TYPES } from '@shotx/shared';
import type { SyncDirectoryHandle, SyncFileHandle } from './fs-access';

/**
 * One pass over the watched folder (ADR 0014): every photo or video with an allowlisted
 * extension, with its size and modification time. Hidden files (`.DS_Store`, Lightroom's
 * temporary files) and other types (XMP sidecars, TIFF, RAW) are left out; other types are
 * counted so the studio can say they were skipped.
 */

export interface ScannedFile {
  /** `Day 1/IMG_0001.jpg`: the path under the watched folder, the ledger key. */
  path: string;
  name: string;
  /** Folders between the watched folder and the file (`relativePath` of upload init), or null. */
  relativePath: string | null;
  size: number;
  lastModified: number;
  handle: SyncFileHandle;
}

export interface ScanResult {
  files: ScannedFile[];
  /** Files of a type the drive doesn't take, left out. */
  ignored: number;
}

const ALLOWED_EXTENSIONS = new Set<string>(UPLOAD_FILE_TYPES.flatMap((t) => t.extensions));

export function isSyncableName(name: string): boolean {
  if (name.startsWith('.')) return false;
  const ext = fileExtension(name);
  return ext !== null && ALLOWED_EXTENSIONS.has(ext);
}

/** `size:lastModified`: a file whose signature changed was written again. */
export function fileSignature(file: { size: number; lastModified: number }): string {
  return `${file.size}:${file.lastModified}`;
}

export async function scanFolder(
  root: SyncDirectoryHandle,
  options: { includeSubfolders: boolean; maxDepth: number },
): Promise<ScanResult> {
  const files: ScannedFile[] = [];
  let ignored = 0;

  async function walk(dir: SyncDirectoryHandle, parents: string[]): Promise<void> {
    for await (const entry of dir.values()) {
      if (entry.name.startsWith('.')) continue;
      if (entry.kind === 'directory') {
        if (options.includeSubfolders && parents.length < options.maxDepth) {
          await walk(entry, [...parents, entry.name]);
        }
        continue;
      }
      if (!isSyncableName(entry.name)) {
        ignored += 1;
        continue;
      }
      let file: File;
      try {
        file = await entry.getFile();
      } catch {
        // Removed or still locked by the exporting app between listing and reading: next pass.
        continue;
      }
      files.push({
        path: [...parents, entry.name].join('/'),
        name: entry.name,
        relativePath: parents.length > 0 ? parents.join('/') : null,
        size: file.size,
        lastModified: file.lastModified,
        handle: entry,
      });
    }
  }

  await walk(root, []);
  return { files, ignored };
}
