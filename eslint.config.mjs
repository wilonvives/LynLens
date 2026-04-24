/**
 * Flat ESLint config (ESLint 9+).
 *
 * Goals, minimal and pragmatic:
 *   1. Catch unused vars / imports that pile up over time
 *   2. Enforce `no-console` in renderer (Electron main is allowed to log)
 *   3. Flag stray `any` but don't error on the intentional ones we mark
 *      with `// eslint-disable-next-line` — see agent.ts / mcp-http-server.ts
 *      for real examples where SDK types force our hand
 *   4. Keep React-specific best practices for renderer code
 *
 * Formatting rules live in `.prettierrc` — we don't duplicate them here.
 * Run: `pnpm lint` (recursive) or `pnpm --filter @lynlens/desktop lint`.
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Shared rules for all TS/TSX code
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
      },
    },
    rules: {
      // Unused imports / vars — warn (they pile up, but don't block dev)
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Be strict about `any` but allow annotated escape hatches
      '@typescript-eslint/no-explicit-any': 'warn',
      // We use non-null assertion sparingly — warn, don't error
      '@typescript-eslint/no-non-null-assertion': 'off',
      // React hooks rules apply to all JSX/TSX files
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Prefer const, never var
      'prefer-const': 'warn',
      'no-var': 'error',
      // Empty catch blocks are suspicious
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
  {
    // Renderer code: console.log should raise a warning — it's easy to
    // ship debug logs to users. Main process is allowed to log to stderr
    // for diagnostics.
    files: ['packages/desktop/src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Tests can be noisy
    files: ['**/tests/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/release/**',
      '**/resources/**',
      '**/*.config.{js,mjs,cjs}',
      'eslint.config.mjs',
    ],
  }
);
