import type { RateConfig } from './types.ts';

// Adaptive rate posture (D-2 / ADR-D2). Pure: given the current delay and the response status,
// return the next min-delay. On a throttle signal (429, or a 403 that a WAF commonly returns) grow
// the delay geometrically up to the ceiling; otherwise settle back to the conservative base. Keeping
// this pure makes the backoff behavior testable without any timers.

/** True for statuses that indicate the target is throttling / a WAF is intervening. */
export function isThrottleSignal(status: number): boolean {
  return status === 429 || status === 403;
}

export function nextDelayMs(currentDelayMs: number, status: number, config: RateConfig): number {
  if (isThrottleSignal(status)) {
    const grown = Math.max(config.baseDelayMs, currentDelayMs) * config.backoffMultiplier;
    return Math.min(config.maxDelayMs, grown);
  }
  // Decay gently toward the base rather than snapping back on the first clean response — a WAF that
  // intermittently returns 200 must not reset the learned backoff (D-2).
  return Math.max(config.baseDelayMs, Math.floor(currentDelayMs / config.backoffMultiplier));
}

/** Grow the delay after a send that THREW (no status) — a failing target still earns backoff. */
export function backoffAfterFailure(currentDelayMs: number, config: RateConfig): number {
  const grown = Math.max(config.baseDelayMs, currentDelayMs) * config.backoffMultiplier;
  return Math.min(config.maxDelayMs, grown);
}
