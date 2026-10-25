import type { z } from 'zod';
import { ErrorCode } from '../errors';
import { API_PREFIX, idParamsSchema } from './common';
import {
  createFolderBodySchema,
  driveFileSchema,
  driveFolderSchema,
  driveItemsBodySchema,
  driveUsageResponseSchema,
  emptyTrashResponseSchema,
  listChildrenParamsSchema,
  listChildrenQuerySchema,
  listChildrenResponseSchema,
  listTrashQuerySchema,
  listTrashResponseSchema,
  restoreItemsResponseSchema,
  trashItemsResponseSchema,
  updateFileBodySchema,
  updateFolderBodySchema,
} from './drive';
import {
  completeUploadBodySchema,
  completeUploadResponseSchema,
  listPartsResponseSchema,
  signPartsBodySchema,
  signPartsResponseSchema,
  uploadInitBodySchema,
  uploadInitResponseSchema,
} from './uploads';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * One API route: everything api (NestJS controllers and zod pipes), web (the client) and the
 * OpenAPI generator need. `path` is relative to {@link API_PREFIX} in NestJS syntax (`:id`).
 * Validation failures of params, query or body are VALIDATION_FAILED with
 * `validationFailedDetails`.
 */
export interface RouteContract {
  method: HttpMethod;
  path: string;
  /** Status of a successful response. 204 has no body. */
  status: 200 | 201 | 202 | 204;
  /** Who may call it. `photographer` routes take a users-pool token of a photographer. */
  auth: 'photographer';
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  /** Absent for 204. */
  response?: z.ZodType;
  /** Every error code the route can return. */
  errors: readonly ErrorCode[];
}

/** Errors every authenticated route can return. */
export const COMMON_ROUTE_ERRORS = [
  ErrorCode.VALIDATION_FAILED,
  ErrorCode.UNAUTHENTICATED,
  ErrorCode.FORBIDDEN,
  ErrorCode.RATE_LIMITED,
  ErrorCode.INTERNAL_ERROR,
] as const;

const errors = (...specific: ErrorCode[]): readonly ErrorCode[] => [
  ...COMMON_ROUTE_ERRORS,
  ...specific,
];

/** Drive routes (Phase 2). Items of other owners are NOT_FOUND. */
export const DRIVE_ROUTES = {
  /** One page of a folder's live children, folders first. `:id` is a folder id or `root`. */
  listChildren: {
    method: 'GET',
    path: '/drive/folders/:id/children',
    status: 200,
    auth: 'photographer',
    params: listChildrenParamsSchema,
    query: listChildrenQuerySchema,
    response: listChildrenResponseSchema,
    errors: errors(ErrorCode.NOT_FOUND),
  },
  createFolder: {
    method: 'POST',
    path: '/drive/folders',
    status: 201,
    auth: 'photographer',
    body: createFolderBodySchema,
    response: driveFolderSchema,
    errors: errors(ErrorCode.NOT_FOUND, ErrorCode.NAME_TAKEN, ErrorCode.FOLDER_DEPTH_EXCEEDED),
  },
  /** Rename and/or move a folder (with its subtree). */
  updateFolder: {
    method: 'PATCH',
    path: '/drive/folders/:id',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    body: updateFolderBodySchema,
    response: driveFolderSchema,
    errors: errors(
      ErrorCode.NOT_FOUND,
      ErrorCode.NAME_TAKEN,
      ErrorCode.INVALID_MOVE,
      ErrorCode.FOLDER_DEPTH_EXCEEDED,
    ),
  },
  /** Rename and/or move a file. */
  updateFile: {
    method: 'PATCH',
    path: '/drive/files/:id',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    body: updateFileBodySchema,
    response: driveFileSchema,
    errors: errors(ErrorCode.NOT_FOUND, ErrorCode.NAME_TAKEN, ErrorCode.UNSUPPORTED_FILE_TYPE),
  },
  trashItems: {
    method: 'POST',
    path: '/drive/items/trash',
    status: 200,
    auth: 'photographer',
    body: driveItemsBodySchema,
    response: trashItemsResponseSchema,
    errors: errors(ErrorCode.NOT_FOUND),
  },
  restoreItems: {
    method: 'POST',
    path: '/drive/items/restore',
    status: 200,
    auth: 'photographer',
    body: driveItemsBodySchema,
    response: restoreItemsResponseSchema,
    errors: errors(ErrorCode.NOT_FOUND),
  },
  /** Added (not in the spec's route list): the trash view needs a listing. */
  listTrash: {
    method: 'GET',
    path: '/drive/trash',
    status: 200,
    auth: 'photographer',
    query: listTrashQuerySchema,
    response: listTrashResponseSchema,
    errors: errors(),
  },
  emptyTrash: {
    method: 'DELETE',
    path: '/drive/trash',
    status: 202,
    auth: 'photographer',
    response: emptyTrashResponseSchema,
    errors: errors(),
  },
  /** Added (not in the spec's route list): the studio's storage meter. */
  usage: {
    method: 'GET',
    path: '/drive/usage',
    status: 200,
    auth: 'photographer',
    response: driveUsageResponseSchema,
    errors: errors(),
  },
} as const satisfies Record<string, RouteContract>;

/** Upload routes (Phase 2). `:id` is the file id. */
export const UPLOAD_ROUTES = {
  init: {
    method: 'POST',
    path: '/uploads/init',
    status: 201,
    auth: 'photographer',
    body: uploadInitBodySchema,
    response: uploadInitResponseSchema,
    errors: errors(
      ErrorCode.SUBSCRIPTION_INACTIVE,
      ErrorCode.UNSUPPORTED_FILE_TYPE,
      ErrorCode.FILE_TOO_LARGE,
      ErrorCode.QUOTA_EXCEEDED,
      ErrorCode.NOT_FOUND,
      ErrorCode.NAME_TAKEN,
      ErrorCode.FOLDER_DEPTH_EXCEEDED,
    ),
  },
  /** Added: presigned URLs for more parts (Uppy `signPart`). */
  signParts: {
    method: 'POST',
    path: '/uploads/:id/parts',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    body: signPartsBodySchema,
    response: signPartsResponseSchema,
    errors: errors(ErrorCode.UPLOAD_NOT_FOUND, ErrorCode.UPLOAD_EXPIRED, ErrorCode.CONFLICT),
  },
  /** Added: parts already uploaded, for resuming (Uppy `listParts`). */
  listParts: {
    method: 'GET',
    path: '/uploads/:id/parts',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    response: listPartsResponseSchema,
    errors: errors(ErrorCode.UPLOAD_NOT_FOUND, ErrorCode.UPLOAD_EXPIRED, ErrorCode.CONFLICT),
  },
  complete: {
    method: 'POST',
    path: '/uploads/:id/complete',
    status: 200,
    auth: 'photographer',
    params: idParamsSchema,
    body: completeUploadBodySchema,
    response: completeUploadResponseSchema,
    errors: errors(
      ErrorCode.UPLOAD_NOT_FOUND,
      ErrorCode.UPLOAD_EXPIRED,
      ErrorCode.UPLOAD_PARTS_INVALID,
    ),
  },
  /** Abort: S3 AbortMultipartUpload, delete the row, release the reservation. */
  abort: {
    method: 'DELETE',
    path: '/uploads/:id',
    status: 204,
    auth: 'photographer',
    params: idParamsSchema,
    errors: errors(ErrorCode.UPLOAD_NOT_FOUND, ErrorCode.CONFLICT),
  },
} as const satisfies Record<string, RouteContract>;

/** Every route with a contract, by module. */
export const API_ROUTES = { drive: DRIVE_ROUTES, uploads: UPLOAD_ROUTES } as const;

/** Every route as a flat list, e.g. for OpenAPI generation. */
export const ALL_ROUTES: readonly RouteContract[] = Object.values(API_ROUTES).flatMap(
  (group) => Object.values(group) as RouteContract[],
);

/** Names of the `:param` segments of a route path. */
export type PathParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | PathParamNames<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;

export type PathParams<P extends string> = { [K in PathParamNames<P>]: string };

export interface ApiPathOptions {
  /** Prepend {@link API_PREFIX} (default true). NestJS controllers use the bare path. */
  prefix?: boolean;
}

/**
 * The URL path of a route with its params filled in and URL-encoded, e.g.
 * `apiPath(DRIVE_ROUTES.listChildren, { id: 'root' })` is `/api/drive/folders/root/children`.
 * Throws when a param is missing or empty.
 */
export function apiPath<P extends string>(
  route: { path: P },
  ...[params, options]: PathParamNames<P> extends never
    ? [params?: Record<string, never>, options?: ApiPathOptions]
    : [params: PathParams<P>, options?: ApiPathOptions]
): string {
  const values = (params ?? {}) as Record<string, string | undefined>;
  const path = route.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined || value === '') {
      throw new RangeError(`Missing path param ${name} for ${route.path}`);
    }
    return encodeURIComponent(value);
  });
  return options?.prefix === false ? path : `${API_PREFIX}${path}`;
}
