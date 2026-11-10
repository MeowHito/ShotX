import {
  apiPath,
  type MultipartSpec,
  type PathParamNames,
  type PathParams,
  type RouteContract,
} from '@shotx/shared';
import type { z } from 'zod';
import { ContractError, errorFromResponse, NetworkError } from './errors';

/**
 * Typed client for the routes in `@shotx/shared` (API_ROUTES). Every call is checked against the
 * route contract at compile time (params, query, body) and at run time (the response schema).
 *
 * In the browser the base URL is the admin app's BFF (`/bff`), which adds the bearer token from
 * the httpOnly session cookie and forwards ADMIN_ROUTES only; see src/lib/bff. On the server the
 * same client calls the API's sign-in routes with the BFF key (src/lib/auth/admin-auth-api).
 */

type ParamsOf<R> = R extends { path: infer P extends string }
  ? [PathParamNames<P>] extends [never]
    ? { params?: undefined }
    : { params: PathParams<P> }
  : never;

type QueryOf<R> = R extends { query: infer Q extends z.ZodType }
  ? { query?: z.input<Q> }
  : { query?: undefined };

type BodyOf<R> = R extends { body: infer B extends z.ZodType }
  ? { body: z.input<B> }
  : { body?: undefined };

type HeadersOf<R> = R extends { headers: infer H extends z.ZodType }
  ? { headers?: z.input<H> }
  : { headers?: undefined };

/** Multipart routes take a FormData whose file parts follow the route's MultipartSpec. */
type FormOf<R> = R extends { multipart: MultipartSpec } ? { form: FormData } : { form?: undefined };

export type CallOptions<R> = ParamsOf<R> &
  QueryOf<R> &
  BodyOf<R> &
  HeadersOf<R> &
  FormOf<R> & { signal?: AbortSignal };

export type ResponseOf<R> = R extends { response: infer S extends z.ZodType } ? z.output<S> : void;

/** True when every field of `T` is optional, so the options argument can be left out. */
type AllOptional<T> = Partial<T> extends T ? true : false;

export type CallArgs<R> =
  AllOptional<CallOptions<R>> extends true ? [options?: CallOptions<R>] : [options: CallOptions<R>];

export interface ApiClient {
  call<R extends RouteContract>(route: R, ...args: CallArgs<R>): Promise<ResponseOf<R>>;
}

export interface ApiClientOptions {
  /** Prefix for route paths, e.g. `/bff` in the browser. No trailing slash. */
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  /** `same-origin` (default). */
  credentials?: RequestCredentials;
}

export function buildUrl(baseUrl: string, path: string, query: unknown): string {
  const search = new URLSearchParams();
  if (query !== undefined && query !== null) {
    for (const [key, value] of Object.entries(
      query as Record<string, string | number | boolean | null | undefined>,
    )) {
      if (value === undefined || value === null) continue;
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return `${baseUrl}${path}${qs ? `?${qs}` : ''}`;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));

  async function call<R extends RouteContract>(
    route: R,
    ...args: CallArgs<R>
  ): Promise<ResponseOf<R>> {
    const opts = (args[0] ?? {}) as {
      params?: Record<string, string>;
      query?: unknown;
      body?: unknown;
      headers?: Record<string, string | undefined>;
      form?: FormData;
      signal?: AbortSignal;
    };
    const path = apiPath(route as { path: string }, opts.params as Record<string, never>, {
      prefix: false,
    });
    const url = buildUrl(options.baseUrl, path, opts.query);
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
    for (const [name, value] of Object.entries(opts.headers ?? {})) {
      if (value !== undefined) headers[name] = value;
    }
    let body: string | FormData | undefined;
    if (opts.form !== undefined) {
      // The browser sets the multipart content type with its boundary.
      body = opts.form;
    } else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: route.method,
        headers,
        body,
        signal: opts.signal,
        credentials: options.credentials ?? 'same-origin',
        cache: 'no-store',
      });
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      throw new NetworkError(error instanceof Error ? error.message : 'Network request failed');
    }

    if (!response.ok) {
      throw errorFromResponse(response.status, await readJson(response));
    }
    if (route.response === undefined || response.status === 204) {
      return undefined as ResponseOf<R>;
    }
    const parsed = route.response.safeParse(await readJson(response));
    if (!parsed.success) {
      throw new ContractError(
        response.status,
        `Response of ${route.method} ${route.path} failed its schema`,
      );
    }
    return parsed.data as ResponseOf<R>;
  }

  return { call };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
