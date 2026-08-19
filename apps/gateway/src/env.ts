import { parseEnv } from '@corvid/config';
import * as z from 'zod';

// Gateway configuration, validated at startup and fail-closed (§9). Abuse-control limits are
// config-driven with conservative defaults (D-11); raised on real usage, never hard-coded loose.
const EnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    // Optional in v1 (Redis provisioning is Unit 0): when set, rate-limit counters are shared across
    // instances via Redis (ADR-20); when unset, the in-memory store is used (single-instance only).
    REDIS_URL: z.string().min(1).optional(),
    BETTER_AUTH_SECRET: z.string().min(16),
    BETTER_AUTH_URL: z.url(),
    // Comma-separated origins allowed to drive the auth surface (the dashboard, for cross-origin
    // sign-in + the OAuth redirect back). Absent → same-origin only.
    TRUSTED_ORIGINS: z.string().optional(),
    // Google OAuth (ADR-19). Both-or-neither (refine below); absent → email/password only.
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    // Application-level key for encrypting analyst-supplied target credentials at rest (D-1, §9).
    // Required and fail-closed: without it the gateway would have to either refuse credentialed scans
    // or store plaintext — both worse than not booting. The exact 32-byte AES-256 decode is enforced
    // by @corvid/crypto's loadKey. Generate with `openssl rand -base64 32`.
    ENCRYPTION_KEY: z.string().min(1),
    // OpenRouter API key for the reasoning core (ADR-23). Optional so the gateway still boots without
    // it (in a degraded mode where a started scan fails fast at the hypothesize node); when set, the
    // durable runtime's hypothesize/plan ports are wired live. Model slugs live in @corvid/llm.
    OPENROUTER_API_KEY: z.string().min(1).optional(),
    PORT: z.coerce.number().int().positive().default(8787),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
    CONCURRENT_SCAN_CAP: z.coerce.number().int().positive().default(3),
  })
  .refine((e) => (e.GOOGLE_CLIENT_ID === undefined) === (e.GOOGLE_CLIENT_SECRET === undefined), {
    message: 'Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither',
  });

export type GatewayEnv = z.output<typeof EnvSchema>;

export function loadEnv(source: unknown = process.env): GatewayEnv {
  return parseEnv(EnvSchema, source);
}
