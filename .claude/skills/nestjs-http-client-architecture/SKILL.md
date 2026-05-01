---
name: NestJS HTTP Client Architecture
description: Architecture patterns, decorator design, and testing setup for the nestjs-http-client library — RestClient, AuthRestClient, AuthProcessor, @ExecuteWithPolicy, @DeduplicateInflight, and the jest/Stryker/testcontainers test stack.
topics: nestjs, http-client, base-decorators, cockatiel, jest, stryker, testcontainers, resilience, authentication, decorators
created: 2026-04-26
updated: 2026-04-30
scratchpad: .specs/scratchpad/8f5da770.md
---

# NestJS HTTP Client Architecture

## Overview

This skill documents the architecture of the `nestjs-http-client` library. The library wraps `@nestjs/axios`'s `HttpService` with a cockatiel resilience policy stack. It exposes two clients: `RestClient` (resilient HTTP client) and `AuthRestClient` (authenticated HTTP client). Decorator logic uses `base-decorators@1.1.0` primitives (`Wrap`). Testing uses jest@29 + ts-jest, Stryker v8, jest-it-up, and testcontainers.

**As of the improve-auth-rest-client task:** `AuthStrategyService` is being renamed to `AuthProcessor`, `AuthConfig` interface is being removed, and `AuthStrategy` is promoted from a factory return value to a class-based injectable with its own `authenticate(client)` method.

---

## Current Implemented State

The codebase is **fully implemented** on branch `feature/vg/library-usability-improvements`. All tests pass. The architecture described below reflects the IMPLEMENTED state plus the pending auth refactor.

### Implemented Files (verified 2026-04-30)

- `src/client/hookable-http.service.ts` — abstract base, `HttpVerb`, `InvokeArgs`, `HttpServiceLike`, verb surface
- `src/client/rest.client.ts` — `RestClient extends HookableHttpService`, overrides `dispatch` with `policy.execute`
- `src/client/rest.module.ts` — `RestModule.forRootAsync` and `RestModule.forHttpService`
- `src/client/resailencePolicyBuilder.ts` — composes cockatiel policies from `ResilanceConfig`
- `src/client/resilance.config.ts` — `ResilanceConfig`, `RetryConfig`, `CircuitBreakerConfig`, etc.
- `src/auth/auth.config.ts` — `AuthStrategy` interface + `AuthConfig` interface (AuthConfig being REMOVED in next task)
- `src/auth/auth-strategy.service.ts` — `AuthStrategyService` (being RENAMED to `AuthProcessor` in next task)
- `src/auth/auth-rest.client.ts` — `AuthRestClient extends HookableHttpService`
- `src/auth/auth-rest.module.ts` — `AuthRestModule.forRootAsync` dynamic module
- `src/deduplicate-inflight.decorator.ts` — `@DeduplicateInflight` using `Wrap` from `base-decorators`
- `src/index.ts` — public API exports
- `tests/e2e-setup.ts` / `tests/e2e-teardown.ts` — testcontainers httpbin lifecycle
- `tests/auth-rest-client.e2e.spec.ts`, `tests/rest-client.e2e.spec.ts`, `tests/smoke.e2e.spec.ts` — e2e suites
- `jest.config.ts`, `jest.e2e.config.ts`, `stryker.config.json` — test configuration files
- `base-decorators@1.1.0`, `jest@29.7`, `ts-jest@29`, `@types/jest@29`, `jest-it-up`, `@stryker-mutator/*`, `testcontainers` — all installed in devDependencies

---

## Key Concepts

- **RestClient**: Thin wrapper around `HttpService` that runs requests through a cockatiel `IPolicy`. `policy` field is public readonly. Extends `HookableHttpService`, overrides `dispatch` to wrap with `policy.execute(policyCtx => ...)` and merges `policyCtx.signal` into the axios config.
- **HookableHttpService**: Abstract base class. Provides the full verb surface (`request`, `get`, `post`, etc.) via a protected `dispatch` template method and `callUnderlying` helper. Subclasses layer cross-cutting concerns by overriding `dispatch`.
- **AuthRestClient**: Extends `HookableHttpService`. Holds `restClient: RestClient` (as httpService) and `authStrategy: AuthStrategyService` (or `AuthProcessor` after rename). Overrides `dispatch` to run pre-flight auth, extend request config, and recover from a single 401.
- **AuthStrategyService** (being renamed to **AuthProcessor**): Manages authentication lifecycle. Calls `authConfig.authenticate(client)` to obtain an `AuthStrategy` result object (currently) OR will call `authStrategy.authenticate(client)` directly (after refactor). Uses `@DeduplicateInflight` on `performAuthenticate()` for single-flight guarantee.
- **AuthConfig** (being REMOVED): Interface wrapping a single `authenticate(client) => Promise<AuthStrategy>` factory. Will be removed — its responsibility moves into the `AuthStrategy` class itself.
- **AuthStrategy** (interface, being EXPANDED): Currently `{ isAuthenticated(): boolean; extendRequest(config): AxiosRequestConfig }`. After refactor gains `authenticate(client: RestClient): Promise<void>` — making it a full class-based strategy.
- **AuthRestModule**: Dynamic NestJS module. Currently accepts `{ httpService, authConfig: AuthConfig, resilience? }`. After refactor accepts `{ httpService, authStrategy: Type<AuthStrategy>, resilience? }`.
- **@DeduplicateInflight**: Method decorator using `Wrap` from `base-decorators`. Coalesces concurrent calls with the same key into a single promise. The decorated class must expose `inflightMap: Map<string, Promise<unknown>>`.
- **RestModule**: Dynamic NestJS module. `forRootAsync` creates an internal `HttpModule` from axios config. `forHttpService` accepts a pre-resolved `HttpService` (used by `AuthRestModule` to avoid a second axios instance).

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
| `base-decorators@1.1.0` | Decorator primitives (`Wrap`) | Installed | In package.json dependencies |
| `cockatiel@3.2.1` | Resilience policies (retry, CB, bulkhead, fallback) | Installed | In package.json dependencies |
| `axios@^1.14.0` | HTTP client | Installed | In package.json dependencies |
| `jest@29.7` | Test runner (unit + e2e) | Installed | See jest.config.ts, jest.e2e.config.ts |
| `ts-jest@29` | TypeScript transformer for Jest | Installed | Uses inline tsconfig overrides |
| `@types/jest@29` | Type declarations for Jest | Installed | In devDependencies |
| `jest-it-up@4.0.1` | Auto-bump jest coverage thresholds | Installed | posttest:unit script |
| `@stryker-mutator/core@8` | Mutation testing engine | Installed | stryker.config.json |
| `@stryker-mutator/jest-runner@8` | Jest integration for Stryker | Installed | Matches jest@29 |
| `@stryker-mutator/typescript-checker@8` | Type-safe mutation filtering | Installed | Filters invalid mutants |
| `testcontainers@11.14.0` | Docker containers for e2e tests | Installed | httpbin container for e2e |
| `nestjs-log-decorator` | Loggable interface + Logger injection | Installed | Used in RestClient |

### Installed Stack

jest@29 + ts-jest with inline `tsconfig` overrides (`module: commonjs`, `moduleResolution: node`) in both `jest.config.ts` (unit) and `jest.e2e.config.ts` (e2e). `jest-it-up` runs as `posttest:unit`. Stryker v8 + jest runner with 80% break threshold. testcontainers with `kennethreitz/httpbin` image for e2e.

**IMPORTANT**: The project uses `tsdown` with `moduleResolution: "bundler"` in tsconfig.json. Jest requires CommonJS + `moduleResolution: "node"`. Use inline `tsconfig` overrides in the ts-jest transform block — do NOT modify root tsconfig.json for jest compatibility.

---

## Patterns & Best Practices

### Pattern 1: HookableHttpService + dispatch override

**When to use**: Layering cross-cutting concerns over the HTTP verb surface. Both `RestClient` and `AuthRestClient` use this pattern.

**Core mechanics**: `HookableHttpService` maps every verb call to an `InvokeArgs` carrier `{ config, url?, data? }` and routes it through `protected dispatch(verb, args)`. Subclasses override `dispatch` to add "around" behavior. `callUnderlying(verb, args)` invokes the actual transport and normalizes Observable/Promise results.

```typescript
// RestClient: wraps every request in policy.execute
protected override async dispatch<T>(verb, initialArgs): Promise<AxiosResponse<T>> {
  return await this.policy.execute(async (policyCtx) => {
    const argsWithSignal = { ...initialArgs, config: mergeSignal(initialArgs.config, policyCtx.signal) }
    return await super.dispatch<T>(verb, argsWithSignal)
  }) as AxiosResponse<T>
}

// AuthRestClient: pre-flight auth + 401 re-auth
protected override async dispatch<T>(verb, initialArgs): Promise<AxiosResponse<T>> {
  await this.authStrategy.authenticateIfNeeded()
  const authedArgs = { ...initialArgs, config: this.authStrategy.extendRequest(initialArgs.config) }
  try {
    return await super.dispatch<T>(verb, authedArgs)  // delegates to inner RestClient
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 401) {
      this.authStrategy.clearAuth()
      await this.authStrategy.authenticateIfNeeded()
      const retryArgs = { ...initialArgs, config: this.authStrategy.extendRequest(initialArgs.config) }
      return await this.callUnderlying<T>(verb, retryArgs)  // bypasses pre-flight on retry
    }
    throw error
  }
}
```

**Key**: `super.dispatch` runs all parent dispatch logic (the resilience pipeline in RestClient). `this.callUnderlying` bypasses all dispatch overrides and goes straight to the transport. Use `callUnderlying` on the 401 retry path to avoid double pre-flight auth.

### Pattern 2: AuthStrategyService / AuthProcessor with @DeduplicateInflight

**Current implementation** (`auth-strategy.service.ts`):
- Holds `AuthConfig` factory + `client: unknown`. Caches `authResult: AuthStrategy | null`.
- `performAuthenticate()` calls `authConfig.authenticate(client)` and stores result.
- `@DeduplicateInflight(() => 'authenticate')` on `performAuthenticate` — single-flight guarantee.
- Class MUST have `readonly inflightMap = new Map<string, Promise<unknown>>()`.

**Post-refactor (`AuthProcessor`)**:
- Holds the `AuthStrategy` class INSTANCE (not a factory). No `authResult` caching.
- `isAuthenticated()` → `authStrategy.isAuthenticated()` directly.
- `extendRequest()` → `authStrategy.extendRequest()` directly.
- `performAuthenticate()` → `authStrategy.authenticate(client)` directly.
- The `AuthStrategy` class manages its own internal session state.

```typescript
// Current AuthStrategyService (before rename)
class AuthStrategyService {
  readonly inflightMap = new Map<string, Promise<unknown>>()
  private authResult: AuthStrategy | null = null

  constructor(private readonly authConfig: AuthConfig, private readonly client: unknown) {}

  isAuthenticated() { return this.authResult?.isAuthenticated() ?? false }
  extendRequest(config) { return this.authResult?.extendRequest(config) ?? config }
  clearAuth() { this.authResult = null }

  @DeduplicateInflight(() => 'authenticate')
  private async performAuthenticate() {
    this.authResult = await this.authConfig.authenticate(this.client as RestClient)
  }
}
```

### Pattern 3: Class-based AuthStrategy DI (pending refactor)

**Context**: The `improve-auth-rest-client` task replaces the `AuthConfig` factory pattern with a class-based DI pattern for `AuthStrategy`.

**New AuthStrategy interface** (gains `authenticate` method):
```typescript
interface AuthStrategy {
  authenticate(client: RestClient): Promise<void>  // NEW — was in AuthConfig
  isAuthenticated(): boolean
  extendRequest(config: AxiosRequestConfig): AxiosRequestConfig
}
```

**New AuthRestModuleOptions** (class reference instead of factory):
```typescript
interface AuthRestModuleOptions {
  httpService: HttpService
  authStrategy: Type<AuthStrategy>  // Class token, NestJS resolves and instantiates it
  resilience?: ResilanceConfig<unknown>
}
```

**Module wiring change**: `AuthRestModule.forRootAsync` provides the user's `AuthStrategy` class via `useClass` so NestJS DI resolves and injects it into `AuthProcessor`.

**clearAuth() design decision**: Since `AuthProcessor` no longer caches `authResult`, `clearAuth()` must signal the `AuthStrategy` instance to invalidate its internal session. The exact mechanism is a design decision — the `AuthStrategy` class manages its own state, and `clearAuth` on `AuthProcessor` triggers re-authentication on the next `authenticateIfNeeded()` call. One approach: `AuthProcessor` keeps a boolean `_invalidated` flag that overrides `authStrategy.isAuthenticated()` until a fresh `authenticate()` call completes.

### Pattern 4: @DeduplicateInflight decorator implementation

**Source**: `src/deduplicate-inflight.decorator.ts` — uses `Wrap` from `base-decorators`.

```typescript
// KeyBuilder is defined locally (NOT imported from ./cache.decorator which doesn't exist)
type KeyBuilder<TArgs extends unknown[]> = (...args: TArgs) => string

function DeduplicateInflight<TArgs extends unknown[]>(keyBuilder: KeyBuilder<TArgs>): MethodDecorator {
  return Wrap<{ inflightMap: Map<string, Promise<unknown>> }, TArgs, Promise<unknown>>(
    (method, context) => async (...args) => {
      const key = keyBuilder(...args)
      const existing = context.target.inflightMap.get(key)
      if (existing) return existing

      const promise = method(...args)
      context.target.inflightMap.set(key, promise)
      try {
        return await promise
      } finally {
        context.target.inflightMap.delete(key)  // always cleanup in finally
      }
    },
    INFLIGHT_EXCLUSION_KEY
  )
}
```

**Critical**: The decorated class MUST have `readonly inflightMap = new Map<string, Promise<unknown>>()` as a public property. The key builder for auth should return a constant string so all concurrent auth calls share one promise.

### Pattern 5: Static auth via RestClient (no AuthRestModule needed)

**When to use**: Static API tokens where credentials never change. No authentication lifecycle needed.

```typescript
@Module({
  imports: [
    RestModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        axios: {
          baseURL: 'https://api.example.com',
          headers: {
            Authorization: `Bearer ${config.get('API_TOKEN')}`,
          },
        },
      }),
    }),
  ],
  exports: [RestClient],
})
export class CatalogModule {}
```

Use `RestModule` directly. `AuthRestModule` is only needed for dynamic authentication (token refresh, OAuth flows, etc.).

---

## Test Patterns

### Unit test: stub both transport and strategy

Tests in `src/auth/__tests__/` stub the underlying `RestClient` and `AuthStrategyService` as plain objects with `jest.fn()`. No `@nestjs/testing` needed for unit tests.

```typescript
// AuthRestClient unit test pattern
function createRestClientStub(): RestClientStub {
  const stub = {} as RestClientStub
  for (const verb of ALL_VERBS) {
    stub[verb] = jest.fn().mockResolvedValue({ data: 'ok' } as AxiosResponse)
  }
  return stub
}
const client = new AuthRestClient(restClientStub as unknown as RestClient, authStrategyStub as unknown as AuthStrategyService)
```

### Unit test: DI module with TestingModule

Tests in `src/auth/__tests__/auth-rest.module.spec.ts` use `@nestjs/testing` to bootstrap the full module and verify DI wiring:

```typescript
const moduleRef = await Test.createTestingModule({
  imports: [AuthRestModule.forRootAsync({ useFactory: () => ({ httpService, authConfig }) })],
}).compile()
const authRestClient = moduleRef.get(AuthRestClient)
const restClient = moduleRef.get(RestClient)
// Verify single-source-of-truth: same RestClient instance
expect(authRestClient.restClient).toBe(restClient)
```

### E2e test: httpbin container

E2e specs in `tests/` receive `process.env.TEST_HTTP_BASE_URL` from `tests/e2e-setup.ts` (globalSetup). Use `HttpService` + `axios.create({ baseURL })` for real HTTP calls. Container is `kennethreitz/httpbin` via testcontainers.

---

## Common Pitfalls & Solutions

| Issue | Impact | Solution |
|-------|--------|----------|
| **`moduleResolution: "bundler"` breaks jest** | High | Use inline `tsconfig` overrides in ts-jest transform block: `module: commonjs, moduleResolution: node`. Never modify root tsconfig.json for jest |
| **`emitDecoratorMetadata: true` inflates branch coverage** | Medium | Keep `emitDecoratorMetadata: false` in jest tsconfig inline override |
| **DeduplicateInflight requires `inflightMap` property** | Critical | Declare `readonly inflightMap = new Map<string, Promise<unknown>>()` on decorated class |
| **`callUnderlying` vs `super.dispatch` on 401 retry** | High | Use `callUnderlying` on 401 retry to skip pre-flight auth; use `super.dispatch` for normal calls that should go through the full pipeline |
| **AuthRestClient `authStrategy` field must be public** | High | Module wiring, tests, and adapters read `client.authStrategy` directly |
| **Single-source-of-truth RestClient** | High | `AuthRestClient.restClient` must return the same `RestClient` instance that `AuthRestModule` provides — never create a second instance |
| **`@DeduplicateInflight` key must be constant for auth** | High | Use `() => 'authenticate'` so all concurrent auth calls share one promise |
| **AuthRestClient dispatch: original config for 401 retry** | High | Re-extend from `initialArgs.config` (not from the already-extended `authedArgs.config`) so stale headers are fully replaced |
| **Wrap `method` is already bound** | Low | Do NOT call `method.bind(this)` — base-decorators auto-binds per invocation |
| **clearAuth() in post-refactor AuthProcessor** | Medium | AuthStrategy class must manage its own session state; AuthProcessor.clearAuth() must trigger re-auth without an `authResult` field to null |

---

## Recommendations

1. **Use `dispatch` override pattern for cross-cutting concerns** — `AuthRestClient` and `RestClient` both override `dispatch`; this is the correct extension point, not method decorators on individual verbs.
2. **Apply `@DeduplicateInflight` on `performAuthenticate`, not `authenticateIfNeeded`** — the public method checks state first; the decorated private method is the network call that should be single-flighted.
3. **Use inline tsconfig overrides in ts-jest transform block** — never touch the root tsconfig for jest compatibility; tsdown requires `moduleResolution: bundler`.
4. **Treat `InvokeArgs` as immutable** — always produce a new object via spread before forwarding to `callUnderlying` or `super.dispatch`; retry paths depend on the pristine original.
5. **Always declare `readonly inflightMap` on `@DeduplicateInflight` users** — the decorator reads it via `context.target.inflightMap`; missing this causes a runtime error.
6. **Use `Type<AuthStrategy>` in `AuthRestModuleOptions`** (post-refactor) — NestJS resolves and instantiates the class via DI; do not instantiate it manually in the factory.

---

## Implementation Guidance

### Integration Points

- `RestClient.policy` — `IPolicy<IDefaultPolicyContext, any>`, built in constructor from `ResilanceConfig`
- `AuthRestClient.authStrategy` — public readonly field; read by module wiring, tests, and adapters
- `AuthRestClient.restClient` — getter returning `this.httpService as RestClient`; used for single-source-of-truth verification
- `AuthStrategyService.inflightMap` — public `Map<string, Promise<unknown>>`; required by `@DeduplicateInflight`
- `AuthRestModule` re-exports `RestModule` (not `RestClient` directly) so consumers get the canonical RestClient provider without a second instance

### File Structure (auth module)

```
src/auth/
  auth.config.ts          # AuthStrategy interface (AuthConfig removed in refactor)
  auth-strategy.service.ts # Renamed to auth-processor.ts in refactor
  auth-rest.client.ts     # AuthRestClient extends HookableHttpService
  auth-rest.module.ts     # AuthRestModule.forRootAsync
  __tests__/
    auth-strategy.service.spec.ts  # Renamed to auth-processor.spec.ts in refactor
    auth-rest.client.spec.ts
    auth-rest.module.spec.ts
tests/
  auth-rest-client.e2e.spec.ts
  rest-client.e2e.spec.ts
  smoke.e2e.spec.ts
  e2e-setup.ts            # globalSetup: starts httpbin container
  e2e-teardown.ts         # globalTeardown: stops container
```

### Pending Refactor: improve-auth-rest-client

The following changes are required by task `improve-auth-rest-client`:

| Change | Details |
|--------|---------|
| Remove `AuthConfig` interface | Delete from `auth.config.ts`; update `auth-rest.module.ts` and tests |
| Rename `AuthStrategyService` → `AuthProcessor` | Rename file, class, all imports |
| Expand `AuthStrategy` interface | Add `authenticate(client: RestClient): Promise<void>` method |
| Update `AuthProcessor` | Remove `authResult` caching; call `AuthStrategy` methods directly |
| Update `AuthRestModuleOptions` | Replace `authConfig: AuthConfig` with `authStrategy: Type<AuthStrategy>` |
| Update `src/index.ts` | Export `AuthProcessor` instead of `AuthStrategyService`; remove `AuthConfig` type export |
| Add static auth e2e test | Test `RestClient` with static `Authorization` header via axios config |
| Update README | New API docs + static auth example + note about dynamic vs static auth |
| Add JSDoc | Usage examples on all classes and methods |

---

## Sources & Verification

| Source | Type | Last Verified |
|--------|------|---------------|
| src/client/hookable-http.service.ts | Internal (verified) | 2026-04-30 |
| src/client/rest.client.ts | Internal (verified) | 2026-04-30 |
| src/auth/auth.config.ts | Internal (verified) | 2026-04-30 |
| src/auth/auth-strategy.service.ts | Internal (verified) | 2026-04-30 |
| src/auth/auth-rest.client.ts | Internal (verified) | 2026-04-30 |
| src/auth/auth-rest.module.ts | Internal (verified) | 2026-04-30 |
| src/deduplicate-inflight.decorator.ts | Internal (verified) | 2026-04-30 |
| src/index.ts | Internal (verified) | 2026-04-30 |
| tests/auth-rest-client.e2e.spec.ts | Internal (verified) | 2026-04-30 |
| tests/rest-client.e2e.spec.ts | Internal (verified) | 2026-04-30 |
| package.json (all deps verified present) | Internal | 2026-04-30 |
| https://github.com/NeoLabHQ/base-decorators | Official | 2026-04-26 |
| https://github.com/connor4312/cockatiel | Official | 2026-04-26 |
| https://jestjs.io/docs/configuration | Official | 2026-04-26 |
| https://node.testcontainers.org | Official | 2026-04-26 |
| .specs/tasks/draft/improve-auth-rest-client.feature.md | Task file | 2026-04-30 |

---

## Changelog

| Date | Changes |
|------|---------|
| 2026-04-26 | Initial creation for task: complete-initial-feature-set |
| 2026-04-26 | Major update: corrected installed vs missing packages, fixed broken import pitfalls, verified from source inspection |
| 2026-04-30 | Major update for task: improve-auth-rest-client — rewrote "Current State vs Target State" to reflect fully implemented codebase; replaced all outdated patterns with actual implemented dispatch override pattern; removed stale @ExecuteWithPolicy/@Authenticate decorator patterns (not implemented that way); updated library table to reflect all packages now installed; added class-based AuthStrategy DI pattern (pending refactor); added pending refactor change table; added static auth via RestClient pattern; updated sources to reflect direct file inspection |
