import type { Config } from 'jest'

// `module.exports = config` (instead of `export = config`) is required because
// `jest-it-up` (the `posttest:unit` step) loads this file via Node's
// `require()` — Node's strip-only TypeScript loader rejects `export =`
// syntax. `module.exports =` is the interchangeable form ts-jest also accepts.
const config: Config = {
  testEnvironment: 'node',
  testMatch: ['**/src/**/__tests__/**/*.spec.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        // Inline compiler overrides allow Jest (CommonJS) to import TypeScript
        // source without a separate tsconfig file or bundler step.
        // `module`/`moduleResolution`/`verbatimModuleSyntax` are overridden so
        // Jest's CommonJS loader can resolve imports correctly.
        // `emitDecoratorMetadata` is disabled to prevent Istanbul from counting
        // the `typeof D !== "undefined"` guards emitted for generic method
        // parameters as uncoverable branches.
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'node',
          esModuleInterop: true,
          verbatimModuleSyntax: false,
          types: ['node', 'jest'],
          emitDecoratorMetadata: false,
        },
      },
    ],
  },
  collectCoverage: false,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'json-summary'],
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/__tests__/**', '!src/**/*.spec.ts'],
}

module.exports = config
