import * as z from 'zod';

// The `crawler.map` MCP tool contract (`02` §10). Author input schemas as `z.object({...})`
// (AGENTS.md). Contracts are ADDITIVE-ONLY once published (`CODING_STANDARDS.md` §8): a new
// optional field is fine; changing or removing an existing one is a compatibility decision.
//
// The scope shape is inlined here rather than imported from @corvid/scope so this wire contract
// stays dependency-light (the gateway inlines the same shape at its boundary). The crawler app
// re-validates the received scope with @corvid/scope's `parseScopeRules` — the ONE authoritative
// validator (dangerous-host reject, fail-closed). The contract is the transport shape; the scope
// package remains the single source of truth for what a valid, safe scope is.

export const httpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
export type HttpMethod = z.infer<typeof httpMethodSchema>;

/** Where a parameter rides on a request — the tester (Unit 4) needs this to place a payload. */
export const paramLocationSchema = z.enum(['query', 'body', 'path']);
export type ParamLocation = z.infer<typeof paramLocationSchema>;

export const paramSchema = z
  .object({
    name: z.string().min(1),
    location: paramLocationSchema,
  })
  .readonly();
export type CrawledParam = z.infer<typeof paramSchema>;

/** How the endpoint was discovered — provenance for the analyst reviewing the surface (`01` §5). */
export const endpointSourceSchema = z.enum(['navigation', 'xhr', 'fetch', 'form', 'link']);
export type EndpointSource = z.infer<typeof endpointSourceSchema>;

export const endpointSchema = z
  .object({
    /** Full in-scope URL. Out-of-scope URLs are never emitted (scope enforced during the crawl). */
    url: z.string().min(1),
    method: httpMethodSchema,
    source: endpointSourceSchema,
    params: z.array(paramSchema),
  })
  .readonly();
export type CrawledEndpoint = z.infer<typeof endpointSchema>;

/**
 * A detected authentication flow. v1 MAPS these (kind + where + fields) but does not replay a
 * credentialed login — analyst-supplied credentials (D-1) arrive with Unit 6's scan config, and a
 * `credentials` input field is added additively then. Until then the map tells the analyst and the
 * agent where auth lives.
 */
export const authFlowKindSchema = z.enum(['form_login', 'oauth_redirect', 'unknown']);
export type AuthFlowKind = z.infer<typeof authFlowKindSchema>;

export const authFlowSchema = z
  .object({
    kind: authFlowKindSchema,
    /** The page the flow was observed on. */
    url: z.string().min(1),
    /** For a form login: the form's action target and method, and its input field names/types. */
    formAction: z.string().optional(),
    method: httpMethodSchema.optional(),
    fields: z.array(z.object({ name: z.string(), type: z.string() }).readonly()),
  })
  .readonly();
export type AuthFlow = z.infer<typeof authFlowSchema>;

// ---- crawler.map input ----

// The ONLY caller-supplied value is which scan to crawl (+ optional bounds). The seed URL, the
// scope, and the recorded authorization are all derived server-side from the scan's target row —
// the caller can never widen scope or point the crawler at a host the target wasn't authorized for
// (the "recorded authorization" invariant; a tool arg, potentially LLM-influenced, is not a scope).
export const crawlerMapInputSchema = z
  .object({
    /** The scan to crawl. Its target's URL + scope + authorization are read from the DB. */
    scanId: z.uuid(),
    /** Bounds so a crawl terminates (an unbounded SPA crawl never ends). Conservative defaults. */
    maxPages: z.number().int().positive().max(2000).default(200),
    maxDepth: z.number().int().nonnegative().max(30).default(10),
  })
  .strict();
export type CrawlerMapInput = z.infer<typeof crawlerMapInputSchema>;

// ---- crawler.map output ----

export const crawlerMapOutputSchema = z
  .object({
    endpoints: z.array(endpointSchema),
    authFlows: z.array(authFlowSchema),
    stats: z
      .object({
        pagesVisited: z.number().int().nonnegative(),
        endpointsFound: z.number().int().nonnegative(),
        /** Count of URLs the crawler declined to enqueue because they were out of scope. */
        skippedOutOfScope: z.number().int().nonnegative(),
      })
      .readonly(),
  })
  .readonly();
export type CrawlerMapOutput = z.infer<typeof crawlerMapOutputSchema>;
