import type { CrawledParam, InjectionClass } from '@corvid/tool-contracts';

// Payload sets + injection mechanics for injection.fuzz (D-14). Pure and data-driven so each is
// testable. The tester SENDS these and records signals; the verifier applies the false-positive
// guards (error attributable to the metacharacter with a neutralized control producing none;
// time-based dose-response where latency scales with the injected delay). Nothing here decides.

export interface InjectionPayload {
  readonly injectionClass: InjectionClass;
  readonly family: string;
  readonly value: string;
}

// `escaped-control` is the neutralized control the verifier needs for the error-based FP guard.
// The two sleep doses (2s/4s) are the dose-response pair whose latencies must scale (D-14).
export const INJECTION_PAYLOADS: readonly InjectionPayload[] = [
  { injectionClass: 'sqli_error', family: 'single-quote', value: "'" },
  { injectionClass: 'sqli_error', family: 'double-quote', value: '"' },
  // Break out of a parenthesized clause, e.g. `LIKE ('%…%')` — a bare quote inside parens is valid,
  // so the query only errors once the parens are closed (found testing a real app).
  { injectionClass: 'sqli_error', family: 'paren-breakout', value: "'))" },
  { injectionClass: 'sqli_error', family: 'paren-breakout-single', value: "')" },
  { injectionClass: 'sqli_error', family: 'escaped-control', value: "''" },
  { injectionClass: 'sqli_time', family: 'pg-sleep-2s', value: "'||pg_sleep(2)--" },
  { injectionClass: 'sqli_time', family: 'pg-sleep-4s', value: "'||pg_sleep(4)--" },
  { injectionClass: 'sqli_time', family: 'mysql-sleep-2s', value: "' OR SLEEP(2)-- " },
  { injectionClass: 'sqli_time', family: 'mysql-sleep-4s', value: "' OR SLEEP(4)-- " },
  { injectionClass: 'nosqli', family: 'ne-operator', value: '{"$ne":null}' },
  { injectionClass: 'nosqli', family: 'always-true', value: "' || '1'=='1" },
];

// Known DB-error signatures. We report the matched pattern NAMES as an observation (never the raw
// error text — §5). The verifier attributes an error to our metacharacter using the control attempt.
const DB_ERROR_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: 'postgres', re: /PostgreSQL.*ERROR|pg_query\(\)|PSQLException|unterminated quoted string/i },
  { name: 'mysql', re: /SQL syntax.*MySQL|check the manual that corresponds to your (MySQL|MariaDB)|mysql_fetch|MySqlException/i },
  { name: 'mssql', re: /Microsoft OLE DB|SQLServerException|Unclosed quotation mark|Incorrect syntax near/i },
  { name: 'oracle', re: /ORA-\d{5}|Oracle error|quoted string not properly terminated/i },
  { name: 'sqlite', re: /SQLite\/JDBCDriver|sqlite3\.OperationalError|SQLITE_ERROR|unrecognized token/i },
  { name: 'generic_sql', re: /SQL syntax|syntax error at or near|SQLException/i },
];

export function matchDbErrors(body: string): string[] {
  return DB_ERROR_PATTERNS.filter((p) => p.re.test(body)).map((p) => p.name);
}

export type InjectResult =
  | { readonly ok: true; readonly url: string; readonly body?: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Place `value` into `param`. Query → the URL search param; body → a JSON key. Returns `ok:false`
 * for cases v1 cannot inject faithfully rather than testing the WRONG location and reporting a
 * false-negative-shaped clean result: a `path` param (the sink is a path segment, not a query) and a
 * non-JSON request body (fabricating a JSON body would drop the real fields + content type).
 */
export function injectPayload(
  baseUrl: string,
  baseBody: string | undefined,
  param: CrawledParam,
  value: string,
): InjectResult {
  if (param.location === 'path') {
    return { ok: false, reason: 'path-parameter injection not supported in v1' };
  }
  if (param.location === 'body') {
    let obj: Record<string, unknown> = {};
    if (baseBody !== undefined) {
      try {
        obj = JSON.parse(baseBody) as Record<string, unknown>;
      } catch {
        return { ok: false, reason: 'non-JSON request body injection not supported in v1' };
      }
    }
    return { ok: true, url: baseUrl, body: JSON.stringify({ ...obj, [param.name]: value }) };
  }
  const url = new URL(baseUrl);
  url.searchParams.set(param.name, value);
  return baseBody !== undefined ? { ok: true, url: url.toString(), body: baseBody } : { ok: true, url: url.toString() };
}
