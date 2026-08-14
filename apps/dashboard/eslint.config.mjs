import base from '@corvid/eslint-config/base';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

// Dashboard lint config: the shared base (CODING_STANDARDS §1/§5/§13) plus Next.js's
// core-web-vitals rules and the React Hooks rules-of-hooks/exhaustive-deps checks.
export default [
  ...base,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  nextPlugin.configs['core-web-vitals'],
  reactHooks.configs.flat.recommended,
  {
    // Next.js's App Router requires a default export for these framework-convention files
    // (route segment config), same rationale as the existing *.config.* exemption above.
    files: [
      'src/app/**/page.tsx',
      'src/app/**/layout.tsx',
      'src/app/**/loading.tsx',
      'src/app/**/error.tsx',
      'src/app/**/not-found.tsx',
      'src/app/**/global-error.tsx',
      'src/app/**/default.tsx',
      'src/app/**/template.tsx',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    ignores: ['.next/**', 'next-env.d.ts'],
  },
];
