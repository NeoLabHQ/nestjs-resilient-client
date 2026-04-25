---
name: NestJS Jest Testing
description: Complete guide for setting up Jest unit tests, e2e tests, Stryker mutation testing, jest-it-up coverage bumping, tsx smoke tests, and reusable GitHub Actions verify workflows in NestJS TypeScript projects.
---

# NestJS Jest Testing

## Overview

This skill covers the full test setup for NestJS TypeScript projects using Jest + ts-jest, with separate configs for unit and e2e tests, Stryker for mutation coverage (80% break threshold), jest-it-up for auto-bumping coverage thresholds, tsx-based smoke tests, and a reusable GitHub Actions verify workflow.

---

## Key Concepts

- **ts-jest**: Transforms TypeScript for Jest without a separate compile step; uses the project's tsconfig.json
- **Unit tests**: Use constructor injection mocks — no import mocking, dependencies passed via DI
- **E2e tests**: Boot the full NestJS module with `Test.createTestingModule({ imports: [AppModule] })` + supertest
- **Stryker**: Runs Jest on mutated code; `break: 80` exits with code 1 if mutation score drops below 80%
- **jest-it-up**: Reads `coverage/coverage-summary.json` after tests and bumps jest.config thresholds upward
- **Smoke tests**: `npx tsx smoke-tests/smoke-test.ts` — runs against a live service URL from `SERVICE_URL` env var
- **Reusable workflow**: `on: workflow_call:` allows verify.yml to be called from other workflows

---

## Documentation & References

| Resource | Description | Link |
|----------|-------------|------|
| Jest Configuration | coverageThreshold, collectCoverageFrom, reporters | https://jestjs.io/docs/configuration |
| ts-jest Getting Started | Installation, preset options, tsconfig | https://kulshekhar.github.io/ts-jest/docs/getting-started/installation |
| NestJS Testing Guide | createTestingModule, overrideProvider, e2e setup | https://docs.nestjs.com/fundamentals/testing |
| Stryker Configuration | testRunner, checkers, thresholds, mutate | https://stryker-mutator.io/docs/stryker-js/configuration/ |
| Stryker Jest Runner | Jest-specific config options | https://stryker-mutator.io/docs/stryker-js/jest-runner/ |
| Stryker TypeScript Checker | Type-safe mutation filtering | https://stryker-mutator.io/docs/stryker-js/typescript-checker/ |
| jest-it-up | Auto-bumping coverage thresholds | https://github.com/rbardini/jest-it-up |
| tsx | Fast TypeScript executor for scripts | https://tsx.is/ |
| GitHub Reusable Workflows | workflow_call trigger and usage | https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows |

---

## Recommended Libraries & Tools

| Name | Purpose | Maturity | Notes |
|------|---------|----------|-------|
| `jest` | Test runner | Stable (v29.7) | Core testing framework |
| `ts-jest` | TS transformer for Jest | Stable (v29.2) | CommonJS preset for this project |
| `@types/jest` | Type declarations for Jest | Stable (v29.5) | Required for TypeScript tests |
| `@nestjs/testing` | NestJS test module | Stable (v11) | createTestingModule, overrideProvider |
| `supertest` | HTTP assertions for e2e | Stable (v7) | Works with NestJS app instance |
| `@types/supertest` | Type declarations | Stable (v6) | Required for TypeScript e2e tests |
| `jest-it-up` | Auto-bump coverage thresholds | Stable (v4.0.1) | Requires json-summary coverageReporter |
| `@stryker-mutator/core` | Mutation testing engine | Stable (v8) | Core package |
| `@stryker-mutator/jest-runner` | Jest integration for Stryker | Stable (v8) | Matches project's jest setup |
| `@stryker-mutator/typescript-checker` | Type-safe mutation filtering | Stable (v8) | Filters type-invalid mutants before test run |
| `tsx` | TypeScript script executor | Stable (v4) | Used via npx for smoke tests |

### Recommended Stack

Use `jest` + `ts-jest` (CommonJS preset) for both unit and e2e tests, with separate config files. Use `@nestjs/testing` for all test modules. Add `jest-it-up` as a posttest script for unit tests only. Use `@stryker-mutator` with jest runner and TypeScript checker for mutation testing.

---

## Patterns & Best Practices

### Pattern 1: Unit Test with Constructor Injection Mocks

**When to use**: Testing any NestJS service with injected dependencies. No import mocking — pass fake implementations via constructor.

**Trade-offs**: Requires services to be refactored to inject external clients (Pool, GraphQLClient) if they create them internally.

```typescript
// src/consent/__tests__/queue-processor.service.spec.ts
import { QueueProcessorService } from '../queue-processor.service'

const mockPgmqService = {
  readMessage: jest.fn(),
  deleteMessage: jest.fn(),
}

const mockConsentClient = {
  saveConsent: jest.fn(),
}

describe('QueueProcessorService', () => {
  let service: QueueProcessorService

  beforeEach(() => {
    jest.clearAllMocks()
    service = new QueueProcessorService(
      mockPgmqService as any,
      mockConsentClient as any,
    )
  })

  it('processes a message successfully', async () => {
    mockPgmqService.readMessage.mockResolvedValueOnce({ msg_id: '1', message: {} })
    // ...assert saveConsent and deleteMessage called
  })
})
```

### Pattern 2: E2e Test with AppModule and supertest

**When to use**: Integration testing the full NestJS application over HTTP.

**Critical**: Set `process.env` vars in a `setupFiles` script before the module boots — configify validates at init time, before `overrideProvider()` takes effect. See [E2E Testing with Configify in the configify skill](../../skills/configify/SKILL.md).

```typescript
// tests/app.e2e.spec.ts
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import * as request from 'supertest'
import { AppModule } from '../src/app.module'

describe('AppController (e2e)', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SomeService)
      .useValue(mockSomeService)
      .compile()

    app = moduleFixture.createNestApplication()
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('/health (GET)', () =>
    request(app.getHttpServer()).get('/health').expect(200))
})
```

### Pattern 3: Smoke Test with tsx

**When to use**: Verifying a live deployed service responds correctly to health checks.

```typescript
// smoke-tests/smoke-test.ts
const SERVICE_URL = process.env.SERVICE_URL
if (!SERVICE_URL) {
  console.error('SERVICE_URL environment variable is required')
  process.exit(1)
}

const checkEndpoint = async (path: string, expectedStatus = 200) => {
  const response = await fetch(`${SERVICE_URL}${path}`)
  if (response.status !== expectedStatus) {
    throw new Error(`${path} returned ${response.status}, expected ${expectedStatus}`)
  }
  console.log(`✓ ${path} - ${response.status}`)
}

const runSmokeTests = async () => {
  try {
    await checkEndpoint('/health')
    await checkEndpoint('/health/liveness')
    await checkEndpoint('/health/readiness')
    console.log('All smoke tests passed')
  } catch (error) {
    console.error('Smoke test failed:', error)
    process.exit(1)
  }
}

runSmokeTests()
```

### Pattern 4: Separate Jest Configs (Unit vs E2e)

**When to use**: Always — unit and e2e tests have different roots, patterns, setup files, and timeouts.

```typescript
// jest.config.ts (unit)
import type { Config } from 'jest'

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.spec.ts'],
  collectCoverage: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/__tests__/**',
    '!src/generated/**',
    '!src/main.ts',
    '!src/**/*.module.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html', 'json-summary'],
  coverageProvider: 'v8',
  coverageThreshold: {
    global: { branches: 80, functions: 80, lines: 80, statements: 80 },
  },
}

export default config
```

```typescript
// jest.e2e.config.ts (e2e)
import type { Config } from 'jest'

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.spec.ts'],
  setupFiles: ['./tests/e2e-env-setup.ts'],
  testTimeout: 30000,
}

export default config
```

### Pattern 5: E2e Environment Setup File

**When to use**: Required when using @itgorillaz/configify — env vars must be set before module bootstrap.

Allways use `=` instead of `??=` to set env vars in the setup file. Test file should be predictable and not depend on the presence of a local `.env` file.

```typescript
// tests/e2e-env-setup.ts
// Set required env vars before NestJS module bootstraps.
// Use = so real values from .env or CI are always overwritten.
process.env.PGMQ_POSTGRES_URL = 'postgresql://test:test@localhost:5432/test'
process.env.CONSENT_SERVICE_GRAPHQL_URL = 'http://localhost:8080/v1/graphql'
process.env.PORT = '3001'
```

---

## Stryker Configuration

```json
// stryker.config.json
{
  "testRunner": "jest",
  "coverageAnalysis": "perTest",
  "jest": {
    "projectType": "custom",
    "configFile": "jest.config.ts"
  },
  "checkers": ["typescript"],
  "tsconfigFile": "tsconfig.json",
  "mutate": [
    "src/**/*.ts",
    "!src/**/__tests__/**/*.ts",
    "!src/generated/**",
    "!src/main.ts",
    "!src/**/*.module.ts"
  ],
  "reporters": ["html", "text", "progress"],
  "thresholds": { "high": 80, "low": 60, "break": 80 }
}
```

**break: 80** means Stryker exits with code 1 if mutation score drops below 80%, blocking CI.

---

## Package.json Scripts

```json
{
  "scripts": {
    "test:unit": "jest --config jest.config.ts",
    "posttest:unit": "jest-it-up",
    "test:e2e": "jest --config jest.e2e.config.ts",
    "test:mutation": "stryker run",
    "test:smoke-local": "bash smoke-tests/run-smoke-tests-local.sh",
    "test": "npm run test:unit && npm run test:e2e && npm run test:smoke-local"
  }
}
```

Note: `jest-it-up` runs as `posttest:unit` (not `posttest`) to avoid running after e2e/smoke.

---

## GitHub Actions: Reusable Workflow Pattern

```yaml
# .github/workflows/verify-reusable.yml
name: Verify (Reusable)

on:
  workflow_call:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'npm'
      - run: npm ci
      - run: npm run codegen
        env:
          CONSENT_SERVICE_GRAPHQL_URL: ${{ vars.CONSENT_SERVICE_GRAPHQL_URL }}
      - run: npm run build
      - run: npm run lint
      - run: npm run test:unit
      - run: npm run test:e2e
```

```yaml
# .github/workflows/verify.yml (calls reusable)
name: Verify

on:
  pull_request:
    branches: [master]
    types: [opened, synchronize]

jobs:
  verify:
    uses: ./.github/workflows/verify-reusable.yml
```

```yaml
# .github/workflows/deploy-dev.yml (with verify gate)
jobs:
  verify:
    uses: ./.github/workflows/verify-reusable.yml
    secrets: inherit

  deploy:
    needs: [verify]
    runs-on: ubuntu-latest
    # ... deploy steps
```

---

## Common Pitfalls & Solutions

| Issue | Impact | Solution |
|-------|--------|----------|
| configify validates env vars before `overrideProvider()` in e2e tests | High | Set `process.env.VAR ??= 'value'` in `setupFiles` (see configify skill) |
| `pg.Pool` created inside constructor blocks unit testing | High | Refactor: inject `Pool` via constructor, or add `pool` parameter with default |
| `GraphQLClient` created inside constructor blocks unit testing | High | Refactor: inject `GraphQLClient` via constructor parameter |
| `jest-it-up` not updating thresholds | Medium | Ensure `json-summary` is in `coverageReporters` and `collectCoverage: true` |
| Stryker extremely slow | Medium | Use `coverageAnalysis: "perTest"` and add `--concurrency` option |
| E2e tests time out with default 5s | Medium | Set `testTimeout: 30000` in jest.e2e.config.ts |
| Smoke test fails silently | Medium | Always exit with `process.exit(1)` in catch block |
| `run-smoke-tests-local.sh` leaves service running | Low | Use `trap 'kill $PID' EXIT` to clean up |

---

## Smoke Test Local Runner Pattern

```bash
#!/bin/bash
# smoke-tests/run-smoke-tests-local.sh
set -e

echo "Starting service..."
npm run start &
SERVICE_PID=$!
trap 'kill $SERVICE_PID 2>/dev/null' EXIT

echo "Waiting for service to be ready..."
until curl -sf http://localhost:3000/health/liveness > /dev/null 2>&1; do
  sleep 1
done

echo "Running smoke tests..."
SERVICE_URL=http://localhost:3000 npx tsx smoke-tests/smoke-test.ts
```

---

## Similar Implementations

### NestJS official CLI generated test setup
- **Source**: NestJS CLI `nest new` scaffold
- **Approach**: Separate `jest` (unit) and `jest-e2e.json` (e2e) configs, `test/` folder for e2e
- **Applicability**: Direct match — this skill follows the same conventions

### Stryker Node.js guide
- **Source**: https://stryker-mutator.io/docs/stryker-js/guides/nodejs/
- **Approach**: `npx stryker init` generates config, jest runner with ts-jest preset
- **Applicability**: High — this project is a Node.js/NestJS service

---

## Sources & Verification

| Source | Type | Last Verified |
|--------|------|---------------|
| https://jestjs.io/docs/configuration | Official | 2026-04-23 |
| https://kulshekhar.github.io/ts-jest/docs/getting-started/installation | Official | 2026-04-23 |
| https://docs.nestjs.com/fundamentals/testing | Official | 2026-04-23 |
| https://stryker-mutator.io/docs/stryker-js/configuration/ | Official | 2026-04-23 |
| https://stryker-mutator.io/docs/stryker-js/jest-runner/ | Official | 2026-04-23 |
| https://github.com/rbardini/jest-it-up | Official | 2026-04-23 |
| https://tsx.is/ | Official | 2026-04-23 |
| https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows | Official | 2026-04-23 |

---

## Changelog

| Date | Changes |
|------|---------|
| 2026-04-23 | Initial creation for task: Add unit tests and smoke tests |