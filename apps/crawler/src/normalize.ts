/**
 * Canonicalize a URL for frontier dedup and endpoint keying. Returns null for anything that is not
 * an http(s) URL (`mailto:`, `javascript:`, `tel:`, `data:`, fragment-only) — those are never
 * crawled. Canonical form: lowercased host, fragment stripped, default ports dropped. The query is
 * PRESERVED (a different query can be a different page); the crawl's `maxPages` bound keeps a
 * query-heavy site finite. Fails closed: an unparseable URL is not crawlable.
 */
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  // Drop any userinfo (`user:pass@host`) — a credential must never ride in a stored/logged URL (§5).
  u.username = '';
  u.password = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }
  return u.toString();
}
