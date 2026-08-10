import js from '@eslint/js';
import security from 'eslint-plugin-security';
import tseslint from 'typescript-eslint';

/**
 * Shared flat ESLint config for every Corvid workspace package.
 *
 * Type-aware linting is intentionally NOT enabled here: it requires a per-package
 * `parserOptions.project` and slows every lint run. Packages that need type-aware
 * rules opt in locally. The security plugin is on by default because Corvid's own
 * code handles credentials and sends payloads — its anti-patterns matter here.
 */
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  security.configs.recommended,
  {
    // Named-exports rule is TS source only (CODING_STANDARDS §1 is scoped to TS). Tooling
    // config files (eslint.config.mjs, next.config, …) legitimately require a default export.
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // Default exports rename silently on import and hurt cross-package search.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Named exports only (CODING_STANDARDS §1) — no default exports.',
        },
        {
          selector: 'ExportNamedDeclaration > ExportSpecifier[exported.name="default"]',
          message: 'Named exports only (CODING_STANDARDS §1) — no `export { x as default }`.',
        },
        // Redaction never scrubs the message string (CODING_STANDARDS §5), so a secret templated
        // into a log message leaks. Force values through the structured-fields argument instead.
        {
          selector:
            'CallExpression[callee.property.name=/^(?:fatal|error|warn|info|debug|trace)$/] > TemplateLiteral[expressions.length>0]',
          message:
            'No interpolated template literals in a log call (CODING_STANDARDS §5) — pass values as structured fields; redaction cannot scrub the message string.',
        },
        {
          selector:
            'CallExpression[callee.property.name=/^(?:fatal|error|warn|info|debug|trace)$/] > BinaryExpression[operator="+"]',
          message:
            'No string concatenation in a log call (CODING_STANDARDS §5) — pass values as structured fields; redaction cannot scrub the message string.',
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      // All logging goes through the shared structured logger (CODING_STANDARDS §13); a stray
      // console.* bypasses redaction and the audit/log separation. Enforced, not reviewed.
      'no-console': 'error',
      // eslint-plugin-security's detect-object-injection is high-noise/low-signal: it flags every
      // computed-member access (incl. safe Object.entries rebuilds) and can't tell a real sink from
      // a benign one. Kept off repo-wide; the rest of the security plugin stays on.
      'security/detect-object-injection': 'off',
    },
  },
  {
    // Config files (drizzle.config.ts, next.config.ts, …) require a default export by framework
    // convention; exempt them from the named-exports-only rule.
    files: ['**/*.config.{ts,mts,cts,js,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    ignores: ['dist/**'],
  },
);
