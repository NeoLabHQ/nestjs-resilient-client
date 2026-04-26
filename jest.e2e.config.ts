import type { Config } from 'jest'

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.spec.ts'],
  testTimeout: 60000,
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.test.json',
    },
  },
  globalSetup: './tests/e2e-setup.ts',
  globalTeardown: './tests/e2e-teardown.ts',
}

module.exports = config
