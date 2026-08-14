import { createAuthClient } from 'better-auth/react';

// Better Auth is mounted on the gateway at `/api/auth/*`; the client's baseURL is the gateway's
// own origin (it appends `/api/auth` itself). Sessions are httpOnly cookies set cross-origin
// (dashboard and gateway are different origins in dev), so every client call must explicitly
// send/accept cookies — `fetchOptions.credentials` covers that for every method below.
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  fetchOptions: {
    credentials: 'include',
  },
});

export const { signIn, signUp, signOut, useSession } = authClient;
