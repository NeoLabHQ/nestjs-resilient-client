---
name: NestJS HTTP Client Architecture
description: Architecture patterns, decorator design, and testing setup for the nestjs-resilient-client library — RestClient, AuthRestClient, AuthProcessor, BaseHttpService/HookableHttpService, HooksConfig, RxJS resilience operators, @DeduplicateInflight, and the jest/Stryker/testcontainers test stack.
---

# NestJS HTTP Client Architecture

## Overview

This skill documents the architecture of the `nestjs-resilient-client` library. The library wraps `@nestjs/axios`'s `HttpService` with a cockatiel resilience policy stack. It exposes two clients: `RestClient` (resilient HTTP client) and `AuthRestClient` (authenticated HTTP client). Decorator logic uses `base-decorators@1.1.0` primitives (`Wrap`). Testing uses jest@29 + ts-jest, Stryker v8, jest-it-up, and testcontainers.

## Key Concepts

- **BaseHttpService**: Abstract base class. Provides the full verb surface (`request`, `get`, `post`, etc.) via a protected `dispatch` template method and `callUnderlying` helper. Subclasses layer cross-cutting concerns by overriding `dispatch`. Normalises Observable/Promise results in `callUnderlying`.
- **HookableHttpService**: Adds `HooksConfig` parameter to constructor. Overrides `dispatch` to apply `onInvoke` (pre-call arg transform), `onReturn` (post-call response transform), and `onError` (error observation) hooks.
- **HooksConfig**: Interface with three optional hooks: `onInvoke(verb, args) => InvokeArgs | Promise<InvokeArgs>`, `onReturn(verb, args, response) => AxiosResponse | Promise<AxiosResponse>`, `onError(verb, args, error) => void | never`.
- **RestClient**: Thin wrapper around `HttpService` that runs requests through a cockatiel `IPolicy`. `policy` field is public readonly. Extends `HookableHttpService` (new), overrides `dispatch` to wrap with `policy.execute(policyCtx => ...)` and merges `policyCtx.signal` into the axios config.
- **AuthRestClient**: Extends `HookableHttpService` (new). Holds `restClient: RestClient` (as httpService) and `authProcessor: AuthProcessor`. Overrides `dispatch` to run pre-flight auth, extend request config, and recover from a single 401.
- **AuthProcessor**: Manages authentication lifecycle. Calls `authStrategy.authenticate(client)` directly (no `authResult` caching). Uses `@DeduplicateInflight` on `performAuthenticate()` for single-flight guarantee.
- **AuthStrategy** (interface): Full class-based strategy with `authenticate(client: RestClient): Promise<void>`, `isAuthenticated(): boolean`, `extendRequest(config): AxiosRequestConfig`, `invalidate(): void`.
- **AuthRestModule**: Dynamic NestJS module. Accepts `{ httpService, resilience?, axios?, hooks? }`.
- **@DeduplicateInflight**: Method decorator using `Wrap` from `base-decorators`. Coalesces concurrent calls with the same key into a single promise. The decorated class must expose `inflightMap: Map<string, Promise<unknown>>`.
- **RestModule**: Dynamic NestJS module. `registerAsync` creates an internal `HttpModule` from axios config. `fromHttpService` accepts a pre-resolved `HttpService` (used by `AuthRestModule`).
- **RxJS resilience operators**: New optional fields in `ResilanceConfig` — `deduplication`, `rateLimit`, `timeLimiter`, `throttle` — implemented as RxJS operators applied to the Observable in `callUnderlying`.
- **Timeout conflict resolution**: If `axios.timeout` is set in module options, `resilience.timeout` must be stripped before constructing `RestClient` to avoid competing timeouts.

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

### Pattern 4: HookableHttpService 
**HooksConfig interface**:

```typescript
export interface HooksConfig {
  // Transform verb invocation args before callUnderlying executes.
  // Must return a new InvokeArgs (treat input as immutable).
  onInvoke?: (verb: HttpVerb, args: InvokeArgs) => InvokeArgs | Promise<InvokeArgs>
  // Observe or substitute the response after callUnderlying returns.
  // Must return a new AxiosResponse (treat input as immutable).
  onReturn?: (verb: HttpVerb, args: InvokeArgs, response: AxiosResponse) => AxiosResponse | Promise<AxiosResponse>
  // Receive the error if callUnderlying throws. Can rethrow (to propagate)
  // or remain silent to let the caller handle it.
  onError?: (verb: HttpVerb, args: InvokeArgs, error: unknown) => void | never
}
```

**New HookableHttpService dispatch override**:

```typescript
export class HookableHttpService extends BaseHttpService {
  constructor(httpService: HttpServiceLike, private readonly hooks?: HooksConfig) {
    super(httpService)
  }

  protected override async dispatch<T = unknown>(
    verb: HttpVerb,
    args: InvokeArgs,
  ): Promise<AxiosResponse<T>> {
    const resolvedArgs = this.hooks?.onInvoke
      ? await this.hooks.onInvoke(verb, args)
      : args
    try {
      const response = await super.dispatch<T>(verb, resolvedArgs)
      return this.hooks?.onReturn
        ? await this.hooks.onReturn(verb, resolvedArgs, response)
        : response
    } catch (error) {
      this.hooks?.onError?.(verb, resolvedArgs, error)
      throw error
    }
  }
}
```

**CRITICAL**: `RestClient` and `AuthRestClient` must pass `hooks` through to `super(httpService, hooks)`. The `RestModule` and `AuthRestModule` must accept `hooks?: HooksConfig` in options and pass it through to the client constructor.

### Pattern 5: RxJS Resilience Operators in ResilanceConfig

**Context**: Four new RxJS-based operators are added to `ResilanceConfig` and applied to the HttpService Observable BEFORE `firstValueFrom` in `callUnderlying`.

**Key insight**: `@nestjs/axios` `HttpService` returns `Observable<AxiosResponse>`. The existing `callUnderlying` uses `firstValueFrom(observable)`. Insert RxJS operator pipeline between the observable and `firstValueFrom`.

**RxJS 7.8.2** is already installed as a transitive dependency of `@nestjs/axios`. No additional packages needed.

**New ResilanceConfig fields**:

```typescript
export interface ResilanceConfig<T, S = void, R = unknown> {
  // ... existing fields ...
  /** Deduplicate concurrent requests to the same endpoint (same verb+url key). */
  deduplication?: DeduplicationConfig
  /** Rate limiting with token-bucket or leaky-bucket algorithm. */
  rateLimit?: RateLimitConfig
  /** Per-request timeout with RxJS timeout operator (cooperative cancellation). */
  timeLimiter?: TimeLimiterConfig
  /** Throttle emissions — allow one request per `duration` ms window. */
  throttle?: ThrottleConfig
}
```

**Operator implementations**:

```typescript
// Deduplication: shareReplay per URL key
// Map<key, Observable> where key = `${verb}:${url ?? config.url}`
// Each key maps to an Observable<AxiosResponse> wrapped in shareReplay({ bufferSize: 1, refCount: true })
// so concurrent callers for the same key share one network call

// Rate Limiter: concatMap + delay for leaky bucket (queue all, emit at fixed rate)
// Token bucket: BehaviorSubject for token count, zip with source
import { throttleTime, timeout as rxjsTimeout, concatMap, of, delay, shareReplay } from 'rxjs'

// Throttle: throttleTime(duration) — emit first, ignore rest for duration ms
observable.pipe(throttleTime(config.throttle.duration))

// Time Limiter: RxJS timeout operator
import { timeout as rxjsTimeout } from 'rxjs'
observable.pipe(rxjsTimeout({ each: config.timeLimiter.duration }))
// TimeoutError is thrown when duration elapses
```

**Implementation location**: `BaseHttpService.callUnderlying` applies the RxJS pipeline when `rxjsConfig` is provided. OR: a new `rxjsPipelineBuilder` function (parallel to `resiliencePolicyBuilder`) composes RxJS operators from config.

**CRITICAL**: The RxJS pipeline operators are applied to the `Observable` returned by `invokeVerb(httpService, verb, args)` BEFORE the branch that checks `isObservable(result)`. For non-Observable (Promise) returns, the RxJS pipeline does NOT apply — this is fine because `RestClient` wraps `HttpService` (Observable-based), and the RxJS pipeline is relevant there.

**Deduplication key derivation**: `${verb}:${url ?? config.url ?? ''}` — combines HTTP method and URL into a string key. The `InvokeArgs` carrier has `url` (for most verbs) or `config.url` (for `request` verb).

### Pattern 6: Axios Timeout vs Policy Timeout Conflict Resolution

**Problem**: If both `axios.timeout` (in `HttpModuleOptions`) and `resilience.timeout` (cockatiel `TimeoutPolicy`) are set, they compete. The axios timeout fires at the HTTP layer; the cockatiel timeout fires at the policy layer. The axios timeout can cancel a request before the policy timeout, making the policy timeout redundant and potentially causing confusing behavior.

**Solution**: In both `RestModule.forRootAsync` and `AuthRestModule.forRootAsync`, when constructing `RestClient`, strip `timeout` from the resilience config if `opts.axios?.timeout` is set.

```typescript
function resolveResilience(opts: RestModuleOptions): ResilanceConfig<unknown> | undefined {
  if (opts.axios?.timeout && opts.resilience?.timeout !== undefined) {
    const { timeout: _dropped, ...rest } = opts.resilience ?? {}
    return rest
  }
  return opts.resilience
}
// Usage in RestClient provider factory:
new RestClient(httpService, resolveResilience(opts))
```

**README guidance**: Document both timeout mechanisms, when to use each, and the auto-stripping behavior. Example:

```typescript
// axios.timeout overrides policy timeout — no policy timeout will be set
RestModule.forRootAsync({
  useFactory: () => ({
    axios: { baseURL: 'https://api.example.com', timeout: 5_000 },
    resilience: ResiliencePresets.CONSERVATIVE, // timeout:60s stripped automatically
  }),
})
```

### Pattern 7: Zero-Config RestModule (class-level module import)

**Context**: Users should be able to import `RestModule` directly (without `forRootAsync`) for zero-configuration use.

**NestJS pattern**: The `@Module({})` decorator on the `RestModule` class itself serves as the default no-config registration. When `imports: [RestModule]` is used (without calling `forRootAsync`), NestJS uses the class-level module metadata.

**Implementation**: Update `RestModule` class-level `@Module` decorator:

```typescript
@Module({
  imports: [HttpModule],
  providers: [
    {
      provide: RestClient,
      useFactory: (http: HttpService) => new RestClient(http),
      inject: [HttpService],
    },
  ],
  exports: [RestClient],
})
export class RestModule { ... }
```

**Constraint**: `HttpModule` imported at class level uses axios defaults (no `baseURL`). This is intentional for zero-config usage — the consumer sets `baseURL` per-request or via a different mechanism.

**E2e test required**: Verify `imports: [RestModule]` works and `RestClient` is injectable. Test must make a real HTTP call to prove the client works without any configuration.

### Pattern 8: AuthRestModuleOptions extending RestModuleOptions

**Context**: `AuthRestModuleOptions` must extend `RestModuleOptions` to support `axios`, `hooks`, and `resilience` fields in addition to the required `httpService`.

**New interface**:

```typescript
// RestModuleOptions (unchanged):
interface RestModuleOptions {
  axios?: HttpModuleOptions
  resilience?: ResilanceConfig<unknown>
  hooks?: HooksConfig
}

// AuthRestModuleOptions extends RestModuleOptions:
interface AuthRestModuleOptions extends RestModuleOptions {
  httpService: HttpService
}
```

**CRITICAL**: When `axios` is provided to `AuthRestModuleOptions`, `AuthRestModule.forRootAsync` must configure the internal `HttpModule` with it. Currently `AuthRestModule` imports `HttpModule` (no config). After the change, it must import `HttpModule.registerAsync(...)` if `opts.axios` is non-empty.

**Impact on AuthRestModule.forRootAsync**: The `RestModule.forHttpService` call must forward `opts.axios` to configure the RestClient's HttpService. Currently `RestModule.forHttpService` only accepts `{ httpService, resilience? }` — it does NOT create a new HttpModule (the httpService is pre-resolved). If axios config needs to apply, the httpService must already carry it. The factory chain:

```
AuthRestModule.forRootAsync useFactory → returns AuthRestModuleOptions
  → HttpModule.registerAsync(opts.axios) → creates HttpService with axios config
  → RestModule.forHttpService(httpService from above, opts.resilience) → creates RestClient
```

This means `AuthRestModule` must also conditionally use `HttpModule.registerAsync` with `opts.axios` when it's provided.

### Pattern 9: Static auth via RestClient (no AuthRestModule needed)

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
| **AuthRestClient `authProcessor` field must be public** | High | Module wiring, tests, and adapters read `client.authProcessor` directly |
| **Single-source-of-truth RestClient** | High | `AuthRestClient.restClient` must return the same `RestClient` instance that `AuthRestModule` provides — never create a second instance |
| **`@DeduplicateInflight` key must be constant for auth** | High | Use `() => 'authenticate'` so all concurrent auth calls share one promise |
| **AuthRestClient dispatch: original config for 401 retry** | High | Re-extend from `initialArgs.config` (not from the already-extended `authedArgs.config`) so stale headers are fully replaced |
| **Wrap `method` is already bound** | Low | Do NOT call `method.bind(this)` — base-decorators auto-binds per invocation |
| **RxJS operators only apply to Observable returns** | Medium | `callUnderlying` only applies RxJS pipeline when `isObservable(result)` — Promise returns (e.g. RestClient wrapping RestClient) bypass it |
| **Timeout conflict: axios.timeout + resilience.timeout** | High | Strip `resilience.timeout` when `opts.axios?.timeout` is set in RestModule/AuthRestModule factory — two competing timeouts cause confusing behavior |
| **Zero-config RestModule needs HttpModule imported** | High | Class-level `@Module({ imports: [HttpModule], ... })` on RestModule enables `imports: [RestModule]` without forRootAsync |
| **HookableHttpService rename breaks existing consumers** | High | Export both `BaseHttpService` (new name for old class) AND `HookableHttpService` (new class with hooks) from `src/index.ts` |
| **HooksConfig onError must rethrow to propagate errors** | Medium | `onError` hook is observer-only by contract; if it returns without throwing, the original error is still rethrown by the dispatch override |
| **AuthRestModuleOptions.axios needs HttpModule.registerAsync** | High | When `opts.axios` is set in AuthRestModuleOptions, AuthRestModule must use `HttpModule.registerAsync(opts.axios)` — the plain `HttpModule` import uses no config |
| **RxJS deduplication shareReplay refCount** | Medium | Use `shareReplay({ bufferSize: 1, refCount: true })` — `refCount: true` ensures the observable is garbage-collected when all subscribers unsubscribe |

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

### Pending Refactor: improve-library-usability

The following changes are required by task `improve-library-usability`:

| Change | Details |
|--------|---------|
| Rename `HookableHttpService` → `BaseHttpService` | Rename class in `hookable-http.service.ts`; update all imports; keep file name or rename to `base-http.service.ts` |
| Create new `HookableHttpService extends BaseHttpService` | New class with `HooksConfig` constructor param; overrides `dispatch` to apply hooks; in same file or new file |
| Add `HooksConfig` interface | `{ onInvoke?, onReturn?, onError? }` — all optional |
| Update `RestClient extends HookableHttpService` | Add `hooks?: HooksConfig` param, pass to `super(httpService, hooks)` |
| Update `AuthRestClient extends HookableHttpService` | Add `hooks?: HooksConfig` param, pass to `super(httpService, hooks)` |
| Update `RestModuleOptions` | Add `hooks?: HooksConfig` field |
| Update `AuthRestModuleOptions extends RestModuleOptions` | Gain `axios?`, `hooks?`, `resilience?` from parent; keep required `httpService` |
| Add RxJS resilience fields to `ResilanceConfig` | Add `deduplication?`, `rateLimit?`, `timeLimiter?`, `throttle?` with their config interfaces |
| Apply RxJS pipeline in `callUnderlying` | After `invokeVerb(...)`, if Observable, apply composed RxJS operators before `firstValueFrom` |
| Axios timeout conflict resolution | Helper `resolveResilience(opts)` strips `resilience.timeout` when `opts.axios?.timeout` is set |
| Zero-config RestModule | Add class-level `@Module({ imports: [HttpModule], providers: [RestClient...], exports: [RestClient] })` |
| Update `AuthRestModule.forRootAsync` | Use `HttpModule.registerAsync(opts.axios ?? {})` when `opts.axios` is provided |
| Update `src/index.ts` | Export `BaseHttpService` and updated `HookableHttpService`; export new config interfaces |
| Add e2e test for zero-config | Verify `imports: [RestModule]` compiles and `RestClient` is injectable with real HTTP call |
| Update README | New `Quick Start` section; timeout example; hooks example; RxJS operators docs |

---

## Sources & Verification

| Source | Type | Last Verified |
|--------|------|---------------|
| src/client/hookable-http.service.ts | Internal (verified) | 2026-05-01 |
| src/client/rest.client.ts | Internal (verified) | 2026-05-01 |
| src/client/rest.module.ts | Internal (verified) | 2026-05-01 |
| src/client/resilance.config.ts | Internal (verified) | 2026-05-01 |
| src/client/resailencePolicyBuilder.ts | Internal (verified) | 2026-05-01 |
| src/auth/auth.config.ts | Internal (verified) | 2026-05-01 |
| src/auth/auth-processor.ts | Internal (verified) | 2026-05-01 |
| src/auth/auth-rest.client.ts | Internal (verified) | 2026-05-01 |
| src/auth/auth-rest.module.ts | Internal (verified) | 2026-05-01 |
| src/deduplicate-inflight.decorator.ts | Internal (verified) | 2026-05-01 |
| src/index.ts | Internal (verified) | 2026-05-01 |
| src/resilience.policy.ts | Internal (verified) | 2026-05-01 |
| tests/rest-client.e2e.spec.ts | Internal (verified) | 2026-05-01 |
| node_modules/rxjs/package.json (v7.8.2) | Internal (runtime verified) | 2026-05-01 |
| package.json (all deps verified present) | Internal | 2026-05-01 |
| https://github.com/NeoLabHQ/base-decorators | Official | 2026-04-26 |
| https://github.com/connor4312/cockatiel | Official | 2026-04-26 |
| https://jestjs.io/docs/configuration | Official | 2026-04-26 |
| https://node.testcontainers.org | Official | 2026-04-26 |
| https://rxjs.dev/api/operators/throttleTime | Official (RxJS 7) | 2026-05-01 |
| https://rxjs.dev/api/operators/shareReplay | Official (RxJS 7) | 2026-05-01 |
| .specs/tasks/draft/improve-library-usability.feature.md | Task file | 2026-05-01 |

---

## Changelog

| Date | Changes |
|------|---------|
| 2026-04-26 | Initial creation for task: complete-initial-feature-set |
| 2026-04-26 | Major update: corrected installed vs missing packages, fixed broken import pitfalls, verified from source inspection |
| 2026-04-30 | Major update for task: improve-auth-rest-client — rewrote "Current State vs Target State" to reflect fully implemented codebase; replaced all outdated patterns with actual implemented dispatch override pattern; removed stale @ExecuteWithPolicy/@Authenticate decorator patterns; updated library table to reflect all packages now installed; added class-based AuthStrategy DI pattern; added pending refactor change table; added static auth via RestClient pattern; updated sources to reflect direct file inspection |
| 2026-05-01 | Major update for task: improve-library-usability — verified RxJS 7.8.2 installed; added BaseHttpService/HookableHttpService rename pattern (Pattern 5); added HooksConfig design with onInvoke/onReturn/onError (Pattern 5); added RxJS operator patterns for deduplication/rate limiting/time limiting/throttling (Pattern 6); added axios timeout conflict resolution (Pattern 7); added zero-config RestModule class-level module pattern (Pattern 8); added AuthRestModuleOptions extending RestModuleOptions (Pattern 9); updated Key Concepts, Pitfalls, Pending Refactor, Sources sections throughout |
