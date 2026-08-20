import type { FetchRequest } from '@corvid/http-send/core';
import type { HttpResponse } from '@corvid/tool-contracts';

// The real network send used INSIDE the E2B sandbox (ADR-08/22): the sandbox's own `fetch`, whose
// egress is allow-listed to target + OOB at the firewall. This is deliberately a fresh impl (not the
// @corvid/http-send adapter's realFetch, which drags in @corvid/db and must never enter the bundle).
export async function realFetch(req: FetchRequest): Promise<HttpResponse> {
  const startedAt = Date.now();
  const res = await fetch(req.url, {
    method: req.method,
    ...(req.headers !== undefined ? { headers: req.headers } : {}),
    ...(req.body !== undefined ? { body: req.body } : {}),
  });
  const body = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: res.status, headers, body, timingMs: Date.now() - startedAt };
}
