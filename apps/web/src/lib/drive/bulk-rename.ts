import { driveNameKey, driveNameSchema, fileExtension } from '@shotx/shared';

/**
 * ADR 0023: renaming files from one name the photographer types. One file gets `base.ext`;
 * several get `base(1).ext`, `base(2).ext`, … in the order given (the studio passes them newest
 * first). Each file keeps its own extension, so its type never changes.
 */

export interface RenameTarget {
  id: string;
  name: string;
  folderId: string | null;
}

export interface PlannedRename {
  id: string;
  folderId: string | null;
  from: string;
  to: string;
}

/** The part of a file name before its extension (the whole name when it has none). */
export function nameStem(name: string): string {
  return fileExtension(name) === null ? name : name.slice(0, name.lastIndexOf('.'));
}

/** `.jpg` of `photo.jpg`, '' without an extension (as typed: case kept). */
function extensionOf(name: string): string {
  return fileExtension(name) === null ? '' : name.slice(name.lastIndexOf('.'));
}

/**
 * The new names, in the order of `files`; null when `base` (trimmed) makes an invalid drive
 * name for any of them (empty, a slash, too long, …).
 */
export function numberedNames(
  base: string,
  files: readonly RenameTarget[],
): PlannedRename[] | null {
  const stem = base.normalize('NFC').trim();
  if (stem === '') return null;
  const planned: PlannedRename[] = [];
  for (const [i, file] of files.entries()) {
    const suffix = files.length > 1 ? `(${i + 1})` : '';
    const parsed = driveNameSchema.safeParse(`${stem}${suffix}${extensionOf(file.name)}`);
    if (!parsed.success) return null;
    planned.push({ id: file.id, folderId: file.folderId, from: file.name, to: parsed.data });
  }
  return planned;
}

/** Sibling names collide by folder and driveNameKey. */
const slot = (folderId: string | null, name: string) => `${folderId ?? ''}/${driveNameKey(name)}`;

/**
 * The PATCHes to send, in order. Files already named right are skipped. A file whose current
 * name another file of the batch wants (renaming A(1), A(2) again in a new order, say) first
 * steps aside to a temporary name, so the batch never trips over itself.
 */
export function renameSteps(
  planned: readonly PlannedRename[],
  tempName: (rename: PlannedRename, n: number) => string = (r, n) =>
    `~${n}-${Date.now().toString(36)}${extensionOf(r.from)}`,
): { id: string; name: string; final: boolean }[] {
  const todo = planned.filter((r) => r.from !== r.to);
  const wanted = new Set(todo.map((r) => slot(r.folderId, r.to)));
  const steps: { id: string; name: string; final: boolean }[] = [];
  todo.forEach((r, n) => {
    if (wanted.has(slot(r.folderId, r.from)) && driveNameKey(r.from) !== driveNameKey(r.to)) {
      steps.push({ id: r.id, name: tempName(r, n), final: false });
    }
  });
  for (const r of todo) steps.push({ id: r.id, name: r.to, final: true });
  return steps;
}
