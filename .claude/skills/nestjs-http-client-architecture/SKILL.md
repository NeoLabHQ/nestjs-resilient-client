---
name: NestJS HTTP Client Architecture
description: Architecture patterns, decorator design, and testing setup for the nestjs-http-client library — RestClient, AuthRestClient, AuthStrategyService, @ExecuteWithPolicy, @Authenticate, and the jest/Stryker/testcontainers test stack.
topics: nestjs, http-client, base-decorators, cockatiel, jest, stryker, testcontainers, resilience, authentication, decorators
created: 2026-04-26
updated: 2026-04-26
scratchpad: .specs/scratchpad/8f110da9.md
---

# NestJS HTTP Client Architecture

## Overview

This skill documents the architecture of the `nestjs-http-client` library. The library wraps `@nestjs/axios`'s `HttpService` with a cockatiel resilience policy stack. It exposes two clients: `RestClient` (resilient HTTP client) and `AuthRestClient` (authenticated HTTP client). Decorator logic uses `base-decorators@1.1.0` primitives (`Wrap`, `OnErrorHook`, `Effect`). Testing uses jest@29 + ts-jest, Stryker v8, jest-it-up, and testcontainers.

---

## Current State vs Target State

**CRITICAL**: The codebase is currently in a **broken initial draft state**. The skill describes the TARGET architecture — not the current state. Implementors must be aware of all broken items before writing any code.

### Current State (broken)

- `HttpClient` (`src/client/http.client.ts`) — exists, uses `executeRequest` private method (not yet a decorator)
- `AuthenticatedHttpService` (`src/auth/authenticated-http.service.ts`) — exists, uses `p-retry` + Observable + `firstValueFrom` + rigid 4-field `AuthConfig`
- `src/deduplicate-inflight.decorator.ts` — exists but **broken**: imports `KeyBuilder` from `./cache.decorator` which **does not exist**
- `src/deduplicate-inflight.decorator.spec.ts` — exists but **broken**: uses `@/cache/...` path alias which **is not configured** in `tsconfig.json`
- `tests/index.test.ts` — **broken**: imports `fn` from `'../src'` which is **not exported** from `src/index.ts`
- `base-decorators` — **NOT installed** (not in `package.json`, not in `node_modules`)
- `jest`, `ts-jest`, `@types/jest` — **NOT installed** (vitest@^4.0.16 is installed instead)
- `jest-it-up`, `@stryker-mutator/*`, `testcontainers` — **NOT installed**
- `tsconfig.json` has **no `paths` field** — path aliases like `@/cache` are not configured

### Target State (to be built)

- `RestClient` replaces `HttpClient`; `@ExecuteWithPolicy` decorator (via `Wrap`) replaces the private `executeRequest` method
- `AuthRestClient` replaces `AuthenticatedHttpService`; uses `RestClient`, no rxjs/p-retry
- `AuthStrategyService` manages authentication lifecycle with `@DeduplicateInflight`
- `@Authenticate` decorator handles pre-flight auth and 401 re-auth
- `AuthRestModule` is a NestJS dynamic module with async factory
- Jest + ts-jest for unit and e2e tests; Stryker v8 for mutation; jest-it-up for coverage ratchet

---

## Key Concepts

- **RestClient**: Renamed from `HttpClient`. Thin wrapper around `HttpService` that runs requests through a cockatiel `IPolicy`. Has a `policy` property read by `@ExecuteWithPolicy`.
- **@ExecuteWithPolicy**: Method decorator using `Wrap` from `base-decorators`. Reads `this.policy` via `context.target.policy` and executes the request through `policy.execute()`.
- **AuthRestClient**: Renamed from `AuthenticatedHttpService`. Uses `RestClient` internally, decorated with `@Authenticate`. No direct use of observables, p-retry, or firstValueFrom.
- **AuthStrategyService**: New service that receives `AuthConfig`. Manages authentication state, exposes `isAuthenticated()`, `authenticateIfNeeded()`, `extendRequest()`. Uses `@DeduplicateInflight` to prevent parallel auth calls.
- **@Authenticate**: Method decorator using `Wrap` from `base-decorators`. Calls `authenticateIfNeeded()`, extends config arg via `extendRequest()`, and retries on 401.
- **AuthConfig**: Simplified to a single `authenticate(client: RestClient)` async factory that returns `{ extendRequest, isAuthenticated }`.
- **AuthRestModule**: Dynamic NestJS module with async factory to build `AuthConfig` + `HttpService`, optional `ResilanceConfig`.

---

## Documentation & References

| Resource | Description | Link |
|----------|-------------|------|
| base-decorators README | Wrap, Effect, OnErrorHook, OnInvokeHook API | https://github.com/NeoLabHQ/base-decorators#readme |
| base-decorators npm | Package page with version history | https://www.npmjs.com/package/base-decorators |
| cockatiel README | IPolicy, wrap(), execute() API | https://github.com/connor4312/cockatiel#readme |
| @nestjs/axios | HttpService, HttpModule | https://docs.nestjs.com/techniques/http-module |
| NestJS Dynamic Modules | forRootAsync pattern | https://docs.nestjs.com/fundamentals/dynamic-modules |
| jest config | coverageThreshold, ts-jest | https://jestjs.io/docs/configuration |
| jest-it-up | Auto-bump jest coverage thresholds | https://github.com/rbardini/jest-it-up |
| Stryker jest runner | Jest integration for Stryker v8 | https://stryker-mutator.io/docs/stryker-js/jest-runner/ |
| testcontainers GenericContainer | Single container API | https://node.testcontainers.org/features/containers/ |

---

## Recommended Libraries & Tools

| Name | Purpose | Status | Notes |
|------|---------|--------|-------|
| `base-decorators@1.1.0` | Decorator primitives (Wrap, Effect, hooks) | **MUST INSTALL** | Zero-dep; not in package.json yet |
| `cockatiel@3.2.1` | Resilience policies (retry, CB, bulkhead, fallback) | Already installed | In package.json dependencies |
| `axios@^1.14.0` | HTTP client | Already installed | In package.json dependencies |
| `jest@29.7` | Test runner (unit + e2e) | **MUST INSTALL** | Replace vitest; use ts-jest preset |
| `ts-jest@29` | TypeScript transformer for Jest | **MUST INSTALL** | Needs tsconfig.test.json |
| `@types/jest@29` | Type declarations for Jest | **MUST INSTALL** | Required for TS tests |
| `jest-it-up@4.0.1` | Auto-bump jest coverage thresholds | **MUST INSTALL** | Reads jest.config coverageThreshold |
| `@stryker-mutator/core@8` | Mutation testing engine | **MUST INSTALL** | v8 compatible with jest@29 |
| `@stryker-mutator/jest-runner@8` | Jest integration for Stryker | **MUST INSTALL** | Matches jest@29 |
| `@stryker-mutator/typescript-checker@8` | Type-safe mutation filtering | **MUST INSTALL** | Filters invalid mutants |
| `testcontainers@11.14.0` | Docker containers for e2e tests | **MUST INSTALL** | GenericContainer for single service |
| `vitest@^4.0.16` | Current test runner (to be replaced) | **MUST UNINSTALL** | Remove before installing jest |
| `p-retry@^7.1.1` | Retry library (to be removed from AuthRestClient) | Remove from auth | Still in package.json; not used after refactor |

### Recommended Stack

Use jest@29 + ts-jest (with a separate tsconfig.test.json using node moduleResolution) for both unit and e2e tests. Use `jest-it-up` as posttest:unit. Use Stryker v8 (not v9) + jest runner for mutation testing at 80% break threshold. Use `testcontainers` with `GenericContainer` (httpbin or echo-server image) for e2e dummy service.

**IMPORTANT**: The project uses `tsdown` with `moduleResolution: "bundler"` in tsconfig.json. Jest requires CommonJS + `moduleResolution: "node"`. Always create a separate `tsconfig.test.json` that overrides these settings.

---

## Patterns & Best Practices

### Pattern 1: @ExecuteWithPolicy Decorator

**When to use**: On all request methods in `RestClient`. Decorator reads `this.policy` from the class instance and executes the request through it.

**Key constraint**: The wrapped method receives the Observable from `HttpService`. Use `firstValueFrom` inside the policy executor.

```typescript
import { Wrap } from 'base-decorators'
import { firstValueFrom } from 'rxjs'
import type { IPolicy, IDefaultPolicyContext } from 'cockatiel'
import type { AxiosResponse } from 'axios'
import type { Observable } from 'rxjs'

const EXECUTE_WITH_POLICY_KEY: unique symbol = Symbol('executeWithPolicy')

// The class using this decorator must have a `policy` property
function ExecuteWithPolicy() {
  return Wrap<{ policy: IPolicy<IDefaultPolicyContext> }, any[], Promise<AxiosResponse>>(
    (method, context) => async (...args) =>
      await context.target.policy.execute(async () =>
        await firstValueFrom(method(...args) as Observable<AxiosResponse>)
      ),
    EXECUTE_WITH_POLICY_KEY
  )
}
```

Note: `method` in `Wrap` is auto-bound to the current `this` instance — no `.bind()`, `.call()`, or `.apply()` needed.

Usage in RestClient:
```typescript
class RestClient {
  readonly policy: IPolicy<IDefaultPolicyContext>

  @ExecuteWithPolicy()
  get<T>(url: string, config?: AxiosRequestConfig): Observable<AxiosResponse<T>> {
    return this.httpService.get<T>(url, config)
  }
}
```

### Pattern 2: AuthStrategyService with @DeduplicateInflight

**When to use**: Managing authentication state with single-flight guarantee on token fetch.

**Critical constraints**:
- `@DeduplicateInflight` requires the class to have `inflightMap: Map<string, Promise<unknown>>` as a public property
- The `KeyBuilder` type used in `DeduplicateInflight` must be defined locally — `./cache.decorator` does NOT exist; define `KeyBuilder` in the same file as `DeduplicateInflight`
- The key builder for auth must return a constant string

```typescript
// In deduplicate-inflight.decorator.ts — define KeyBuilder locally (NOT from ./cache.decorator)
type KeyBuilder<TArgs extends unknown[]> = (...args: TArgs) => string

interface AuthResult {
  extendRequest(config: AxiosRequestConfig): AxiosRequestConfig
  isAuthenticated(): boolean
}

interface AuthConfig {
  authenticate(client: RestClient): Promise<AuthResult>
}

class AuthStrategyService {
  readonly inflightMap = new Map<string, Promise<unknown>>()
  private authResult: AuthResult | null = null

  constructor(
    private readonly authConfig: AuthConfig,
    private readonly client: RestClient,
  ) {}

  isAuthenticated(): boolean {
    return this.authResult?.isAuthenticated() ?? false
  }

  async authenticateIfNeeded(): Promise<void> {
    if (!this.isAuthenticated()) {
      await this.performAuthenticate()
    }
  }

  extendRequest(config: AxiosRequestConfig): AxiosRequestConfig {
    if (!this.authResult) throw new Error('Not authenticated')
    return this.authResult.extendRequest(config)
  }

  @DeduplicateInflight(() => 'authenticate')
  private async performAuthenticate(): Promise<void> {
    this.authResult = await this.authConfig.authenticate(this.client)
  }
}
```

### Pattern 3: @Authenticate Decorator

**When to use**: On all request methods in `AuthRestClient`. Calls `authenticateIfNeeded()`, extends config, handles 401 re-auth.

**Why Wrap (not Effect/OnInvokeHook)**: `onInvoke` cannot modify method arguments. `Wrap` gives full control over arg modification.

**Critical**: The helpers `extendLastConfigArg` and `extendConfigArg` are NOT defined anywhere in the codebase. Define them inline or as local module-level functions in the same file as the decorator. Config arg position differs between methods: `get/delete/head` have config at `args[1]`; `post/put/patch` have config at `args[2]`.

```typescript
import { Wrap } from 'base-decorators'
import { isAxiosError, type AxiosRequestConfig } from 'axios'

const AUTHENTICATE_KEY: unique symbol = Symbol('authenticate')

// Local helper — define in same file as the decorator (NOT imported from elsewhere)
function extendConfigAtIndex(
  args: unknown[],
  index: number,
  strategy: AuthStrategyService,
): unknown[] {
  const extended = [...args]
  const currentConfig = (extended[index] as AxiosRequestConfig | undefined) ?? {}
  extended[index] = strategy.extendRequest(currentConfig)
  return extended
}

// Map method name to config arg position
function configArgIndex(propertyKey: string | symbol): number {
  const twoArgMethods = new Set(['get', 'delete', 'head', 'options', 'request'])
  return twoArgMethods.has(String(propertyKey)) ? 1 : 2
}

function Authenticate() {
  return Wrap<{ authStrategy: AuthStrategyService }, any[], Promise<unknown>>(
    (method, context) => async (...args) => {
      await context.target.authStrategy.authenticateIfNeeded()
      const idx = configArgIndex(context.propertyKey)
      const extendedArgs = extendConfigAtIndex(args, idx, context.target.authStrategy)
      try {
        return await method(...extendedArgs)
      } catch (error) {
        if (isAxiosError(error) && error.response?.status === 401) {
          // Force re-auth and retry once
          context.target.authStrategy.clearAuth?.()
          await context.target.authStrategy.authenticateIfNeeded()
          const retryArgs = extendConfigAtIndex(args, idx, context.target.authStrategy)
          return await method(...retryArgs)
        }
        throw error
      }
    },
    AUTHENTICATE_KEY
  )
}
```

### Pattern 4: jest tsconfig for bundler-moduleResolution projects

**When to use**: Any project where tsconfig.json uses `moduleResolution: "bundler"` (tsdown projects) but you need to run jest.

**Trade-offs**: Requires maintaining a second tsconfig. Only used during testing.

```json
// tsconfig.test.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "module": "commonjs",
    "moduleResolution": "node"
  }
}
```

```typescript
// jest.config.ts
import type { Config } from 'jest'

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.test.json',
    },
  },
  testMatch: ['**/__tests__/**/*.spec.ts'],
  // ... coverage settings
}
export default config
```

### Pattern 5: AuthRestModule Dynamic Module

**When to use**: Consuming applications register authentication config asynchronously.

```typescript
@Module({})
export class AuthRestModule {
  static forRootAsync(options: {
    useFactory: (...args: any[]) => Promise<AuthModuleOptions> | AuthModuleOptions
    inject?: any[]
    imports?: any[]
  }): DynamicModule {
    return {
      module: AuthRestModule,
      imports: [...(options.imports ?? [])],
      providers: [
        { provide: AUTH_MODULE_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] },
        { provide: RestClient, useFactory: (opts: AuthModuleOptions) => new RestClient(opts.httpService, opts.resilanceConfig), inject: [AUTH_MODULE_OPTIONS] },
        { provide: AuthStrategyService, useFactory: (opts: AuthModuleOptions, client: RestClient) => new AuthStrategyService(opts.authConfig, client), inject: [AUTH_MODULE_OPTIONS, RestClient] },
        { provide: AuthRestClient, useFactory: (client: RestClient, strategy: AuthStrategyService) => new AuthRestClient(client, strategy), inject: [RestClient, AuthStrategyService] },
      ],
      exports: [AuthRestClient, RestClient],
    }
  }
}
```

---

## Similar Implementations

### AuthenticatedHttpService (existing draft — to be replaced)
- **Source**: `src/auth/authenticated-http.service.ts`
- **Approach**: Manual authenticate/ensureAuthenticated, p-retry, Observable + firstValueFrom, single-flight via promise field, rigid 4-field AuthConfig (endpoint, requestBuilder, responseExtractor, headerBuilder)
- **Applicability**: Replaced by AuthRestClient + AuthStrategyService + @Authenticate pattern

### HttpClient (existing draft — to be replaced)
- **Source**: `src/client/http.client.ts`
- **Approach**: Private `executeRequest()` method wrapping policy.execute + firstValueFrom, `ResilencePresets` enum referenced but not imported
- **Applicability**: Replaced by RestClient + @ExecuteWithPolicy decorator

---

## Common Pitfalls & Solutions

| Issue | Impact | Solution |
|-------|--------|----------|
| **`base-decorators` NOT in package.json** | Critical | Run `npm install base-decorators@1.1.0` before any decorator work; it is NOT yet a dependency |
| **`./cache.decorator` does not exist** | Critical | The file `src/deduplicate-inflight.decorator.ts` imports `KeyBuilder` from `./cache.decorator` which is missing. Create `./cache.decorator.ts` with `export type KeyBuilder<TArgs extends unknown[]> = (...args: TArgs) => string`, OR define `KeyBuilder` locally in `deduplicate-inflight.decorator.ts` and remove the import |
| **`@/cache` path alias not configured** | Critical | `tsconfig.json` has no `paths` field. `src/deduplicate-inflight.decorator.spec.ts` imports from `@/cache/deduplicate-inflight.decorator`. Either add `paths: { "@/*": ["src/*"] }` to tsconfig.json and tsconfig.test.json, OR change import to a relative path |
| **`vitest` must be removed before jest** | High | `vitest@^4.0.16` is currently installed. Run `npm uninstall vitest` before installing jest to avoid conflicts. The `test` script in package.json currently calls vitest |
| **`tests/index.test.ts` imports `fn` from `'../src'`** | High | `fn` is not exported from `src/index.ts`. Delete or replace this file — it is a vitest smoke test left over from project scaffolding and has no relationship to the actual library |
| **`extendLastConfigArg` / `extendConfigArg` are undefined** | Critical | These helpers are called in Pattern 3 (@Authenticate) but are never defined anywhere in the codebase. Define inline config-extension logic within the decorator factory as shown in Pattern 3 above |
| **`moduleResolution: "bundler"` breaks jest** | High | Create `tsconfig.test.json` with `"module": "commonjs"` and `"moduleResolution": "node"` |
| **`context.target` type not narrowed** | Medium | Type the `Wrap` generic: `Wrap<{ policy: IPolicy }>` |
| **DeduplicateInflight requires `inflightMap` property** | High | Always declare `readonly inflightMap = new Map<string, Promise<unknown>>()` on the class |
| **Policy.execute expects synchronous return in some versions** | Medium | Always `await` inside execute callback; use `firstValueFrom` to unwrap Observables |
| **jest-it-up runs after e2e tests too** | Medium | Name script `posttest:unit` not `posttest` to scope it to unit tests only |
| **Stryker v9 may not support jest@29** | Medium | Use Stryker v8 with jest@29 (documented working combo) |
| **Double-wrapping when using multiple Wrap decorators** | Medium | Use unique `exclusionKey` symbol for each decorator to avoid conflicts |
| **`method` in Wrap is already bound** | Low | Do NOT call `method.bind(this)` — base-decorators auto-binds `method` to the current `this` on every invocation |

---

## Recommendations

1. **Install `base-decorators@1.1.0` first** — it is not in `package.json` yet; all decorator patterns depend on it.
2. **Fix `./cache.decorator` import immediately** — `deduplicate-inflight.decorator.ts` will not compile until this missing file is created or the import is replaced with a local type definition.
3. **Use `Wrap` for any decorator that modifies arguments or needs full execution control** — `Effect`/`OnInvokeHook` cannot modify args; `Wrap` is the only primitive that allows replacing what is passed to the original method.
4. **Always pass `exclusionKey` to `Wrap`** — prevents double-wrapping conflicts when multiple `Wrap`-based decorators (`@ExecuteWithPolicy`, `@DeduplicateInflight`, `@Authenticate`) are applied to the same class.
5. **Separate tsconfig.test.json** — never modify the root `tsconfig.json` for jest compatibility; the build toolchain (tsdown) depends on `moduleResolution: "bundler"`.
6. **Use Stryker v8 + jest@29** — Stryker v9 may require jest@30.
7. **DeduplicateInflight on `performAuthenticate` not `authenticateIfNeeded`** — the public `authenticateIfNeeded` checks state first; the decorated private method is the actual network call that should be deduplicated.

---

## Implementation Guidance

### Prerequisites: Must Install

```bash
# 1. Install base-decorators (NOT currently in package.json)
npm install base-decorators@1.1.0

# 2. Remove vitest (currently installed, conflicts with jest)
npm uninstall vitest

# 3. Install jest + ts-jest
npm install --save-dev jest@29.7.0 ts-jest@29.2.0 @types/jest@29.5.0

# 4. Install jest-it-up
npm install --save-dev jest-it-up@4.0.1

# 5. Install Stryker (v8 for jest@29 compatibility)
npm install --save-dev @stryker-mutator/core@8 @stryker-mutator/jest-runner@8 @stryker-mutator/typescript-checker@8

# 6. Install testcontainers for e2e
npm install --save-dev testcontainers@11.14.0
```

### Fix Broken Imports Before Implementing

```bash
# Option A: Create missing cache.decorator.ts file
# Create src/cache.decorator.ts with:
# export type KeyBuilder<TArgs extends unknown[]> = (...args: TArgs) => string

# Option B (preferred): Remove the import and define KeyBuilder locally
# In src/deduplicate-inflight.decorator.ts:
# Replace: import { KeyBuilder } from './cache.decorator'
# With:    type KeyBuilder<TArgs extends unknown[]> = (...args: TArgs) => string

# Fix path alias in tsconfig.json (add paths field):
# "paths": { "@/*": ["src/*"] }
# Also add same paths to tsconfig.test.json

# Delete broken vitest smoke test:
# rm tests/index.test.ts
```

### Package.json Scripts

```json
{
  "scripts": {
    "test:unit": "jest --config jest.config.ts",
    "posttest:unit": "jest-it-up",
    "test:e2e": "jest --config jest.e2e.config.ts",
    "test:mutation": "stryker run",
    "test": "npm run test:unit && npm run test:e2e && npm run test:mutation"
  }
}
```

### Configuration Files

**jest.config.ts** (unit tests):
```typescript
import type { Config } from 'jest'

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  globals: { 'ts-jest': { tsconfig: 'tsconfig.test.json' } },
  testMatch: ['**/src/**/__tests__/**/*.spec.ts'],
  collectCoverage: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/__tests__/**', '!src/index.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html', 'json-summary'],
  coverageProvider: 'v8',
  coverageThreshold: {
    global: { branches: 80, functions: 80, lines: 80, statements: 80 },
  },
}
export default config
```

**jest.e2e.config.ts** (e2e tests):
```typescript
import type { Config } from 'jest'

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  globals: { 'ts-jest': { tsconfig: 'tsconfig.test.json' } },
  testMatch: ['**/tests/**/*.spec.ts'],
  testTimeout: 60000,
}
export default config
```

**stryker.config.json**:
```json
{
  "testRunner": "jest",
  "coverageAnalysis": "perTest",
  "jest": { "projectType": "custom", "configFile": "jest.config.ts" },
  "checkers": ["typescript"],
  "tsconfigFile": "tsconfig.test.json",
  "mutate": ["src/**/*.ts", "!src/**/__tests__/**/*.ts", "!src/index.ts"],
  "reporters": ["html", "text", "progress"],
  "thresholds": { "high": 80, "low": 60, "break": 80 }
}
```

### Integration Points

- `RestClient` has `policy: IPolicy` property that `@ExecuteWithPolicy` reads via `context.target.policy`
- `AuthRestClient` has `authStrategy: AuthStrategyService` property that `@Authenticate` reads via `context.target.authStrategy`
- `AuthStrategyService` has `inflightMap: Map<string, Promise<unknown>>` required by `@DeduplicateInflight`
- `AuthConfig.authenticate(client)` receives the `RestClient` so it can make auth requests through the resilience policy

---

## Code Examples

### Example 1: Complete RestClient skeleton

```typescript
import { firstValueFrom } from 'rxjs'
import { Wrap } from 'base-decorators'
import type { IPolicy, IDefaultPolicyContext } from 'cockatiel'
import type { AxiosRequestConfig, AxiosResponse } from 'axios'
import type { HttpService } from '@nestjs/axios'
import { resiliencePolicyPresets, ResilencePresets } from '../resilence.policy'
import { resiliencePolicyBuilder } from './resailencePolicyBuilder'
import type { ResilanceConfig } from './resilance.config'

const EXECUTE_WITH_POLICY_KEY: unique symbol = Symbol('executeWithPolicy')

function ExecuteWithPolicy() {
  return Wrap<RestClient, any[], Promise<AxiosResponse>>(
    (method, ctx) => async (...args) =>
      ctx.target.policy.execute(async () => await firstValueFrom(method(...args))),
    EXECUTE_WITH_POLICY_KEY
  )
}

export class RestClient {
  readonly policy: IPolicy<IDefaultPolicyContext>

  constructor(
    private readonly httpService: HttpService,
    config: ResilanceConfig = resiliencePolicyPresets[ResilencePresets.CONSERVATIVE],
  ) {
    this.policy = resiliencePolicyBuilder(config)
  }

  @ExecuteWithPolicy()
  get<T>(url: string, config?: AxiosRequestConfig) {
    return this.httpService.get<T>(url, config)
  }

  @ExecuteWithPolicy()
  post<T, D>(url: string, data?: D, config?: AxiosRequestConfig<D>) {
    return this.httpService.post<T, AxiosResponse<T>, D>(url, data, config)
  }
}
```

### Example 2: E2e globalSetup with httpbin

```typescript
// tests/global-setup.ts
import { GenericContainer, Wait } from 'testcontainers'
import type { StartedTestContainer } from 'testcontainers'

let container: StartedTestContainer

export async function setup(): Promise<void> {
  container = await new GenericContainer('kennethreitz/httpbin')
    .withExposedPorts(80)
    .withWaitStrategy(Wait.forHttp('/get', 80).forStatusCode(200))
    .start()

  process.env.TEST_HTTP_BASE_URL = `http://${container.getHost()}:${container.getMappedPort(80)}`
}

export async function teardown(): Promise<void> {
  await container?.stop()
}
```

### Example 3: Unit test with constructor injection (no import mocking)

```typescript
// src/client/__tests__/rest.client.spec.ts
import { RestClient } from '../rest.client'
import type { IPolicy, IDefaultPolicyContext } from 'cockatiel'
import { of } from 'rxjs'

const mockHttpService = {
  get: jest.fn().mockReturnValue(of({ data: 'test', status: 200 })),
  post: jest.fn(),
}

const mockPolicy: IPolicy<IDefaultPolicyContext> = {
  execute: jest.fn(fn => fn({ signal: new AbortController().signal })),
  onSuccess: jest.fn(),
  onFailure: jest.fn(),
}

describe('RestClient', () => {
  let client: RestClient

  beforeEach(() => {
    jest.clearAllMocks()
    client = new RestClient(mockHttpService as any, mockPolicy as any)
  })

  it('executes GET through policy', async () => {
    const result = await client.get('/test')
    expect(mockPolicy.execute).toHaveBeenCalled()
    expect(mockHttpService.get).toHaveBeenCalledWith('/test', undefined)
    expect(result.data).toBe('test')
  })
})
```

---

## Sources & Verification

| Source | Type | Last Verified |
|--------|------|---------------|
| https://github.com/NeoLabHQ/base-decorators (npm tarball extracted) | Official | 2026-04-26 |
| https://www.npmjs.com/package/base-decorators | Registry | 2026-04-26 |
| https://github.com/connor4312/cockatiel | Official | 2026-04-26 |
| https://jestjs.io/docs/configuration | Official | 2026-04-26 |
| https://stryker-mutator.io/docs/stryker-js/jest-runner/ | Official | 2026-04-26 |
| https://node.testcontainers.org | Official | 2026-04-26 |
| src/deduplicate-inflight.decorator.ts (local codebase — broken) | Internal | 2026-04-26 |
| src/client/http.client.ts (local codebase — to be replaced) | Internal | 2026-04-26 |
| src/auth/authenticated-http.service.ts (local codebase — to be replaced) | Internal | 2026-04-26 |
| package.json (local — confirmed base-decorators NOT present) | Internal | 2026-04-26 |
| node_modules inspection (confirmed base-decorators NOT installed) | Internal | 2026-04-26 |
| /tmp/base-decorators-1.1.0.tgz (npm pack — verified exports + types) | Official | 2026-04-26 |
| .claude/skills/nestjs-jest-testing/SKILL.md | Internal skill | 2026-04-26 |

---

## Changelog

| Date | Changes |
|------|---------|
| 2026-04-26 | Initial creation for task: complete-initial-feature-set |
| 2026-04-26 | Major update: added Current State vs Target State section; fixed base-decorators NOT installed (was falsely described as a dependency); added pitfall for missing ./cache.decorator; fixed @Authenticate pattern to remove undefined helpers (extendLastConfigArg/extendConfigArg) and replace with inline logic; added pitfalls for missing @/cache path alias, vitest removal requirement, broken tests/index.test.ts; clarified installed vs must-install in library table; verified all claims from source inspection and npm pack |
