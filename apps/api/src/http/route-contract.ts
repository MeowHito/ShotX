import { ALL_ROUTES, type HttpMethod, type RouteContract } from '@shotx/shared';
import type { Request } from 'express';

/** The global prefix every route is mounted under (createApiApp). */
const API_PREFIX = '/api';

/**
 * The contract method and path of the handler a request matched: Express's route pattern without
 * the global prefix (`/api/me` -> `/me`, `/api/drive/files/:id` -> `/drive/files/:id`). Null when
 * no route matched (callers fail closed).
 */
export function matchedRoute(req: Request): { method: HttpMethod; path: string } | null {
  const pattern: unknown = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof pattern !== 'string' || !pattern.startsWith(API_PREFIX)) return null;
  return { method: req.method as HttpMethod, path: pattern.slice(API_PREFIX.length) };
}

const CONTRACTS = new Map(ALL_ROUTES.map((r) => [`${r.method} ${r.path}`, r]));

/** The RouteContract of the matched handler, or null (callers fail closed). */
export function matchedContract(req: Request): RouteContract | null {
  const route = matchedRoute(req);
  return route === null ? null : (CONTRACTS.get(`${route.method} ${route.path}`) ?? null);
}
