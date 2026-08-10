import { isCorvidError } from '@corvid/errors';
import pino from 'pino';

// The one shared structured logger (CODING_STANDARDS §13); product code never uses console.* (lint).
//
// §5 secret hygiene is structural: `formatters.log` deep-scrubs each per-call object
// case-insensitively at any depth, and `redact.paths` backstops child bindings (which bypass
// formatters.log). Neither can scrub the message STRING — so secrets go in fields, never the
// message (lint-enforced).

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

/** Standard structured fields bound to a logger where the ids first exist (§13). */
export interface StandardFields {
  readonly scan_id?: string;
  readonly hypothesis_id?: string;
  readonly vuln_class?: string;
  readonly endpoint?: string;
  readonly actor?: string;
}

export interface CreateLoggerOptions {
  readonly level: LogLevel;
  /** Names the emitting deployable, e.g. 'agent-core', 'gateway'. Bound on every line. */
  readonly service: string;
  /** Extra secret key names to redact (matched case-insensitively at any depth). */
  readonly redactKeys?: readonly string[];
  /** Custom sink (tests, files). Defaults to stdout. */
  readonly destination?: pino.DestinationStream;
}

export type CorvidLogger = pino.Logger;

const REDACTED = '[REDACTED]';
// Bound the walk so a cyclic or huge tool-result envelope can never blow the log path.
const MAX_SCRUB_DEPTH = 6;

// Key names that must never reach a log line (§5) — matched case-insensitively across snake/camel/
// kebab/header casing: credentials, tokens, cookies, keys, JWTs/signatures, and raw bodies.
const SECRET_KEY =
  /^(?:password|passwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|session[_-]?token|api[_-]?key|x-api-key|authorization|proxy-authorization|cookie|set-cookie|credentials?|private[_-]?key|encryption[_-]?key|jwt|bearer|signature|body|raw[_-]?body|request[_-]?body|response[_-]?body|response[_-]?text)$/i;

function scrub(value: unknown, depth: number, customKeys: readonly string[]): unknown {
  if (depth > MAX_SCRUB_DEPTH) {
    return '[Truncated]';
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  // Walking an Error drops its non-enumerable message/stack; leave it for the `err` serializer.
  if (value instanceof Error) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrub(item, depth + 1, customKeys));
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const isSecret = SECRET_KEY.test(key) || customKeys.some((k) => k.toLowerCase() === key.toLowerCase());
    out[key] = isSecret ? REDACTED : scrub(child, depth + 1, customKeys);
  }
  return out;
}

/** Create the shared structured logger for a deployable. */
export function createLogger(options: CreateLoggerOptions): CorvidLogger {
  const customKeys = options.redactKeys ?? [];

  const loggerOptions: pino.LoggerOptions = {
    level: options.level,
    // Keep pino's default instance attribution (pid) so multiple workers are distinguishable.
    base: { service: options.service, pid: process.pid },
    formatters: {
      log: (object) => scrub(object, 0, customKeys) as Record<string, unknown>,
    },
    serializers: {
      // Our typed errors become safe structured fields (context deep-scrubbed). Other throwables
      // fall back to pino's std serializer — a residual §5 risk only for third-party message text.
      err: (error: unknown) =>
        isCorvidError(error)
          ? {
              type: error.name,
              kind: error.kind,
              retryable: error.retryable,
              msg: error.message,
              context: scrub(error.context, 0, customKeys),
              stack: error.stack,
            }
          : pino.stdSerializers.err(error as Error),
    },
    // Backstop for child bindings, which bypass formatters.log; the deep scrub covers per-call objects.
    redact: {
      paths: [
        'password',
        '*.password',
        'token',
        '*.token',
        'authorization',
        '*.authorization',
        'credentials',
        '*.credentials',
        'encryption_key',
        '*.encryption_key',
        'body',
        '*.body',
        'response_body',
        '*.response_body',
      ],
      censor: REDACTED,
    },
  };

  return options.destination === undefined
    ? pino(loggerOptions)
    : pino(loggerOptions, options.destination);
}

/** Bind standard fields, returning a child logger that carries them on every line (§13). */
export function withFields(logger: CorvidLogger, fields: StandardFields): CorvidLogger {
  return logger.child(fields);
}
