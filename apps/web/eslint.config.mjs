import base from '@corvid/eslint-config/base';
import astro from 'eslint-plugin-astro';
import globals from 'globals';

// Landing-site lint config: the shared Corvid base (CODING_STANDARDS §1/§5/§13 —
// named exports, no-console, no interpolated log calls) plus eslint-plugin-astro's
// recommended flat config, which supplies the `.astro` parser and template rules.
export default [
  ...base,
  ...astro.configs.recommended,
  {
    files: ['**/*.{ts,tsx,astro}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    ignores: ['dist/**', '.astro/**'],
  },
];
