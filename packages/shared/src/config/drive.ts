import { z } from 'zod';
import { type Env, parseEnv } from './env';
import { int } from './fields';

/** Most items one drive listing page may return; the `limit` query parameter is capped here. */
export const DRIVE_PAGE_SIZE_LIMIT = 500;

/** Upper bound of DRIVE_MAX_FOLDER_DEPTH. */
export const DRIVE_MAX_FOLDER_DEPTH_LIMIT = 100;

/** Most items one trash or restore request may name. */
export const DRIVE_ITEMS_BATCH_MAX = 500;

const driveEnvSchema = z.object({
  /** Items per page of `GET /drive/folders/:id/children` and `GET /drive/trash` (spec: ~100). */
  DRIVE_PAGE_SIZE: int(1, DRIVE_PAGE_SIZE_LIMIT).default(100),
  /**
   * Deepest folder level (a folder at the drive root is level 1, its `nlevel(path)`). Bounds the
   * ltree path length; folder drag-and-drop and moves are checked against it. Assumption: the
   * spec has no limit.
   */
  DRIVE_MAX_FOLDER_DEPTH: int(1, DRIVE_MAX_FOLDER_DEPTH_LIMIT).default(32),
});

export interface DriveConfig {
  pageSize: number;
  maxFolderDepth: number;
}

export function loadDriveConfig(env: Env): DriveConfig {
  const e = parseEnv(driveEnvSchema, env, 'drive');
  return { pageSize: e.DRIVE_PAGE_SIZE, maxFolderDepth: e.DRIVE_MAX_FOLDER_DEPTH };
}
