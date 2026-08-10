// Typed error hierarchy (CODING_STANDARDS §4): callers distinguish failures by `kind`, never by
// matching `error.message` substrings.
//
// A verification negative is deliberately NOT modeled here: "the test ran and did not prove the
// exploit" is a domain OUTCOME (`VerificationOutcome` in @corvid/tool-contracts), never an
// exception — conflating the two is how a real vulnerability gets silently dropped (§4).

/**
 * Structured, non-sensitive context attached to an error. Scalars only, and an explicit
 * allow-list by construction: NEVER put a secret, a credential, or a raw target response body
 * here (CODING_STANDARDS §5) — safe identifiers only (scan_id, hypothesis_id, vuln_class,
 * endpoint, status_code).
 */
export type ErrorContext = Readonly<Record<string, string | number | boolean>>;

export type ErrorKind = 'config' | 'authorization' | 'target' | 'infra';

export interface CorvidErrorOptions {
  readonly context?: ErrorContext;
  readonly cause?: unknown;
}

/**
 * Base for every deliberate, typed Corvid error. Native ES2022 `Error` subclassing — `instanceof`
 * works without a prototype fix-up because we target native classes.
 */
export abstract class CorvidError extends Error {
  /** Discriminant. Switch on this, never on message text (§4). */
  abstract readonly kind: ErrorKind;
  /** Whether a retry could plausibly succeed. Config and authorization are never retryable (§4). */
  abstract readonly retryable: boolean;
  readonly context: ErrorContext;

  constructor(message: string, options: CorvidErrorOptions = {}) {
    // Only pass `cause` when supplied so we never synthesize an `undefined` cause under
    // exactOptionalPropertyTypes.
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.context = options.context ?? {};
  }
}

/** Missing or invalid configuration/environment. Terminal at boot — fail closed (§9). */
export class ConfigError extends CorvidError {
  readonly kind = 'config';
  readonly retryable = false;
}

/**
 * Authorization or scope refusal. Terminal and loud — surfaced and audited, never retried into
 * scope, never downgraded to a warning (§4, §5). This is a safety boundary, not a transient fault.
 */
export class AuthorizationError extends CorvidError {
  readonly kind = 'authorization';
  readonly retryable = false;
}

/**
 * A target-side condition (e.g. 429/5xx from the system under test) — informative, not our bug
 * (§4). Distinct from a verification result: a target error means the test could not complete,
 * NOT that the endpoint is clean.
 */
export class TargetError extends CorvidError {
  readonly kind = 'target';
  readonly retryable: boolean;

  constructor(message: string, options: CorvidErrorOptions & { readonly retryable?: boolean } = {}) {
    super(message, options);
    this.retryable = options.retryable ?? false;
  }
}

/**
 * A tool/infrastructure failure — the E2B sandbox, OOB listener, or LLM gateway (§4). `retryable`
 * is REQUIRED, not defaulted: this class wraps active testing, so a blind retry could re-send a
 * payload past a per-test approval, and an LLM spend-cap refusal (ADR-21) is terminal. Each throw
 * site states its intent (fail-closed, §9).
 */
export class InfraError extends CorvidError {
  readonly kind = 'infra';
  readonly retryable: boolean;

  constructor(message: string, options: CorvidErrorOptions & { readonly retryable: boolean }) {
    super(message, options);
    this.retryable = options.retryable;
  }
}

/** Narrow an unknown thrown value to a Corvid error without matching on message text (§4). */
export function isCorvidError(value: unknown): value is CorvidError {
  return value instanceof CorvidError;
}
