// The pure request-enforcement core: the choke point (send.ts) + its types + rate posture, with NO
// DB/Redis-backed adapter. Consumers that must run without a DB — notably the burst runner bundled
// into the E2B sandbox, which has no DB reachability — import from '@corvid/http-send/core' so the
// adapter (and its @corvid/db → pg/drizzle deps) can never enter their bundle. The package index
// (`.`) still re-exports the adapter for the normal in-process callers.
export * from './types.ts';
export * from './rate.ts';
export * from './send.ts';
