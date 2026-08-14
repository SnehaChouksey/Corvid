import type { ScopeRules } from '@/lib/api/schemas';

/** Parse a newline/comma-separated textarea into a trimmed, non-empty string array. */
export function parseListField(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function scopeRulesToFields(scopeRules?: ScopeRules): { hosts: string; includePaths: string; excludePaths: string } {
  return {
    hosts: scopeRules?.hosts.join('\n') ?? '',
    includePaths: scopeRules?.includePaths?.join('\n') ?? '',
    excludePaths: scopeRules?.excludePaths?.join('\n') ?? '',
  };
}

export function fieldsToScopeRules(fields: { hosts: string; includePaths: string; excludePaths: string }): ScopeRules {
  const includePaths = parseListField(fields.includePaths);
  const excludePaths = parseListField(fields.excludePaths);
  return {
    hosts: parseListField(fields.hosts),
    ...(includePaths.length > 0 ? { includePaths } : {}),
    ...(excludePaths.length > 0 ? { excludePaths } : {}),
  };
}
