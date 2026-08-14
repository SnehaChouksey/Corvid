import { TbAlertCircle, TbClock, TbLock, TbShieldOff } from 'react-icons/tb';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { apiErrorMessage, isApiError } from '@/lib/api/client';

/**
 * Maps a query/mutation error to a truthful, specific panel (CODING_STANDARDS §10 / `01` §12):
 * 401 → sign-in (handled globally by apiFetch's redirect, this is the in-flight fallback),
 * 403 → forbidden, 404 → not found, 429 → rate-limited/cap. Never a raw error, never a spinner
 * that never resolves.
 */
export function ApiErrorPanel({ error, notFoundLabel = 'resource' }: { readonly error: unknown; readonly notFoundLabel?: string }) {
  if (isApiError(error)) {
    if (error.status === 404) {
      return (
        <Alert>
          <TbAlertCircle />
          <AlertTitle>Not found</AlertTitle>
          <AlertDescription>
            This {notFoundLabel} doesn&apos;t exist, or isn&apos;t yours.
          </AlertDescription>
        </Alert>
      );
    }
    if (error.status === 403) {
      return (
        <Alert variant="destructive">
          <TbShieldOff />
          <AlertTitle>Forbidden</AlertTitle>
          <AlertDescription>{apiErrorMessage(error.body, "You don't have access to do that.")}</AlertDescription>
        </Alert>
      );
    }
    if (error.status === 429) {
      const capBody = error.body as { readonly error?: string; readonly cap?: number } | undefined;
      if (capBody?.error === 'concurrent_scan_cap_reached') {
        return (
          <Alert variant="warning">
            <TbClock />
            <AlertTitle>Concurrent scan cap reached</AlertTitle>
            <AlertDescription>
              You already have {capBody.cap ?? 'the maximum number of'} scans running. Wait for one to
              finish, or cancel one, before starting another.
            </AlertDescription>
          </Alert>
        );
      }
      return (
      <Alert variant="warning">
        <TbClock />
        <AlertTitle>You&apos;re going too fast</AlertTitle>
          <AlertDescription>
            {error.retryAfterSeconds !== null
              ? `Try again in about ${error.retryAfterSeconds}s.`
              : 'Slow down and try again shortly.'}
          </AlertDescription>
        </Alert>
      );
    }
    if (error.status === 401) {
      return (
        <Alert>
          <TbLock />
          <AlertTitle>Sign-in required</AlertTitle>
          <AlertDescription>Redirecting you to sign in…</AlertDescription>
        </Alert>
      );
    }
    return (
      <Alert variant="destructive">
        <TbAlertCircle />
        <AlertTitle>Something went wrong</AlertTitle>
        <AlertDescription>{apiErrorMessage(error.body, 'The gateway returned an unexpected error.')}</AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="destructive">
      <TbAlertCircle />
      <AlertTitle>Something went wrong</AlertTitle>
      <AlertDescription>Couldn&apos;t reach Corvid&apos;s gateway. Check your connection and retry.</AlertDescription>
    </Alert>
  );
}
