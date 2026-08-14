import type { ScanCredentials } from '@corvid/tool-contracts';

import type { CredentialsFormState } from '@/components/scans/credentials-fields';

/** Parse `Header-Name: value` lines (one per line) into a headers record, e.g. for IDOR sessions. */
export function parseHeaderLines(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) {
      continue;
    }
    const name = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (name.length > 0 && value.length > 0) {
      headers[name] = value;
    }
  }
  return headers;
}

/** Build the `ScanCredentials` payload from the scan-config form's UI state — `undefined` fields
 * are omitted entirely rather than sent empty, matching every credential being optional. */
export function credentialsFromFormState(state: CredentialsFormState): ScanCredentials | undefined {
  const credentials: {
    crawlLogin?: { loginUrl: string; username: string; password: string };
    jwtSample?: string;
    idorSessions?: {
      primary: { label: string; headers: Record<string, string> };
      secondary: { label: string; headers: Record<string, string> };
    };
  } = {};

  if (state.useCrawlLogin && state.loginUrl.length > 0 && state.username.length > 0 && state.password.length > 0) {
    credentials.crawlLogin = { loginUrl: state.loginUrl, username: state.username, password: state.password };
  }
  if (state.useJwt && state.jwtSample.length > 0) {
    credentials.jwtSample = state.jwtSample;
  }
  if (state.useIdor) {
    const primaryHeaders = parseHeaderLines(state.primaryHeaders);
    const secondaryHeaders = parseHeaderLines(state.secondaryHeaders);
    if (state.primaryLabel.length > 0 && state.secondaryLabel.length > 0) {
      credentials.idorSessions = {
        primary: { label: state.primaryLabel, headers: primaryHeaders },
        secondary: { label: state.secondaryLabel, headers: secondaryHeaders },
      };
    }
  }

  return Object.keys(credentials).length > 0 ? credentials : undefined;
}
