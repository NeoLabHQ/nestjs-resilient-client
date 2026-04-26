import type { Config } from 'jest'

// `module.exports = config` (instead of `export = config`) is required because
// `jest-it-up` (the `posttest:unit` step) loads this file via Node's
// `require()` — Node's strip-only TypeScript loader rejects `export =`
// syntax. `module.exports =` is the interchangeable form ts-jest also accepts.
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/src/**/__tests__/**/*.spec.ts'],
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.test.json',
    },
  },
  collectCoverage: false,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'json-summary'],
  coverageThreshold: {
    global: {
      branches: 98.93,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/__tests__/**', '!src/**/*.spec.ts'],
}

module.exports = config
