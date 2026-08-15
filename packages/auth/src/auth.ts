import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { type Database, schema } from '@corvid/db';
import { betterAuth } from 'better-auth';

// Platform authentication (ADR-19). Better Auth owns the identity tables (users/sessions/accounts/
// verifications, defined in @corvid/db); this module wires it to the Drizzle instance and exposes
// session resolution. Tenant isolation itself lives in the data layer (owner-scoped repos) — this
// only establishes *who* the request is; the repos enforce what they may see.

export interface AuthConfig {
  /** The shared Drizzle instance (from @corvid/db `createDb`). */
  readonly database: Database;
  /** Signing secret (BETTER_AUTH_SECRET) — validated via @corvid/config, never hard-coded (§9). */
  readonly secret: string;
  /** Public base URL of the auth surface; required so cookie/CSRF behavior isn't request-inferred. */
  readonly baseURL: string;
  /** Additional origins (e.g. the dashboard) allowed to POST to the auth surface. */
  readonly trustedOrigins?: readonly string[];
  /**
   * Google OAuth credentials; when present, enables provider sign-in (ADR-19). Absent → email/password
   * only. Redirect URI to register with Google: `${baseURL}/api/auth/callback/google`.
   */
  readonly google?: { readonly clientId: string; readonly clientSecret: string };
}

// Return type is inferred, not annotated: annotating it as `ReturnType<typeof betterAuth>` forces
// Better Auth's generic-default options type, which is incompatible with our specific options under
// exactOptionalPropertyTypes. `Auth` is derived from the inferred return below.
export function createAuth(config: AuthConfig) {
  // Pass the schema explicitly and use plural table names to match `02` §5 (`users`, …).
  // Extracted to its own const per Better Auth guidance — inlining triggers "excessively deep
  // type instantiation" against a large Drizzle schema.
  const adapter = drizzleAdapter(config.database, { provider: 'pg', schema, usePlural: true });

  return betterAuth({
    database: adapter,
    secret: config.secret,
    baseURL: config.baseURL,
    ...(config.trustedOrigins !== undefined ? { trustedOrigins: [...config.trustedOrigins] } : {}),
    emailAndPassword: { enabled: true },
    // Google account links to the same `users` row, so tenant scoping is unchanged (still one users.id).
    ...(config.google !== undefined
      ? { socialProviders: { google: { clientId: config.google.clientId, clientSecret: config.google.clientSecret } } }
      : {}),
    // Let Postgres generate ids via the columns' DEFAULT (uuid), rather than Better Auth's own
    // string ids — keeps every id a uuid per the `02` §5 ERD.
    advanced: { database: { generateId: false } },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Resolve the authenticated user id from request headers, or null if unauthenticated (ADR-19). */
export async function resolveUserId(auth: Auth, headers: Headers): Promise<string | null> {
  const session = await auth.api.getSession({ headers });
  return session?.user.id ?? null;
}
