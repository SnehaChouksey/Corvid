import type * as z from 'zod';

// Thin HTTP layer to the gateway (`02` §6). The dashboard never imports agent/tool/workflow
// code — everything below is plain fetch against the documented REST contract, credentialed
// with the browser's Better Auth session cookie (cross-origin, so `credentials: 'include'` is
// mandatory on every call, not just the auth surface).

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, body: unknown, retryAfterSeconds: number | null) {
    super(`Gateway request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The gateway returned 200-range JSON that doesn't match the documented DTO shape. */
export class ApiShapeError extends Error {
  constructor(path: string, cause: z.ZodError) {
    super(`Unexpected response shape from ${path}: ${cause.message}`);
    this.name = 'ApiShapeError';
  }
}

function apiBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_URL;
  if (url === undefined || url.length === 0) {
    throw new Error('NEXT_PUBLIC_API_URL is not configured');
  }
  return url;
}

/**
 * Best-effort error body parsing. The gateway's documented contract is JSON (`{message}` /
 * `{error}`), but some 401/404/400 paths are raised as a Hono `HTTPException` with no explicit
 * response, which serializes as a *plain-text* body equal to the message — never JSON. Try JSON
 * first, then fall back to treating the raw text as a message, so callers get a consistent shape
 * either way instead of a swallowed parse error.
 */
async function parseErrorBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function parseRetryAfter(res: Response): number | null {
  const header = res.headers.get('retry-after');
  if (header === null) {
    return null;
  }
  const seconds = Number.parseInt(header, 10);
  return Number.isNaN(seconds) ? null : seconds;
}

export interface ApiFetchInit {
  readonly method?: 'GET' | 'POST' | 'PATCH';
  readonly body?: unknown;
}

/**
 * Call the gateway and validate the success response against `schema` (CODING_STANDARDS §1: Zod
 * at every HTTP boundary). Throws {@link ApiError} for any non-2xx status (callers branch on
 * `status`/`body` for the documented per-endpoint outcomes) and {@link ApiShapeError} if a 2xx
 * body doesn't match the contract.
 */
export async function apiFetch<T>(path: string, schema: z.ZodType<T>, init: ApiFetchInit = {}): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    method: init.method ?? 'GET',
    credentials: 'include',
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : {},
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined' && window.location.pathname !== '/sign-in') {
      // A hard navigation is deliberate here, not an oversight: apiFetch is a plain module-level
      // utility (no React tree, so no `useRouter`), and a full reload is actually what we want on
      // a session-expired 401 — it drops every client cache/store instead of leaving stale
      // authenticated state mounted behind the redirect.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign('/sign-in');
    }
    throw new ApiError(res.status, await parseErrorBody(res), parseRetryAfter(res));
  }

  const json: unknown = res.status === 204 ? undefined : await res.json();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiShapeError(path, parsed.error);
  }
  return parsed.data;
}

/** Narrow an error-body `unknown` down to a human message, covering every documented shape. */
export function apiErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.length > 0) {
      return record.message;
    }
    if (typeof record.error === 'string' && record.error.length > 0) {
      return record.error;
    }
  }
  return fallback;
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}
