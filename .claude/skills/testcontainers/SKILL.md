---
name: Testcontainers - DockerComposeEnvironment with Jest
description: Guide for using testcontainers DockerComposeEnvironment to manage infrastructure in Jest e2e tests. Covers globalSetup/globalTeardown integration, wait strategies, container connection info extraction, TypeScript usage, and Minio-specific setup.
---

# Testcontainers - DockerComposeEnvironment with Jest

## Overview

`testcontainers` provides programmatic Docker container lifecycle management for tests. This skill focuses on using `DockerComposeEnvironment` to start the project's `docker-compose.yaml` services (including Minio) inside Jest e2e tests via `globalSetup` and `globalTeardown`. The environment starts once before all tests and tears down after, making infrastructure available for the entire test run.

---

## Key Concepts

- **DockerComposeEnvironment**: Starts services defined in a docker-compose file; supports wait strategies, partial startup, environment variable overrides
- **globalSetup**: Jest configuration option pointing to a module that exports `setup()` and `teardown()` functions - runs once before all test files in a separate process
- **globalTeardown**: Jest configuration option pointing to a module that exports a teardown function - runs once after all test files
- **Wait.forLogMessage(msg)**: Wait strategy that polls container logs until a regex or string appears
- **Wait.forHealthCheck()**: Wait strategy that uses the service's docker-compose healthcheck
- **getMappedPort(port)**: Returns the host port mapped to the given container port
- **getHost()**: Returns the host address for the container (typically `localhost` in most environments)
- **environment.down()**: Stops and removes all containers started by the environment

---

## Documentation & References

| Resource | Description | Link |
|----------|-------------|------|
| Testcontainers Node - Compose | DockerComposeEnvironment API | https://node.testcontainers.org/features/compose/ |
| Testcontainers Node - Global Setup | globalSetup pattern with Vitest/Jest | https://node.testcontainers.org/quickstart/global-setup/ |
| Jest - globalSetup | Jest configuration for global setup | https://jestjs.io/docs/configuration#globalsetup-string |
| Testcontainers Node npm | Package | https://www.npmjs.com/package/testcontainers |

---

## Recommended Libraries & Tools

| Name | Purpose | Maturity | Notes |
|------|---------|----------|-------|
| `testcontainers` | Core container management | Stable (11.13.0) | Includes DockerComposeEnvironment |
| `@testcontainers/minio` | Minio-specific module | Check availability | Alternative to generic DockerCompose |

### Recommended Stack

Use `testcontainers@11.13.0` with `DockerComposeEnvironment` pointing at the project's `docker-compose.yaml`. Configure Jest `jest.e2e.config.js` with `globalSetup` and `globalTeardown` paths.

---

## Patterns & Best Practices

### Pattern 1: globalSetup + globalTeardown with DockerComposeEnvironment

**When to use**: E2E tests that require real infrastructure (Minio, databases) started once for the entire test suite.

**Critical constraint**: `globalSetup` runs in a completely separate Node.js process from the test files. Variables set in `globalSetup` are NOT accessible in tests via normal module scope. Use `process.env` to pass connection info to tests.

```typescript
// test/e2e-global-setup.ts
import path from 'node:path'
import { DockerComposeEnvironment, Wait } from 'testcontainers'
import type { StartedDockerComposeEnvironment } from 'testcontainers'

let environment: StartedDockerComposeEnvironment

export async function setup(): Promise<void> {
  const composeFilePath = path.resolve(__dirname, '..')
  environment = await new DockerComposeEnvironment(composeFilePath, 'docker-compose.yaml')
    .withWaitStrategy('minio-1', Wait.forHealthCheck())
    .up(['minio'])  // Start only services needed for tests

  const minioContainer = environment.getContainer('minio-1')
  // Pass connection info to tests via process.env
  process.env.S3_ENDPOINT = `http://${minioContainer.getHost()}:${minioContainer.getMappedPort(9000)}`
  process.env.S3_ACCESS_KEY_ID = 'minioadmin'
  process.env.S3_SECRET_ACCESS_KEY = 'minioadmin'
  process.env.S3_BUCKET = 'analytics-data'
  process.env.S3_REGION = 'us-east-1'
}

export async function teardown(): Promise<void> {
  await environment?.down({ timeout: 10_000, removeVolumes: true })
}
```

**Note on service container name**: Docker Compose appends `-1` (or the scale index) to the service name. A service named `minio` in docker-compose becomes `minio-1` for `getContainer('minio-1')`.

### Pattern 2: Jest Config Integration

**When to use**: Configuring Jest e2e tests to use global setup.

```javascript
// test/jest.e2e.config.js
const baseConfig = require('./jest.config.js')

module.exports = {
  ...baseConfig,
  testRegex: '\\.e2e-spec\\.ts$',
  globalSetup: '<rootDir>/test/e2e-global-setup.ts',
  globalTeardown: '<rootDir>/test/e2e-global-teardown.ts',
  setupFiles: [...(baseConfig.setupFiles ?? []), '<rootDir>/test/e2e-env-setup.ts'],
}
```

**TypeScript globalSetup**: Jest supports TypeScript globalSetup files via `ts-jest` transformer. Ensure `ts-jest` is configured in the base jest.config.js (it is in this project).

However, `globalSetup` / `globalTeardown` are loaded directly by Jest without the TypeScript transform. Options:

**Option A: Separate setup and teardown files** (simplest, avoids shared state):
```javascript
// test/e2e-global-setup.ts - uses ts-node to run
```

**Option B: Use `ts-node` for TypeScript globalSetup** - configure ts-node in jest config or use `@swc/jest`:
```javascript
// In jest.e2e.config.js - if ts-jest handles globalSetup
// Note: ts-jest does NOT transform globalSetup by default
// Use direct js compilation or add "transform" for globalSetup
```

**Option C: Compile TS to JS first** (most reliable for CI):
```javascript
globalSetup: '<rootDir>/dist/test/e2e-global-setup.js',
```

**Recommended for this project** (ts-jest already configured): Use `.ts` files for globalSetup but ensure `ts-node` is registered or use the `--require ts-node/register` pattern. Alternatively, write globalSetup as a `.js` file wrapping a compiled `.ts` module.

### Pattern 3: Wait Strategies

**When to use**: Services take time to initialize after docker start; without wait strategies tests may run before the service is ready.

```typescript
new DockerComposeEnvironment(path, file)
  // Wait for a log message (reliable for services that log "ready"):
  .withWaitStrategy('minio-1', Wait.forLogMessage('API'))

  // Wait for docker-compose healthcheck to pass (requires healthcheck in compose file):
  .withWaitStrategy('minio-1', Wait.forHealthCheck())

  // Wait for HTTP endpoint to return 2xx:
  .withWaitStrategy('service-1', Wait.forHttp('/health', 8080).forStatusCode(200))
```

### Pattern 4: Starting Only Specific Services

**When to use**: Full docker-compose has many services but e2e tests only need Minio.

```typescript
const environment = await new DockerComposeEnvironment(path, 'docker-compose.yaml')
  .withWaitStrategy('minio-1', Wait.forHealthCheck())
  .up(['minio'])  // Only start minio service
```

Note: Also starts any services that `minio` depends on (via `depends_on`).

### Pattern 5: Environment Variable Overrides

**When to use**: Override docker-compose environment variables for test-specific configuration.

```typescript
const environment = await new DockerComposeEnvironment(path, 'docker-compose.yaml')
  .withEnvironment({ MINIO_ROOT_USER: 'testuser', MINIO_ROOT_PASSWORD: 'testpass' })
  .up(['minio'])
```

---

## Similar Implementations

### Example 1: Redis Global Setup (Vitest)

- **Source**: https://node.testcontainers.org/quickstart/global-setup/
- **Approach**: `setup()` starts container, stores in `globalThis`, `teardown()` stops it
- **Applicability**: Direct template for Minio setup; swap `RedisContainer` for `DockerComposeEnvironment`

---

## Common Pitfalls & Solutions

| Issue | Impact | Solution |
|-------|--------|----------|
| globalSetup variables not visible in test files | High | Use `process.env` to pass connection info; `globalThis` only visible in `globalTeardown` |
| `getContainer('minio')` throws | High | Service name in compose is `minio`, but container name is `minio-1` (with index) |
| TypeScript globalSetup not transformed by ts-jest | High | Write globalSetup in JS, or use ts-node/register, or compile TS first |
| Container not ready when tests run | High | Add `.withWaitStrategy('minio-1', Wait.forHealthCheck())` |
| S3 bucket not pre-created when service starts | Medium | Add minio-init service in docker-compose with `depends_on` + `condition: service_healthy` |
| Timeout on environment.down() | Low | Pass `{ timeout: 10_000 }` to down(); default may wait indefinitely |
| Docker compose `secrets` in compose file | Medium | testcontainers may reject compose files with unsupported options; remove secrets or use override file |

---

## Recommendations

1. **Use `Wait.forHealthCheck()`**: Requires a `healthcheck` in the docker-compose service definition. This is the most reliable wait strategy for Minio.
2. **Pass connection info via `process.env`**: This is the only way to share data from `globalSetup` to test files (they run in separate processes).
3. **Start only needed services with `.up(['service'])`**: Avoid starting the full stack in e2e tests to reduce startup time.
4. **Store environment in module-level variable**: The `globalSetup` and `globalTeardown` can share state if exported from the same module - reference the environment instance for teardown.

---

## Implementation Guidance

### Jest e2e Config Update

```javascript
// test/jest.e2e.config.js
const baseConfig = require('./jest.config.js')

module.exports = {
  ...baseConfig,
  testRegex: '\\.e2e-spec\\.ts$',
  globalSetup: '<rootDir>/test/e2e-global-setup.ts',
  setupFiles: [...(baseConfig.setupFiles ?? []), '<rootDir>/test/e2e-env-setup.ts'],
}
```

### e2e-env-setup.ts Update

Add S3 environment variables with test defaults (overridden by globalSetup when containers are running):

```typescript
// test/e2e-env-setup.ts (additions)
process.env.S3_ENDPOINT ??= 'http://localhost:9000'
process.env.S3_ACCESS_KEY_ID ??= 'minioadmin'
process.env.S3_SECRET_ACCESS_KEY ??= 'minioadmin'
process.env.S3_BUCKET ??= 'analytics-data'
process.env.S3_REGION ??= 'us-east-1'
```

### Integration Points

- `globalSetup` starts Minio before any test file runs
- `process.env.S3_ENDPOINT` (and other vars) set by globalSetup are read by `e2e-env-setup.ts` via configify
- `teardown` (exported from globalSetup module or separate file) stops containers after all tests
- NestJS app in tests reads config from `process.env` populated by the setup chain

---

## Code Examples

### Example 1: Complete e2e-global-setup.ts

```typescript
import path from 'node:path'
import { DockerComposeEnvironment, Wait } from 'testcontainers'
import type { StartedDockerComposeEnvironment } from 'testcontainers'

let environment: StartedDockerComposeEnvironment | undefined

export async function setup(): Promise<void> {
  const composeFilePath = path.resolve(__dirname, '..')

  environment = await new DockerComposeEnvironment(composeFilePath, 'docker-compose.yaml')
    .withWaitStrategy('minio-1', Wait.forHealthCheck())
    .up(['minio', 'minio-init'])

  const minioContainer = environment.getContainer('minio-1')
  const minioHost = minioContainer.getHost()
  const minioPort = minioContainer.getMappedPort(9000)

  process.env.S3_ENDPOINT = `http://${minioHost}:${minioPort}`
  process.env.S3_ACCESS_KEY_ID = 'minioadmin'
  process.env.S3_SECRET_ACCESS_KEY = 'minioadmin'
  process.env.S3_BUCKET = 'analytics-data'
  process.env.S3_REGION = 'us-east-1'
}

export async function teardown(): Promise<void> {
  await environment?.down({ timeout: 10_000, removeVolumes: true })
}
```

### Example 2: Using Container Info in Tests

```typescript
// test/decision/evaluate-application.e2e-spec.ts
describe('AnalyticsInterceptor (e2e)', () => {
  it('persists analytics data to S3', async () => {
    // S3_ENDPOINT is set by globalSetup - use it to verify data was stored
    const s3Client = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      },
      forcePathStyle: true,
    })
    // Query S3 to verify analytics data was stored
  })
})
```

---

## Sources & Verification

| Source | Type | Last Verified |
|--------|------|---------------|
| https://node.testcontainers.org/features/compose/ | Official | 2026-03-27 |
| https://node.testcontainers.org/quickstart/global-setup/ | Official | 2026-03-27 |
| https://jestjs.io/docs/configuration#globalsetup-string | Official | 2026-03-27 |
| context7 /testcontainers/testcontainers-node (296 snippets, High) | Official mirror | 2026-03-27 |
| npm info testcontainers@11.13.0 | Registry | 2026-03-27 |

---

## Changelog

| Date | Changes |
|------|---------|
| 2026-03-27 | Initial creation for task: add-decision-data-saving |