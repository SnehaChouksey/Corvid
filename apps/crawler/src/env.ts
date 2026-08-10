import { parseEnv } from '@corvid/config';
import * as z from 'zod';

// Crawler configuration, validated at startup and fail-closed (§9). DATABASE_URL is required for the
// audit log (ADR-16) and REDIS_URL for the frontier/dedup (`02` §8) — neither has a safe default, so
// a missing one fails the boot rather than degrading a safety-relevant path.
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type CrawlerEnv = z.output<typeof EnvSchema>;

export function loadEnv(source: unknown = process.env): CrawlerEnv {
  return parseEnv(EnvSchema, source);
}
