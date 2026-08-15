// Auth links point at the dashboard app, a separate deployment from this
// marketing site (ADR-18: one monorepo, many deployables). The dashboard
// origin is environment-specific, so it comes from PUBLIC_APP_URL at build
// time — deployed environments must set it to the real dashboard origin. The
// default is the local dev port so `dev`/`build` work without a .env; no
// specific environment's URL is hardcoded in a link. Every sign-in/sign-up
// link imports from here, so there is exactly one place to repoint.
const APP_URL = import.meta.env.PUBLIC_APP_URL ?? 'http://localhost:3024';

export const SIGN_IN_URL = `${APP_URL}/sign-in`;
export const SIGN_UP_URL = `${APP_URL}/sign-up`;
