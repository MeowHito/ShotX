import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** tools/face-eval, wherever the CLI is started from. */
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Git-ignored: datasets, synthetic or real. */
export const DATA_DIR = resolve(PACKAGE_DIR, 'data');
/** Git-ignored: raw per-run output. */
export const RUNS_DIR = resolve(PACKAGE_DIR, 'runs');
/** Committed: aggregate reports only. */
export const REPORTS_DIR = resolve(PACKAGE_DIR, 'reports');
export const DEFAULT_SYNTHETIC_DIR = resolve(DATA_DIR, 'synthetic');

export type IgnoreStatus = 'ignored' | 'tracked-path' | 'outside-repo';

/**
 * Whether git would ignore files in the folder `dir`. Datasets and raw runs hold faces or data
 * derived from them, so inside a repository they must live under an ignored folder.
 */
export function gitIgnoreStatus(dir: string): IgnoreStatus {
  // Folder patterns such as `data/` only match paths git knows to be folders, and `dir` may not
  // exist yet, so ask about a file inside it.
  const absolute = join(resolve(dir), '.face-eval-probe');
  let cwd = absolute;
  while (!existsSync(cwd)) cwd = dirname(cwd);
  try {
    execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: 'pipe' });
  } catch {
    return 'outside-repo';
  }
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', absolute], { cwd, stdio: 'pipe' });
    return 'ignored';
  } catch (error) {
    // Exit status 1 means "not ignored"; anything else (e.g. a path outside the work tree) is
    // treated as outside the repository.
    const status = (error as { status?: number }).status;
    return status === 1 ? 'tracked-path' : 'outside-repo';
  }
}

export function assertNotCommittable(path: string, what: string): void {
  if (gitIgnoreStatus(path) === 'tracked-path') {
    throw new Error(
      `${what} ${path} is inside the repository but not git-ignored. Put it under a data/ or runs/ ` +
        'folder (both are ignored) or outside the repository.',
    );
  }
}
