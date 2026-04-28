import type { Config } from 'jest'

const config: Config = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.spec.ts'],
  testTimeout: 60000,
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        // Same inline overrides as jest.config.ts — see that file for rationale.
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
  globalSetup: './tests/e2e-setup.ts',
  globalTeardown: './tests/e2e-teardown.ts',
}

module.exports = config
