// ESLint flat config (ESLint 10 / typescript-eslint 8).
//
// Goals:
// - Run real lint rules (NOT a `tsc --noEmit` stub) over `src/` and `tests/`.
// - Keep `@typescript-eslint/no-explicit-any` ENABLED so the existing
//   `eslint-disable-next-line @typescript-eslint/no-explicit-any -- ...`
//   directives in `rest.client.ts` / `auth-rest.client.ts` are real
//   (not dead) suppressions, justified by their inline comments which
//   explain that the `any` defaults mirror the upstream `HttpService`
//   generic signatures (changing them to `unknown` would break the
//   public API surface).
// - Use the recommended typescript-eslint rule set as the baseline so
//   the lint script catches real issues (unused variables, unsafe
//   patterns, etc.) without requiring per-file opt-in.
// - Skip generated / vendored output (`dist`, `coverage`, `node_modules`,
//   `stryker-tmp`, `reports`).

const tsParser = require('@typescript-eslint/parser')
const tsPlugin = require('@typescript-eslint/eslint-plugin')

module.exports = [
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'stryker-tmp/**',
      'reports/**',
      'dist-test/**',
    ],
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        // Node + Jest globals used in this codebase. Listed explicitly
        // (instead of pulling in `globals` package) so the config has
        // zero runtime deps beyond eslint + typescript-eslint.
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        jest: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // Baseline recommendations from typescript-eslint (non-type-checked
      // tier — keeps lint fast and avoids requiring a TS Program load
      // separate from `tsc --noEmit` / Jest).
      ...tsPlugin.configs.recommended.rules,

      // Tests intentionally use a few `any` casts to coerce mock factories
      // into the upstream generic surfaces. Production code keeps every
      // `any` accompanied by a justification comment (see rest.client.ts).
      // The rule stays enabled by default (from the recommended set);
      // we only relax `no-unused-vars` to allow leading-underscore
      // intentional placeholders, matching common project conventions.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          // Allow conventional single-uppercase-letter type parameters
          // (e.g. `RetryConfig<T, S = void>`) to remain declared even when
          // unused inside the body. They are part of the public type
          // surface (documented in README) and removing them would be a
          // breaking change for downstream callers passing positional
          // type arguments. Matches `_`-prefixed locals as well.
          varsIgnorePattern: '^(_|[A-Z]$)',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Re-asserted from the recommended set as `error` (the recommended
      // tier already sets it; named explicitly here to make the project
      // intent unambiguous given that `rest.client.ts` and
      // `auth-rest.client.ts` carry justified `eslint-disable-next-line`
      // directives that depend on the rule being active).
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Test files reuse `any` casts for mock plumbing far more freely
    // than production code (e.g. `jest.fn() as any` to satisfy the
    // upstream generic erasure). Disabling the rule in the test surface
    // ONLY — production code still enforces it — keeps the lint signal
    // valuable where it matters without forcing dozens of disable
    // comments on test scaffolding.
    files: [
      'src/**/__tests__/**/*.ts',
      'src/**/*.spec.ts',
      'tests/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
]
