import { parseEnv } from '@corvid/config';
import * as z from 'zod';

// Gateway configuration, validated at startup and fail-closed (§9). Abuse-control limits are
// config-driven with conservative defaults (D-11); raised on real usage, never hard-coded loose.
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  // Optional in v1 (Redis provisioning is Unit 0): when set, rate-limit counters are shared across
  // instances via Redis (ADR-20); when unset, the in-memory store is used (single-instance only).
  REDIS_URL: z.string().min(1).optional(),
  BETTER_AUTH_SECRET: z.string().min(16),
  BETTER_AUTH_URL: z.url(),
  // Application-level key for encrypting analyst-supplied target credentials at rest (D-1, §9).
  // Required and fail-closed: without it the gateway would have to either refuse credentialed scans
  // or store plaintext — both worse than not booting. The exact 32-byte AES-256 decode is enforced
  // by @corvid/crypto's loadKey. Generate with `openssl rand -base64 32`.
  ENCRYPTION_KEY: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8787),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  CONCURRENT_SCAN_CAP: z.coerce.number().int().positive().default(3),
});

export type GatewayEnv = z.output<typeof EnvSchema>;

export function loadEnv(source: unknown = process.env): GatewayEnv {
  return parseEnv(EnvSchema, source);
}
