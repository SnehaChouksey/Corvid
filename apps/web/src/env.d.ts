/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Base URL of the separately deployed dashboard/auth app. See src/lib/config.ts. */
  readonly PUBLIC_APP_URL?: string;
}
