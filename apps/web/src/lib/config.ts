// Auth links point at the dashboard app, a separate deployment from this
// marketing site (ADR-18: one monorepo, many deployables). Never hardcode
// these inline — every sign-in/sign-up link on the page imports from here so
// there is exactly one place to repoint at a different environment.
const APP_URL = import.meta.env.PUBLIC_APP_URL ?? 'https://app.corvid.security';

export const SIGN_IN_URL = `${APP_URL}/sign-in`;
export const SIGN_UP_URL = `${APP_URL}/sign-up`;
