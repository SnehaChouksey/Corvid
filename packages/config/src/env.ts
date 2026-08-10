import { ConfigError } from '@corvid/errors';
import type * as z from 'zod';

// Environment validation at startup (CODING_STANDARDS §9): fail fast and loud on anything missing
// or malformed, and never default a safety-relevant value to "open" — an unset egress/auth config
// stops the boot rather than widening access.

/**
 * Parse `source` (default `process.env`) against a Zod schema; returns typed, validated config or
 * throws {@link ConfigError}.
 *
 * §5: the error lists failing field paths + Zod's built-in messages only (which state the
 * expected/received *type*, never the value), so a malformed secret can't leak. `source` is never
 * interpolated, and a `custom` (`.refine()`) message is author-controlled so it's replaced with a
 * fixed string. Don't use `z.strictObject` here — `unrecognized_keys` would dump every env var name.
 */
export function parseEnv<T extends z.ZodType>(schema: T, source: unknown = process.env): z.output<T> {
  let result: z.ZodSafeParseResult<z.output<T>>;
  try {
    result = schema.safeParse(source);
  } catch (cause) {
    // A throwing `.transform()`/`.refine()` escapes `safeParse` as a raw non-Zod error; keep the
    // contract that parseEnv only ever throws a ConfigError (§4), and never echo the thrown detail.
    throw new ConfigError('Environment schema threw during parsing', { cause });
  }

  if (result.success) {
    return result.data;
  }

  const summary = result.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
      const message = issue.code === 'custom' ? 'failed custom validation' : issue.message;
      return `  ${path}: ${message}`;
    })
    .join('\n');

  throw new ConfigError(`Invalid environment configuration:\n${summary}`);
}
