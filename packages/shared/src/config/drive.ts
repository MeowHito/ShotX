import { z } from 'zod';
import { type Env, parseEnv } from './env';
import { int } from './fields';

/** Most items one drive listing page may return; the `limit` query parameter is capped here. */
export const DRIVE_PAGE_SIZE_LIMIT = 500;

/** Upper bound of DRIVE_MAX_FOLDER_DEPTH. */
export const DRIVE_MAX_FOLDER_DEPTH_LIMIT = 100;

/** Most items one trash or restore request may name. */
export const DRIVE_ITEMS_BATCH_MAX = 500;

/** Longest search text (`q` of `GET /drive/search`), in characters after trimming. */
export const DRIVE_SEARCH_QUERY_MAX_LENGTH = 100;

/** Upper bound of DRIVE_SEARCH_MAX_RESULTS. */
export const DRIVE_SEARCH_MAX_RESULTS_LIMIT = 10_000;

const driveEnvSchema = z.object({
  /** Items per page of `GET /drive/folders/:id/children` and `GET /drive/trash` (spec: ~100). */
  DRIVE_PAGE_SIZE: int(1, DRIVE_PAGE_SIZE_LIMIT).default(100),
  /**
   * Deepest folder level (a folder at the drive root is level 1, its `nlevel(path)`). Bounds the
   * ltree path length; folder drag-and-drop and moves are checked against it. Assumption: the
   * spec has no limit.
   */
  DRIVE_MAX_FOLDER_DEPTH: int(1, DRIVE_MAX_FOLDER_DEPTH_LIMIT).default(32),
  /** Items per page of `GET /drive/recent` (Wave 7; assumption). */
  DRIVE_RECENT_PAGE_SIZE: int(1, DRIVE_PAGE_SIZE_LIMIT).default(50),
  /** Items per page of `GET /drive/search` (assumption). */
  DRIVE_SEARCH_PAGE_SIZE: int(1, DRIVE_PAGE_SIZE_LIMIT).default(50),
  /**
   * Hard cap on the items one search returns over all its pages; past it the last page says
   * `truncated` and asks for a narrower search (assumption).
   */
  DRIVE_SEARCH_MAX_RESULTS: int(1, DRIVE_SEARCH_MAX_RESULTS_LIMIT).default(1000),
  /** `POST /drive/files/:id/copy` requests per photographer per window (assumption). */
  DRIVE_COPY_RATE_PER_USER: int(1, 100_000).default(120),
  DRIVE_COPY_RATE_WINDOW_SECONDS: int(1, 86_400).default(60),
  /**
   * Owner folder zips (`POST /drive/folders/:id/download`) one photographer may have queued or
   * running at once; more is RATE_LIMITED (assumption).
   */
  DRIVE_ZIP_MAX_ACTIVE_JOBS: int(1, 100).default(3),
});

export interface DriveConfig {
  pageSize: number;
  maxFolderDepth: number;
  recentPageSize: number;
  search: { pageSize: number; maxResults: number };
  copyRate: { limit: number; windowSeconds: number };
  zipMaxActiveJobs: number;
}

export function loadDriveConfig(env: Env): DriveConfig {
  const e = parseEnv(driveEnvSchema, env, 'drive');
  return {
    pageSize: e.DRIVE_PAGE_SIZE,
    maxFolderDepth: e.DRIVE_MAX_FOLDER_DEPTH,
    recentPageSize: e.DRIVE_RECENT_PAGE_SIZE,
    search: { pageSize: e.DRIVE_SEARCH_PAGE_SIZE, maxResults: e.DRIVE_SEARCH_MAX_RESULTS },
    copyRate: {
      limit: e.DRIVE_COPY_RATE_PER_USER,
      windowSeconds: e.DRIVE_COPY_RATE_WINDOW_SECONDS,
    },
    zipMaxActiveJobs: e.DRIVE_ZIP_MAX_ACTIVE_JOBS,
  };
}
