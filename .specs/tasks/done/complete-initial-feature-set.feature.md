---
title: Complete initial feature set
---

> **Required Skill**: You MUST use and analyse `nestjs-http-client-architecture` skill before doing any modification to task file or starting implementation of it!
>
> Skill location: `.claude/skills/nestjs-http-client-architecture/SKILL.md`

## Initial User Prompt

- complete initial feature set
- add unit tests, e2e tests
- add usage examples and documentation in README.md

### Context

This project is in initial draft state, it not working, but contain initial architecture. This task requires to complete initial feature set and make it working. Also, refactor draft implementations and cover it with tests.

### Requirements

- rename HttpClient to RestClient
- extract executeRequest from RestClient and make it a standalone decorator using Wrap from base-decorators library. Decorator should be named `@ExecuteWithPolicy` and should be used to decorate all erquest methods in RestClient. Decorator should read `this.policy` from RestClient instance and execute the request with it.
- rename AuthenticatedHttpService to AuthRestClient
- refactor AuthRestClient to use RestClient. It should not use any observable, firstValueFrom and p-retry. Remove withHttpRetry, isRetryableError.
- create AuthStrategyService that receive AuthConfig. It should implement and provide 3 public methods based on AuthConfig. `isAuthenticated()`. `authenticateIfNeeded()`, `extendRequest()`.
    - modify how AuthConfig setup. Instead of existing fields, it should have single field: `authenticate()`. `authenticate()` should receive instance of RestClient and return Promise with this fields: `extendRequest()`, `isAuthenticated()`.
        - `extendRequest()` should receive instance of AxiosRequestConfig and return new instance of AxiosRequestConfig with extended headers.
        - `isAuthenticated()` should return boolean if user is authenticated, and false otherwise.
    - AuthStrategyService should store result of `authenticate()` in private field and return it from `isAuthenticated()` and `extendRequest()`. authenticateIfNeeded should check isAuthenticated and if it is false, it should call `authenticate()` and store the result.
    - Use `@DedublicateInflight` decorator to wrap private `authenticate()` method inside of AuthStrategyService, that called inside of authenticateIfNeeded. It should ensure there no 2 parallel requests to authenticate are done.
- modify AuthRestClient to receiev AuthStrategyService as a constructor argument. Use it to authenticate requests. 
    - create `@Authenticate` decorator that should call `authenticateIfNeeded()` and then extend config param using `extendRequest()` from AuthStrategyService.
    - use OnErrorHook decorator from base-decorators library to handle authentication errors and authenticate again if it us auth error.
- create AuthRestModule that should export AuthRestClient and RestClient and use async factory to build AuthConfig and HttpService. It should accept ResilanceConfig as optional dependency.
- Correct jest unit tests setup for library and cover it with tests. Unit tests should be written for in `src/**/__tests__/*.spec.ts` files in the `src` directory for each module.
    - For unit tests avoid mocking libraries and imports. Use constructors to pass mocks. Refactor the code to make it easier to test, if needed.
    - Setup coverage handling for jest and add jest-it-up to bump tests coverage.
    - Setup stryker for mutation coverage testing, it should have `break: 80` threshold for coverage. Add unit tests until it pass.
    - Ensure that each policy type is covered with combination with http client. Mock only axios and test all combinations that include retries, circuit breakers, bulkheads and fallbacks.
- Setup jest e2e tests, they should be written in `tests/` folder in the root of the project. It should use testcontainers to setup some dummy service and make requests to it.
- Add command to run `test:unit` with coverage, `test:e2e`, `test:mutation` to the package.json scripts. And `test` command to run all of them, one by one.
- Update contributing guide with new commands and how to run them.
- Rename build.yaml to verify.yaml and correct if need.
- Update readme with quick start, usage examples and API reference.


## Description

The library is currently in a non-working draft state with two diverging HTTP client implementations: `HttpClient` (cockatiel-based resilience) and `AuthenticatedHttpService` (parallel `p-retry`-based retry plus a rigid token/header auth shape). Tests are not wired up (an orphan Jest-style spec coexists with a Vitest smoke test), and the README documents features that do not yet exist. This task brings the library to a publishable v1.0 baseline by consolidating to a single resilient client (`RestClient`), layering a pluggable auth strategy on top of it (`AuthRestClient` + `AuthStrategyService` + `AuthConfig`), exposing both via a NestJS dynamic module (`AuthRestModule`) with an async factory, and standing up three test gates (Jest unit with coverage + `jest-it-up` ratchet, Jest e2e via `testcontainers`, Stryker mutation testing with `break: 80`) wired into a renamed `verify.yaml` CI workflow.

The auth redesign is the most consequential public-API change: `AuthConfig` collapses from four fields to a single `authenticate(restClient: RestClient): Promise<{ isAuthenticated(): boolean; extendRequest(config: AxiosRequestConfig): AxiosRequestConfig }>` factory, allowing consumers to implement any auth scheme (Basic, Bearer, OAuth client credentials, request signing, mTLS) without subclassing the client. `AuthStrategyService` owns the lifecycle: it caches the resolved auth handle, exposes `isAuthenticated()`, `authenticateIfNeeded()`, and `extendRequest()`, and uses `@DeduplicateInflight` to single-flight concurrent re-auths. `AuthRestClient` composes `RestClient` and `AuthStrategyService` via two decorators built on `base-decorators`: `@Authenticate` (calls `authenticateIfNeeded()` and transforms the request config) and `OnErrorHook` (detects HTTP 401, forces re-auth, retries once). The `executeRequest` plumbing currently inlined inside `HttpClient` is extracted into an `@ExecuteWithPolicy` decorator that reads `this.policy` at call time, eliminating per-method duplication.

Consumers are NestJS application authors who today cannot adopt the library because the authenticated client is rigid and the test posture does not support trusting the resilience pipeline. After this task, they register `AuthRestModule.forRootAsync({ ... })` with their own `authenticate` callback and a chosen resilience preset (default `CONSERVATIVE`), inject `AuthRestClient` (or the bare `RestClient`), and call HTTP methods that automatically apply retry / circuit-breaker / bulkhead / fallback policy and refresh auth on 401. Library maintainers gain a deterministic test harness, a coverage ratchet, an 80% mutation gate, and a CI workflow that exercises all of them. The README's roadmap features (cache, rate limiter, throttling, deep OpenTelemetry, etc.) remain out of scope here and continue to live in the README as future work.

**Scope**:

- Included:
  - Rename `HttpClient` → `RestClient`; rename `AuthenticatedHttpService` → `AuthRestClient`.
  - Extract request-execution into `@ExecuteWithPolicy` (built on `Wrap` from `base-decorators`); apply to every public request method on `RestClient`.
  - Refactor `AuthRestClient` to compose `RestClient` (no rxjs, no `firstValueFrom`, no `p-retry`, no local retry / `isRetryableError` helpers).
  - Redesign `AuthConfig` to a single `authenticate(restClient)` factory returning `{ isAuthenticated, extendRequest }`.
  - Add `AuthStrategyService` (`isAuthenticated()`, `authenticateIfNeeded()`, `extendRequest()`) with a `@DeduplicateInflight`-wrapped private `authenticate()`.
  - Add `@Authenticate` decorator and apply `OnErrorHook` from `base-decorators` for HTTP 401 re-auth-and-retry-once.
  - Add `AuthRestModule` with an async factory accepting an optional `ResilanceConfig`; export `AuthRestClient` and `RestClient`.
  - Set up Jest unit tests under `src/**/__tests__/*.spec.ts` using constructor-injected mocks (no library-level mocks); configure coverage and `jest-it-up`.
  - Set up Stryker mutation testing with `break: 80`.
  - Cover each cockatiel policy type (retry, circuit breaker, bulkhead, fallback) integrated with `RestClient` (mocking only axios), including meaningful combinations.
  - Set up Jest e2e tests in `tests/` using `testcontainers` against a dummy HTTP service.
  - Add npm scripts: `test:unit` (with coverage), `test:e2e`, `test:mutation`, and `test` (sequential aggregate).
  - Update CONTRIBUTING.md with the new commands and prerequisites (Docker for e2e).
  - Rename `.github/workflows/build.yaml` to `verify.yaml`; run the new `test` chain alongside `build`.
  - Update README with quick-start, usage examples (RestClient, AuthRestClient with example `authenticate` callbacks), and API reference for the implemented surface.

- Excluded:
  - Per-preset timeout enforcement (README's documented per-preset timeouts remain on the underlying axios instance).
  - Any new resilience pattern beyond retry / circuit breaker / bulkhead / fallback (no cache, rate limiter, throttling, time limiter, HTTP-level deduplication, before/after hooks, conditional-retry helpers, stop/wait strategy abstractions, health checks).
  - Deep OpenTelemetry integration.
  - New resilience presets beyond `CONSERVATIVE`, `RESTFULL`, `LOW_QUALITY`.
  - Publishing the package to npm.
  - Migration guide (project is v0.1.0 / not working — no live consumers).
  - Treating 403 (or other status codes) as auth errors; only HTTP 401 triggers re-auth.

**User Scenarios**:

1. **Primary Flow**: Consumer registers `AuthRestModule.forRootAsync({ ... })` with their `authenticate` callback; an injected `AuthRestClient.get('/protected')` triggers `authenticateIfNeeded()`, applies `extendRequest` to the request config, and runs the call through the `RestClient` policy, returning the response.
2. **Alternative Flow (concurrent first-time auth)**: Two parallel calls before any auth handle exists result in a single underlying `authenticate()` invocation thanks to `@DeduplicateInflight`; both calls share the resolved handle.
3. **Alternative Flow (401 re-auth)**: A request that returns HTTP 401 triggers `OnErrorHook` to force re-auth and retry the call once; success on the second attempt returns to the caller.
4. **Error Handling**: Repeated 401 propagates after one retry; non-401 errors propagate without re-auth; bulkhead-rejected and circuit-open errors propagate immediately; underlying network errors are handled by the `RestClient` policy (retry per config) before reaching the auth layer.

---

## Acceptance Criteria

### Functional Requirements

- [X] **`RestClient` replaces `HttpClient`**:
  - Given the library is built and exported,
  - When the package is imported,
  - Then `RestClient` is exported and `HttpClient` is not present in the public surface.

- [X] **All `RestClient` request methods run through the configured policy**:
  - Given a `RestClient` constructed with `retry: { maxAttempts: 2 }` and an axios mock that fails once then succeeds,
  - When `restClient.get(url)` is called,
  - Then the underlying axios call is invoked exactly twice and the second response is returned.

- [X] **`@ExecuteWithPolicy` reads `this.policy` at call time**:
  - Given a class with `policy` set to a stub `IPolicy` and a method decorated with `@ExecuteWithPolicy`,
  - When the decorated method is called,
  - Then `policy.execute(...)` is invoked with a function that, when run, calls the original method body with the original arguments.

- [X] **`request()` forwards the policy context's `signal` to axios**:
  - Given `RestClient.request({...})` is called inside a policy whose execution context exposes a `signal`,
  - When the underlying axios call is made,
  - Then the axios config received contains the policy context's `signal` (preserving today's cancellation behaviour).

- [X] **`AuthRestClient` replaces `AuthenticatedHttpService` and composes `RestClient`**:
  - Given the library is built and exported,
  - When the package is imported and the `AuthRestClient` source is inspected,
  - Then `AuthRestClient` is exported, `AuthenticatedHttpService` is not, and the `AuthRestClient` source contains zero imports of `rxjs` and zero imports of `p-retry`.

- [X] **`AuthConfig` has a single `authenticate` field**:
  - Given the `AuthConfig` type is in scope,
  - When a consumer type-checks an `AuthConfig` value,
  - Then only `authenticate(restClient: RestClient): Promise<{ isAuthenticated(): boolean; extendRequest(config: AxiosRequestConfig): AxiosRequestConfig }>` is required, and the legacy fields (`endpoint`, `requestBuilder`, `responseExtractor`, `headerBuilder`) are not present.

- [X] **`AuthStrategyService.authenticateIfNeeded` skips authentication when already authenticated**:
  - Given a stub `AuthConfig.authenticate` returning a handle whose `isAuthenticated()` returns `true`, and `authenticateIfNeeded()` has been called once,
  - When `authenticateIfNeeded()` is called again,
  - Then the stub `AuthConfig.authenticate` is invoked exactly once across both calls.

- [X] **`AuthStrategyService` deduplicates concurrent re-auths**:
  - Given a stub `AuthConfig.authenticate` that resolves after a delay (e.g. 50 ms) and no prior handle,
  - When two `authenticateIfNeeded()` calls are issued in parallel,
  - Then the stub is invoked exactly once and both calls resolve to the same handle.

- [X] **`@Authenticate` extends the request config**:
  - Given a method `m(url, config)` decorated with `@Authenticate`, and an `extendRequest` that returns a config containing `Authorization: Bearer X`,
  - When `m('/x', { headers: { y: 'z' } })` is called,
  - Then the wrapped method receives a config with both `Authorization: Bearer X` and `y: 'z'` in its headers.

- [X] **HTTP 401 triggers exactly one re-auth and retry**:
  - Given an `AuthRestClient` whose underlying request throws an axios 401 once and then succeeds,
  - When a request method is called,
  - Then `authenticateIfNeeded()` is invoked twice (initial + after-401), the underlying request is invoked twice, and the final result is the success response.

- [X] **Repeated HTTP 401 propagates after one retry**:
  - Given an `AuthRestClient` whose underlying request throws an axios 401 twice in a row,
  - When a request method is called,
  - Then the underlying request is invoked exactly twice, and the second 401 propagates as the rejection.

- [X] **Non-401 errors do not trigger re-auth**:
  - Given an `AuthRestClient` whose underlying request throws an axios 500,
  - When a request method is called,
  - Then `authenticateIfNeeded()` is invoked exactly once (the initial pre-flight) and the rejection is the original 500.

- [X] **`AuthRestModule.forRootAsync` exports both clients**:
  - Given a NestJS testing module that imports `AuthRestModule.forRootAsync({ useFactory, inject })`,
  - When the testing module is bootstrapped,
  - Then both `AuthRestClient` and `RestClient` resolve from the test bed.

- [X] **`AuthRestModule` defaults to the `CONSERVATIVE` preset when no `ResilanceConfig` is provided**:
  - Given an `AuthRestModule.forRootAsync({ ... })` registration whose factory returns an options object without a `resilanceConfig`,
  - When the module is bootstrapped,
  - Then the constructed `RestClient`'s policy reflects the `CONSERVATIVE` preset (e.g. retry `maxAttempts = 3` for safe methods, default circuit breaker).

- [X] **`npm run test:unit` runs all `src/**/__tests__/*.spec.ts` and reports coverage**:
  - Given a clean `npm install`,
  - When `npm run test:unit` is executed,
  - Then every spec under `src/**/__tests__/*.spec.ts` is discovered and executed, and a coverage summary is printed.

- [X] **`jest-it-up` ratchets the coverage floor**:
  - Given `test:unit` runs at coverage X% above the current jest-it-up floor,
  - When the post-run `jest-it-up` step runs,
  - Then the coverage thresholds in the Jest configuration are bumped to at least X% (and a regression below the floor causes a non-zero exit).

- [X] **`npm run test:mutation` enforces a mutation score of at least 80%**:
  - Given a clean install with Stryker configured to use Jest as the test runner and `break: 80`,
  - When `npm run test:mutation` is executed,
  - Then Stryker reports a mutation score >= 80% and exits 0.

- [X] **All four cockatiel policy types are exercised in combination with `RestClient`**:
  - Given a unit-test suite that mocks only axios at the adapter level,
  - When the suite runs,
  - Then retry, circuit breaker, bulkhead, and fallback each have at least one combined-with-`RestClient` test, and at least one test exercises a composed pipeline that includes more than one policy type.

- [X] **`npm run test:e2e` starts a testcontainers dummy service and exercises the clients**:
  - Given a clean install with Docker available,
  - When `npm run test:e2e` is executed,
  - Then a container is started, the suite runs against its URL using a real `RestClient` / `AuthRestClient`, the container is torn down, and the script exits 0.

- [X] **`npm run test` runs unit, e2e, and mutation in sequence**:
  - Given a clean install,
  - When `npm run test` is executed,
  - Then all three sub-suites run sequentially and a failure in any sub-suite aborts the chain with a non-zero exit code.

- [X] **`verify.yaml` replaces `build.yaml` and runs the test chain**:
  - Given a push or PR to `master`,
  - When the GitHub Actions workflow runs,
  - Then a workflow file `.github/workflows/verify.yaml` exists, `.github/workflows/build.yaml` does not, and the workflow runs `npm run test` and `npm run build`.

- [X] **CONTRIBUTING.md documents the new test commands**:
  - Given the CONTRIBUTING.md file is read,
  - When a new contributor follows it,
  - Then they learn how to run `test:unit`, `test:e2e`, `test:mutation`, and `test`, and what prerequisites apply (Docker for e2e).

- [X] **README documents quick-start, usage, and API reference for the implemented surface**:
  - Given the README.md file is read,
  - When a new consumer follows the quick-start,
  - Then they can register `AuthRestModule.forRootAsync` with an example `authenticate` callback (Basic and Bearer variants documented), invoke a request via `AuthRestClient` / `RestClient`, and find documented entries for every public class (`RestClient`, `AuthRestClient`, `AuthStrategyService`, `AuthRestModule`), config (`AuthConfig`, `ResilanceConfig`, presets), and decorator (`@ExecuteWithPolicy`, `@Authenticate`, `@DeduplicateInflight`).

### Non-Functional Requirements

- [X] **Mutation score**: Stryker reports a mutation score of at least 80% (`break: 80`).
- [X] **Unit-suite latency**: `npm run test:unit` completes in under 60 seconds on a developer machine.
- [X] **E2E-suite latency**: `npm run test:e2e` completes in under 2 minutes on a developer machine with Docker available.
- [X] **No library-level mocks**: no spec under `src/**/__tests__/*.spec.ts` uses `jest.mock('<library>')` for axios, cockatiel, `@nestjs/axios`, `base-decorators`, `nestjs-log-decorator`, or `p-retry`; all collaborators are passed in via constructors.
- [X] **No rxjs / p-retry leakage in `AuthRestClient`**: `src/auth/` source files contain zero imports of `rxjs` and zero imports of `p-retry`.
- [X] **Deterministic tests**: unit and e2e tests do not depend on real wall-clock waits; any time-based behaviour uses fake timers or small fixed intervals managed by the test.
- [X] **Public-API typing**: every public class, decorator, and config type ships with TypeScript types; `any` does not appear in the new public surface except where inherited from `axios` or `@nestjs/axios`.

### Definition of Done

- [X] All acceptance criteria pass.
- [X] `npm run test` exits 0 (unit + e2e + mutation chained).
- [X] `npm run build` produces a `dist/` containing the new public surface (`RestClient`, `AuthRestClient`, `AuthStrategyService`, `AuthRestModule`, `AuthConfig`, `ResilanceConfig`, `@ExecuteWithPolicy`, `@Authenticate`, `@DeduplicateInflight`, presets).
- [ ] `verify.yaml` runs in CI on push/PR to `master` and is green.
- [X] CONTRIBUTING.md and README.md are updated to match the implemented surface.
- [X] No references to `HttpClient` (the old class), `AuthenticatedHttpService`, the old `AuthConfig` shape (`endpoint`/`requestBuilder`/`responseExtractor`/`headerBuilder`), `withHttpRetry`, or local `isRetryableError` helpers remain in `src/`.
- [ ] Code reviewed and merged.

---

## Solution Strategy

### References

- **Skill**: `.claude/skills/nestjs-http-client-architecture/SKILL.md`
- **Codebase Analysis**: `.specs/analysis/analysis-complete-initial-feature-set.md`
- **Scratchpad**: `.specs/scratchpad/9694717b.md`

**Architecture Pattern**: Layered architecture + Decorator pattern + DI/Factory module — Layered separates transport (`RestClient`) from auth (`AuthRestClient` + `AuthStrategyService`) from composition (`AuthRestModule`), matching the existing `src/client/` vs `src/auth/` directory split. Decorator centralises cross-cutting concerns (policy execution, authentication, deduplication) per-method via `Wrap`-based decorators, with codebase precedent in `src/deduplicate-inflight.decorator.ts`. Factory + DI is the NestJS-idiomatic wiring for optional config (`forRootAsync`).

**Approach**: Replace the two divergent draft clients (`HttpClient` + `AuthenticatedHttpService`) with a layered, decorator-driven design: `RestClient` is a thin transport that runs every verb through a cockatiel `IPolicy` via `@ExecuteWithPolicy`; `AuthRestClient` composes `RestClient` and an `AuthStrategyService` and decorates every verb with `@Authenticate`. Authentication state lives in `AuthStrategyService` with a `@DeduplicateInflight`-wrapped `performAuthenticate` for single-flight semantics. A new `AuthRestModule.forRootAsync` wires the three pieces together via NestJS factories, accepting an optional `ResilanceConfig` that defaults to the `CONSERVATIVE` preset. All decorators are built on `Wrap` (and `OnErrorHook` for 401) from `base-decorators@1.1.0`. Test posture migrates from vitest to Jest 29 + ts-jest with constructor-injected mocks (no library mocks), `jest-it-up` for ratcheted coverage, Stryker v8 for an 80% mutation gate, and testcontainers (`kennethreitz/httpbin`) for e2e. The CI workflow is renamed `build.yaml` → `verify.yaml` and runs the new aggregate `test` chain alongside `build`.

### Key Decisions

1. **Decorator-centric layered composition over inheritance/interceptors** — chosen because the task mandates `@ExecuteWithPolicy` and `@Authenticate` (Wrap-based) and `OnErrorHook` for 401. The existing `DeduplicateInflight` decorator is the direct in-codebase precedent.
2. **Single auth-handle factory `AuthConfig.authenticate(restClient)`** — collapses the rigid four-field config into one async factory returning `{ isAuthenticated, extendRequest }`. Storage is owned by `AuthStrategyService`, not the consumer.
3. **`@DeduplicateInflight` on `AuthStrategyService.performAuthenticate` (NOT `authenticateIfNeeded`)** — `authenticateIfNeeded` short-circuits when already authed; only the actual network call needs single-flight protection. Constant key `'authenticate'`.
4. **Default to `CONSERVATIVE` preset in both `RestClient` constructor and `AuthRestModule`** — preserves current behaviour and matches the README. `AuthRestModule` resolves `opts.resilanceConfig ?? resiliencePolicyPresets[ResilencePresets.CONSERVATIVE]` in its `RestClient` factory.
5. **`base-decorators@1.1.0` from npm; internal `src/base-decorators/` shim only as fallback** — the skill verified the package via `npm pack`. Install primary; only fallback to in-tree shim if registry verifies absent at install time.
6. **Separate `tsconfig.test.json` for jest** — root `tsconfig.json` must keep `moduleResolution: "bundler"` for `tsdown`. Test config overrides to `commonjs`/`node`. No path aliases anywhere; relative imports throughout.
7. **Constructor-injected mocks; no `jest.mock(...)` of libraries** — enforced by NFR. All collaborators are constructor parameters cast to the public interface inside specs.

### Trade-offs Accepted

- An extra config file (`tsconfig.test.json`) in exchange for clean tsdown/jest separation.
- Two HTTP-call paths in `AuthRestClient` (initial + post-401 retry) inside the decorator instead of a generic policy retry — required by the spec's "exactly one re-auth and retry" semantic.
- `@Authenticate` knowing which arg index holds the config (1 vs 2 by method name) — cleanest way to mutate the right argument without changing every verb's signature.

---

## Architecture Decomposition

| Component | File path | Responsibility | Dependencies |
|-----------|-----------|----------------|--------------|
| `RestClient` | `src/client/rest.client.ts` | Transport layer. Thin `HttpService` wrapper running every verb through cockatiel `IPolicy` via `@ExecuteWithPolicy`. Implements `Loggable`. Constructor defaults to `CONSERVATIVE` preset. | `HttpService`, `ResilanceConfig`, `resiliencePolicyBuilder`, presets, `@ExecuteWithPolicy`, `firstValueFrom` |
| `@ExecuteWithPolicy` | `src/client/execute-with-policy.decorator.ts` | Method decorator (Wrap-based). Reads `context.target.policy`; executes original method body inside `policy.execute(async (ctx) => firstValueFrom(method(...args)))`. For `request` only: spread `signal: ctx.signal` into `args[0]` before invoking `method`. Unique exclusion key `Symbol('executeWithPolicy')`. | `Wrap`, cockatiel `IPolicy`, `IDefaultPolicyContext`, rxjs `firstValueFrom` |
| `AuthRestClient` | `src/auth/auth-rest.client.ts` | Authenticated transport. Composes `RestClient` + `AuthStrategyService`. Each verb is a thin forwarder to the underlying `RestClient` and is decorated with `@Authenticate`. Public `authStrategy` field readable by decorator. **Zero rxjs / p-retry imports.** | `RestClient`, `AuthStrategyService`, `@Authenticate`, axios types |
| `AuthStrategyService` | `src/auth/auth-strategy.service.ts` | Owns auth lifecycle. Public: `isAuthenticated()`, `authenticateIfNeeded()`, `extendRequest(config)`, `clearAuth()`. Holds `inflightMap` + cached `authResult`. Private `performAuthenticate()` decorated with `@DeduplicateInflight(() => 'authenticate')`. | `AuthConfig`, `RestClient`, `@DeduplicateInflight` |
| `@Authenticate` | `src/auth/authenticate.decorator.ts` | Method decorator (Wrap-based). Steps: (1) `await ctx.target.authStrategy.authenticateIfNeeded()`; (2) compute config arg index by `propertyKey`; (3) replace `args[idx]` via `extendRequest(args[idx] ?? {})`; (4) call `method(...args)`; (5) on `isAxiosError(err) && err.response?.status === 401`: `clearAuth()` → `authenticateIfNeeded()` → re-extend → retry **once**; non-401 / non-axios errors rethrow unchanged. Unique exclusion key `Symbol('authenticate')`. | `Wrap`, `OnErrorHook`, `axios.isAxiosError`, `AuthStrategyService` |
| `AuthConfig` / `AuthStrategy` | `src/auth/auth.config.ts` | Type-only public surface. `AuthConfig = { authenticate(client: RestClient): Promise<AuthStrategy> }`. `AuthStrategy = { isAuthenticated(): boolean; extendRequest(config: AxiosRequestConfig): AxiosRequestConfig }`. | axios types, `RestClient` |
| `AuthRestModule` | `src/auth/auth-rest.module.ts` | NestJS dynamic module. `forRootAsync({ useFactory, inject?, imports? })` returning `DynamicModule`. Providers: `AUTH_MODULE_OPTIONS`, `RestClient`, `AuthStrategyService`, `AuthRestClient`. Exports `AuthRestClient` + `RestClient`. Default `resilanceConfig = resiliencePolicyPresets[ResilencePresets.CONSERVATIVE]`. | NestJS DI, `HttpService`, services + clients, presets |
| `@DeduplicateInflight` (FIX) | `src/deduplicate-inflight.decorator.ts` | Existing decorator. Replace broken `import { KeyBuilder } from './cache.decorator'` with locally defined `type KeyBuilder<TArgs extends unknown[]> = (...args: TArgs) => string`. | `Wrap` |
| `shouldRetry.ts` (FIX) | `src/shouldRetry.ts` | Fix inverted method-list check at L24: `if (isMethodInList(error, methods))` → `if (!isMethodInList(error, methods))`. | axios |
| `base-decorators` shim (FALLBACK) | `src/base-decorators/` | If `npm install base-decorators@1.1.0` fails, expose `Wrap` and `OnErrorHook` matching the inferred signature (`Wrap<TThis, TArgs, TReturn>(wrapper, exclusionKey?)`). NOT created if npm install succeeds. | none |

### Layer Mapping (Clean Architecture)

- **Domain (types)**: `AuthConfig`, `AuthStrategy`, `ResilanceConfig`, `RetryConfig`, `CircuitBreakerConfig`, `BulkheadConfig`, `FallbackConfig` — pure TS types, zero infra imports.
- **Use cases / application services**: `AuthStrategyService`, `resiliencePolicyBuilder`.
- **Adapters**: `RestClient`, `AuthRestClient`, `@ExecuteWithPolicy`, `@Authenticate`, `@DeduplicateInflight`.
- **Frameworks/drivers**: `AuthRestModule` (NestJS DI), `HttpService` (axios), cockatiel, base-decorators.

### Interactions

```
                   AuthRestModule.forRootAsync
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
        RestClient ──► AuthStrategyService ──► AuthRestClient
              │              ▲                       │
              │              │ uses                  │ composes
              ▼              │                       ▼
   @ExecuteWithPolicy        │                @Authenticate
              │              │                       │
              ▼              │                       ▼
       cockatiel             │                AuthStrategyService
       IPolicy               │                       │
              │              └───────────────────────┘
              ▼
       @nestjs/axios HttpService → axios
```

---

## Expected Changes

```
src/
├── client/
│   ├── http.client.ts                            # DELETE
│   ├── rest.client.ts                            # NEW (RestClient + @ExecuteWithPolicy on every verb)
│   ├── execute-with-policy.decorator.ts          # NEW
│   ├── resilance.config.ts                       # KEEP
│   ├── resailencePolicyBuilder.ts                # KEEP
│   └── __tests__/
│       ├── rest.client.spec.ts                   # NEW (verbs × policy combinations; signal forwarding; default preset)
│       ├── execute-with-policy.decorator.spec.ts # NEW
│       └── resilience-policy-builder.spec.ts     # NEW
├── auth/
│   ├── authenticated-http.service.ts             # DELETE
│   ├── auth-rest.client.ts                       # NEW (composes RestClient + @Authenticate)
│   ├── auth-strategy.service.ts                  # NEW (lifecycle + @DeduplicateInflight)
│   ├── authenticate.decorator.ts                 # NEW (@Authenticate)
│   ├── auth.config.ts                            # NEW (AuthConfig + AuthStrategy types)
│   ├── auth-rest.module.ts                       # NEW (forRootAsync)
│   └── __tests__/
│       ├── auth-rest.client.spec.ts              # NEW
│       ├── auth-strategy.service.spec.ts         # NEW (single-flight; skip-when-authed; clearAuth)
│       ├── authenticate.decorator.spec.ts        # NEW (config-arg index; 401 once; non-401 propagate)
│       └── auth-rest.module.spec.ts              # NEW (bootstrap; default preset; both clients exported)
├── deduplicate-inflight.decorator.ts             # MODIFY (remove ./cache.decorator import; KeyBuilder local)
├── deduplicate-inflight.decorator.spec.ts        # DELETE (moved → src/__tests__/)
├── shouldRetry.ts                                # MODIFY (fix inverted logic at L24)
├── resilence.policy.ts                           # KEEP
├── axios.ts                                      # KEEP
├── __tests__/
│   ├── should-retry.spec.ts                      # NEW (covers bug fix + all branches)
│   └── deduplicate-inflight.decorator.spec.ts    # MOVE (from src/) + fix imports → relative paths
├── base-decorators/                              # NEW — FALLBACK ONLY if npm install fails
│   ├── wrap.decorator.ts                         # NEW (fallback)
│   ├── on-error-hook.decorator.ts                # NEW (fallback)
│   └── index.ts                                  # NEW (fallback)
└── index.ts                                      # MODIFY (rewrite exports — no HttpClient/AuthenticatedHttpService)

tests/
├── index.test.ts                                 # DELETE (broken vitest stub)
├── e2e-setup.ts                                  # NEW (testcontainers global setup, kennethreitz/httpbin)
├── e2e-teardown.ts                               # NEW
├── rest-client.e2e.spec.ts                       # NEW
└── auth-rest-client.e2e.spec.ts                  # NEW

.github/workflows/
├── build.yaml                                    # DELETE (renamed)
└── verify.yaml                                   # NEW (npm run test + npm run build)

/
├── jest.config.ts                                # NEW (unit; coverage 80; json-summary reporter)
├── jest.e2e.config.ts                            # NEW (e2e; longer timeout; testcontainers globalSetup)
├── stryker.config.json                           # NEW (jest runner; break: 80; tsconfig.test.json)
├── tsconfig.test.json                            # NEW (extends tsconfig.json; commonjs/node)
├── package.json                                  # MODIFY (deps: -vitest, +jest/ts-jest/stryker/testcontainers; new scripts)
├── CONTRIBUTING.md                               # MODIFY (test:unit/test:e2e/test:mutation/test + Docker prereq)
└── README.md                                     # MODIFY (quick start; usage; API reference for full new surface)
```

---

## Building Block View

```
┌────────────────────────────────────────────────────────────────────────┐
│                            AuthRestModule                              │
│                       (NestJS Dynamic Module)                          │
├────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────────┐  ┌──────────────────┐    │
│  │   RestClient    │  │ AuthStrategyService │  │  AuthRestClient  │    │
│  │  (transport)    │  │  (auth lifecycle)   │  │ (auth transport) │    │
│  └────────┬────────┘  └──────────┬──────────┘  └────────┬─────────┘    │
│           │                      │                      │              │
│           │ @ExecuteWithPolicy   │ @DeduplicateInflight │ @Authenticate│
│           ▼                      ▼                      ▼              │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                  base-decorators (Wrap, OnErrorHook)            │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│           │                                                            │
│           ▼                                                            │
│  ┌─────────────────┐                                                   │
│  │ cockatiel IPolicy│ (retry / circuit-breaker / bulkhead / fallback)  │
│  └────────┬────────┘                                                   │
│           ▼                                                            │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                 @nestjs/axios HttpService → axios               │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Runtime Scenarios

### Scenario: Successful authenticated GET

```
caller ──► AuthRestClient.get(url, cfg)
              │ (@Authenticate intercepts)
              ├──► AuthStrategyService.authenticateIfNeeded()
              │       └─ performAuthenticate (deduped) ──► AuthConfig.authenticate(restClient)
              │           └─► restClient.post('/login', creds)  // through @ExecuteWithPolicy
              │       stores authResult
              ├──► AuthStrategyService.extendRequest(cfg) → cfg'
              └──► RestClient.get(url, cfg')
                       │ (@ExecuteWithPolicy intercepts)
                       └──► policy.execute(ctx => firstValueFrom(httpService.get(url, cfg')))
                                └──► axios → 200 → AxiosResponse → caller
```

### Scenario: Concurrent first-time auth (deduplication)

```
Two callers in parallel both call AuthRestClient.get(...)
  ├─► caller-1: @Authenticate → authenticateIfNeeded() → performAuthenticate('authenticate') → starts; promise stored in inflightMap
  └─► caller-2: @Authenticate → authenticateIfNeeded() → performAuthenticate('authenticate') → finds existing inflight; awaits SAME promise
Both resolve → both proceed with extended config → both call RestClient.get(...) independently
```

### Scenario: HTTP 401 → re-auth → retry once

```
caller ──► AuthRestClient.get(url, cfg)
              │ (@Authenticate)
              ├──► authenticateIfNeeded() (already authed, no-op)
              ├──► extendRequest(cfg) → cfg'
              ├──► RestClient.get(url, cfg') ──► axios 401 ──► AxiosError
              │ catch (isAxiosError && status === 401)
              ├──► authStrategy.clearAuth()
              ├──► authenticateIfNeeded() ──► performAuthenticate() ──► new authResult
              ├──► extendRequest(cfg) → cfg''
              └──► RestClient.get(url, cfg'') ──► 200 → caller
```

### Scenario: Repeated 401 propagates

```
Same as above, but the second RestClient.get also returns 401.
  → @Authenticate catch only triggers ONE retry — second 401 is rethrown.
  → caller receives the AxiosError(401).
```

### Scenario: Non-401 error (e.g. 500)

```
RestClient.policy retries safe-method 500s per CONSERVATIVE preset; if all retries exhaust,
error bubbles into @Authenticate's catch → status !== 401 → rethrow → caller receives 500.
```

### State Transitions (AuthStrategyService)

```
[NotAuthenticated] ──authenticateIfNeeded()──► [Authenticating]
                                                     │
                                            success  │  failure
                                                ┌────┴────┐
                                                ▼         ▼
                                        [Authenticated] [NotAuthenticated]
                                                │
                                  clearAuth()   │ isAuthenticated() === false (handle expired)
                                                ▼
                                        [NotAuthenticated]
```

---

## Architecture Decisions

### Use Wrap-based decorators for cross-cutting concerns

**Status**: Accepted

**Context**: The task mandates `@ExecuteWithPolicy`, `@Authenticate`, and `@DeduplicateInflight` as method decorators built on `Wrap` from `base-decorators`, with `OnErrorHook` for 401 handling.

**Options**:
1. Wrap-based method decorators (mandated by task)
2. NestJS interceptors / axios interceptors
3. Inheritance (`AuthRestClient extends RestClient`)

**Decision**: Wrap-based decorators per option 1.

**Consequences**:
- Existing `src/deduplicate-inflight.decorator.ts` is the direct codebase precedent.
- Each decorator factory needs a unique `unique symbol` exclusion key to avoid double-wrap conflicts.
- `method` is auto-bound by `Wrap`; never call `.bind/.call/.apply`.
- `context.target` exposes the class instance; required-by-decorator fields (`policy`, `authStrategy`, `inflightMap`) must be public/readable on the decorated class.

### Default ResilanceConfig to the CONSERVATIVE preset

**Status**: Accepted

**Context**: The README documents `CONSERVATIVE` as the default; the existing `HttpClient` constructor already defaults to it; `AuthRestModule.forRootAsync` accepts `resilanceConfig` as optional.

**Options**:
1. Default to `CONSERVATIVE` in both `RestClient` constructor and `AuthRestModule` factory.
2. Make config required everywhere.
3. Default in only one place.

**Decision**: Option 1 — default in both. The module factory resolves `opts.resilanceConfig ?? resiliencePolicyPresets[ResilencePresets.CONSERVATIVE]` before passing to `RestClient`; `RestClient` constructor also defaults to the same preset for direct construction outside the module.

**Consequences**:
- Consumers can register `AuthRestModule.forRootAsync` without ever specifying resilience config.
- Behaviour matches the existing draft and the README.
- Acceptance criterion "AuthRestModule defaults to CONSERVATIVE" is satisfied by the factory default; the `RestClient` ctor default is a backstop.

### Test runner: Jest 29 over keeping vitest

**Status**: Accepted

**Context**: vitest@4 is currently installed; the task explicitly requires Jest unit tests, jest-it-up, and Stryker (jest runner).

**Options**:
1. Migrate fully to Jest 29 + ts-jest.
2. Keep vitest, find vitest-compatible mutation tooling.
3. Use both (vitest for unit, jest for mutation).

**Decision**: Option 1 — full migration to Jest 29 + ts-jest, with separate `tsconfig.test.json` to override `moduleResolution` for ts-jest.

**Consequences**:
- `vitest@4.0.16` is removed.
- `@stryker-mutator/jest-runner@8` integrates directly with the same jest config.
- `jest-it-up@4.0.1` reads `coverage/coverage-summary.json` and ratchets thresholds in `jest.config.ts`.
- Two tsconfigs are maintained — root for `tsdown` (bundler resolution), test for jest (node resolution).

### `base-decorators` install vs internal shim

**Status**: Accepted

**Context**: The skill (verified 2026-04-26 via `npm pack`) describes `base-decorators@1.1.0` as installable from npm. The earlier analysis flagged it as not on npm. Decorator implementation depends on `Wrap` and `OnErrorHook`.

**Options**:
1. Install `base-decorators@1.1.0` from npm; create internal shim only if install fails.
2. Always create internal shim under `src/base-decorators/`.
3. Inline `Wrap` logic into each decorator file.

**Decision**: Option 1 — primary path is `npm install base-decorators@1.1.0`. If the registry verifies the package absent, fall back to creating `src/base-decorators/` exporting `Wrap` and `OnErrorHook` matching the inferred signature `Wrap<TThis, TArgs, TReturn>(wrapper, exclusionKey?)` and `OnErrorHook(handler, exclusionKey?)`.

**Consequences**:
- Avoids duplicating an external package's public surface in-tree if the package exists.
- The implementer must verify install success before writing decorator code; the choice is binary.
- If shim is built, it MUST come with its own unit tests under `src/base-decorators/__tests__/`.

---

## High-Level Structure

```
Library: nestjs-http-client (v1.0 baseline)
├── Transport layer: RestClient + @ExecuteWithPolicy + cockatiel pipeline (retry → CB → bulkhead → fallback)
├── Auth layer:      AuthRestClient + @Authenticate + AuthStrategyService + @DeduplicateInflight
├── Composition:     AuthRestModule.forRootAsync({ useFactory, inject?, imports? })
├── Public types:    AuthConfig, AuthStrategy, ResilanceConfig, ResilencePresets, presets
├── Build:           tsdown (bundler resolution) → dist/index.cjs + dist/index.d.cts
└── Verify:          jest unit (+ coverage + jest-it-up) → jest e2e (testcontainers httpbin) → stryker mutation (break: 80) → CI verify.yaml
```

---

## Workflow Steps

```
Phase 0: Bug fixes
   ├─ Fix shouldRetry.ts:24 inverted logic
   ├─ Fix deduplicate-inflight.decorator.ts (remove ./cache.decorator; KeyBuilder local)
   ├─ Move deduplicate-inflight.decorator.spec.ts → src/__tests__/
   └─ Delete tests/index.test.ts
        │
        ▼
Phase 1: Test infrastructure
   ├─ npm uninstall vitest
   ├─ npm install --save-dev jest@29 ts-jest@29 @types/jest@29 jest-it-up@4 \
   │                          @stryker-mutator/core@8 @stryker-mutator/jest-runner@8 \
   │                          @stryker-mutator/typescript-checker@8 testcontainers@11
   ├─ Create tsconfig.test.json (commonjs/node)
   ├─ Create jest.config.ts (unit; coverage 80; json-summary)
   ├─ Create jest.e2e.config.ts (e2e; testTimeout 60000; globalSetup/Teardown)
   ├─ Create stryker.config.json (jest runner; break: 80; tsconfigFile: tsconfig.test.json)
   └─ Update package.json scripts (test:unit, posttest:unit, test:e2e, test:mutation, test)
        │
        ▼
Phase 2: base-decorators
   ├─ Try: npm install base-decorators@1.1.0
   └─ Fallback only if install fails: build src/base-decorators/{wrap,on-error-hook,index}.ts + tests
        │
        ▼
Phase 3: Transport layer
   ├─ src/client/execute-with-policy.decorator.ts + spec
   ├─ src/client/rest.client.ts (every verb decorated)
   ├─ Delete src/client/http.client.ts
   └─ src/client/__tests__/rest.client.spec.ts (verbs × policy combinations; signal forwarding; default preset)
        │
        ▼
Phase 4: Auth layer
   ├─ src/auth/auth.config.ts (types only)
   ├─ src/auth/auth-strategy.service.ts + spec (single-flight; skip-when-authed; clearAuth)
   ├─ src/auth/authenticate.decorator.ts + spec (config-arg index by method; 401 once; non-401 propagate)
   ├─ src/auth/auth-rest.client.ts (verify zero rxjs/p-retry imports)
   ├─ Delete src/auth/authenticated-http.service.ts
   └─ src/auth/__tests__/auth-rest.client.spec.ts
        │
        ▼
Phase 5: Module + public surface
   ├─ src/auth/auth-rest.module.ts (forRootAsync; default CONSERVATIVE)
   ├─ src/auth/__tests__/auth-rest.module.spec.ts (Test.createTestingModule bootstrap)
   └─ src/index.ts rewritten (no HttpClient, no AuthenticatedHttpService)
        │
        ▼
Phase 6: E2E
   ├─ tests/e2e-setup.ts (GenericContainer kennethreitz/httpbin; Wait.forHttp)
   ├─ tests/e2e-teardown.ts
   ├─ tests/rest-client.e2e.spec.ts (httpbin /get, /status/500, /anything)
   └─ tests/auth-rest-client.e2e.spec.ts (httpbin /anything for header verify; /status/401 for re-auth)
        │
        ▼
Phase 7: CI + docs
   ├─ git mv .github/workflows/build.yaml .github/workflows/verify.yaml
   ├─ Update verify.yaml: npm run test (sequential aggregate) + npm run build
   ├─ Update CONTRIBUTING.md (new commands; Docker prereq for e2e)
   └─ Update README.md (quick-start; AuthRestModule.forRootAsync example with Bearer + Basic; usage; API reference)
        │
        ▼
Phase 8: Final verification
   ├─ npm run test:unit  (coverage ≥ 80%; jest-it-up ratchets)
   ├─ npm run test:e2e   (under 2 min)
   ├─ npm run test:mutation (mutation score ≥ 80%)
   ├─ npm run build      (dist/ ships new public surface)
   └─ Confirm no HttpClient/AuthenticatedHttpService/withHttpRetry/old AuthConfig in src/
```

**Phase dependencies**: Phase 0 unblocks compilation. Phase 1 unblocks all test work. Phase 2 unblocks Phases 3–4. Phase 3 unblocks Phase 4. Phase 4 unblocks Phase 5. Phases 3–5 unblock Phase 6. Everything unblocks Phase 7. Phase 8 is the final gate.

---

## Contracts

### Decorator Class-Shape Contracts

```typescript
// @ExecuteWithPolicy
//   Required class shape: { policy: IPolicy<IDefaultPolicyContext, any> }
//   Wrapped method must return Observable<AxiosResponse<T>>
//   Decorated method becomes: (...args) => Promise<AxiosResponse<T>>
//   Special-case `request` propertyKey: spreads `signal: ctx.signal` into args[0]

// @Authenticate
//   Required class shape: { authStrategy: AuthStrategyService }
//   Config arg index: 1 for {get, delete, head, options, request}; 2 for {post, put, patch, postForm, putForm, patchForm}
//   On axios 401: clearAuth → authenticateIfNeeded → re-extend → retry once → propagate if still 401
//   Non-axios or non-401 errors rethrow unchanged

// @DeduplicateInflight(keyBuilder)
//   Required class shape: { inflightMap: Map<string, Promise<unknown>> }
//   Coalesces concurrent calls with the same derived key into a single underlying invocation;
//   inflightMap entry is cleaned up in `finally` on both success and error.
```

### Auth Config Contract

```typescript
interface AuthStrategy {
  isAuthenticated(): boolean
  extendRequest(config: AxiosRequestConfig): AxiosRequestConfig
}

interface AuthConfig {
  authenticate(client: RestClient): Promise<AuthStrategy>
}
```

### AuthRestModule Contract

```typescript
interface AuthRestModuleOptions {
  httpService: HttpService
  authConfig: AuthConfig
  resilanceConfig?: ResilanceConfig<unknown>
}

class AuthRestModule {
  static forRootAsync(options: {
    useFactory: (...args: unknown[]) => Promise<AuthRestModuleOptions> | AuthRestModuleOptions
    inject?: unknown[]
    imports?: unknown[]
  }): DynamicModule
}
```

### RestClient Contract

```typescript
class RestClient implements Loggable {
  readonly logger: Logger
  readonly policy: IPolicy<IDefaultPolicyContext, any>
  readonly axiosRef: AxiosInstance
  constructor(httpService: HttpService, config?: ResilanceConfig<unknown>)
  request<T>(config: AxiosRequestConfig): Promise<AxiosResponse<T>>
  get<T, D>(url: string, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>>
  delete<T, D>(url: string, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>>
  head<T, D>(url: string, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>>
  post<T, D>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>>
  put<T, D>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>>
  patch<T, D>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>>
  postForm<T, D>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>>
  putForm<T, D>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>>
  patchForm<T, D>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>>
}
```

### AuthRestClient Contract

```typescript
class AuthRestClient {
  readonly authStrategy: AuthStrategyService  // public for @Authenticate to read via context.target
  constructor(restClient: RestClient, authStrategy: AuthStrategyService)
  // Same verb surface as RestClient; each decorated with @Authenticate
  // Zero rxjs imports; zero p-retry imports
}
```

### AuthStrategyService Contract

```typescript
class AuthStrategyService {
  readonly inflightMap: Map<string, Promise<unknown>>  // public for @DeduplicateInflight
  constructor(authConfig: AuthConfig, client: RestClient)
  isAuthenticated(): boolean
  authenticateIfNeeded(): Promise<void>
  extendRequest(config: AxiosRequestConfig): AxiosRequestConfig
  clearAuth(): void
  // private @DeduplicateInflight(() => 'authenticate')
  // private performAuthenticate(): Promise<void>
}
```

### npm Scripts Contract (package.json)

```json
{
  "test:unit": "jest --config jest.config.ts",
  "posttest:unit": "jest-it-up",
  "test:e2e": "jest --config jest.e2e.config.ts",
  "test:mutation": "stryker run",
  "test": "npm run test:unit && npm run test:e2e && npm run test:mutation"
}
```

---

## Implementation Process

You MUST launch for each step a separate agent, instead of performing all steps yourself. And for each step marked as parallel, you MUST launch separate agents in parallel.

**CRITICAL:** For each agent you MUST:
1. Use the **Agent** type specified in the step (e.g., `haiku`, `sonnet`, `sdd:developer`, `sdd:qa-engineer`)
2. Provide path to task file and prompt which step to implement
3. Require agent to implement exactly that step, not more, not less, not other steps

### Parallelization Overview

```
        Step 1 [haiku]   Step 2 [haiku]   Step 3 [sdd:developer]   Step 4 [sdd:developer]   Step 5 [sdd:developer]
        (delete stub)    (shouldRetry)    (dedup-inflight)         (AuthConfig types)       (base-decorators)
             |                |                |                         |                        |
             +--------+-------+----------------+-------------------------+------------------------+
                      |
                      v
                 Step 6 [sdd:developer]
                 (Jest infra)
                      |
        +-----+-------+-------+-------+--------+----------+
        |     |               |       |        |          |
        v     v               v       v        v          v
    Step 10  Step 16     Step 18    Step 7   Step 8    Step 11a [sdd:developer]
    [sdd:qa] [sdd:dev]   [haiku]    [sdd:dev][sdd:dev] (AuthStrategyService impl + spec)
    (specs)  (testcont)  (verify)   (5+6)    (4+5+6)   (deps: 3,4,5,6)
                                       |                  |
                                       v                  |
                                   Step 9 [sdd:developer] |
                                   (RestClient)           |
                                       |                  |
                                       +-----+------------+
                                             |
                                +------------+------------+
                                v                         v
                         Step 11b [sdd:qa-engineer]   Step 12 [sdd:developer]
                         (RestClient unit tests)      (AuthRestClient)
                         (deps: 9, 11a)               (deps: 8, 9, 11a)
                                                          |
                                                          v
                                                    Step 13 [sdd:developer]
                                                    (AuthRestModule)
                                                    (deps: 9, 11a, 12)
                                                          |
                                                          v
                                                    Step 14 [sdd:developer]
                                                    (rewrite index.ts)
                                                    (deps: 9, 11a, 12, 13)
                                                          |
                                                          v
                                                    Step 15 [sdd:qa-engineer]
                                                    (AuthRestModule spec)
                                                    (deps: 14)
                                                          |
                                            +-------------+-------------+
                                            v                           v
                                        Step 17 [sdd:qa-eng.]       Step 19 [opus]
                                        (E2E specs;                 (README + CONTRIBUTING)
                                         also needs 16)
                                            |                           |
                                            +-------+-------------------+
                                                    |
                                                    v (also depends on Steps 18, 15, 10)
                                            Step 20 [sdd:qa-engineer]
                                            (Coverage + mutation gate)
```

### Implementation Strategy

**Approach**: Mixed (Bottom-Up dominant + Top-Down for module wiring)

**Rationale**: Bottom-up dominates because the layered architecture (types -> decorators -> services -> clients -> module) mirrors the dependency tree exactly: every consumer is built only after its dependencies are complete and tested. Top-down is applied to `AuthRestModule.forRootAsync` because the factory wiring is shaped by the external NestJS consumer contract; by the time we reach Phase 6, all internals exist, so the module work is pure wiring with negligible drift. TDD blends in: every implementation step's Definition of Done includes "tests written and passing"; spec-only steps appear at the same level as the unit-under-test so coverage rises monotonically with implementation.

### Least-to-Most Decomposition

```
Level 0 (no dependencies):
  - Fix shouldRetry.ts inverted logic (single-line edit)
  - Fix deduplicate-inflight.decorator.ts ./cache.decorator import
  - Delete broken tests/index.test.ts stub
  - Define AuthConfig + AuthStrategy types
  - Install (or shim) base-decorators@1.1.0

Level 1 (depends on Level 0):
  - Test infrastructure: uninstall vitest; install jest/ts-jest/stryker/testcontainers; configs; scripts
  - @ExecuteWithPolicy decorator (needs Wrap)
  - @Authenticate decorator (needs Wrap+OnErrorHook+AuthStrategy types)

Level 2 (depends on Level 1):
  - RestClient (uses @ExecuteWithPolicy)
  - AuthStrategyService (uses @DeduplicateInflight + AuthConfig)
  - Move + fix deduplicate-inflight.decorator.spec.ts (under jest)
  - should-retry.spec.ts; resilience-policy-builder.spec.ts

Level 3 (depends on Level 2):
  - AuthRestClient (composes RestClient + AuthStrategyService + @Authenticate)
  - RestClient.spec; AuthStrategyService.spec
  - @ExecuteWithPolicy.spec; @Authenticate.spec

Level 4 (depends on Level 3):
  - AuthRestModule.forRootAsync (wires all three classes)
  - AuthRestClient.spec

Level 5 (depends on Level 4):
  - Public surface: src/index.ts rewrite
  - AuthRestModule.spec (Test.createTestingModule bootstrap)

Level 6 (depends on Level 5):
  - testcontainers e2e setup/teardown
  - rest-client.e2e.spec.ts; auth-rest-client.e2e.spec.ts

Level 7 (depends on Level 6):
  - CI rename build.yaml -> verify.yaml
  - README rewrite (quick start; usage; API reference)
  - CONTRIBUTING.md update

Level 8 (final gate):
  - Coverage ratchet (jest-it-up) + mutation score >= 80% iteration
```

### Phase Overview

```
Phase 1: Setup (clean broken stubs)
    │
    ▼
Phase 2: Foundational (bug fixes; types; base-decorators; test infra)
    │
    ▼
Phase 3: Decorators (@ExecuteWithPolicy + @Authenticate)
    │
    ▼
Phase 4: Transport (RestClient + decorator/utility specs)
    │
    ▼
Phase 5: Auth (AuthStrategyService -> AuthRestClient)
    │
    ▼
Phase 6: Module + Public Surface (AuthRestModule + index.ts)
    │
    ▼
Phase 7: E2E (testcontainers harness + specs)
    │
    ▼
Phase 8: Polish (CI rename + docs + coverage/mutation gate)
```

---

## Phase 1: Setup

### Step 1: Delete broken vitest smoke test [DONE]

**Model:** haiku
**Agent:** haiku
**Depends on:** None
**Parallel with:** Step 2, Step 3, Step 4, Step 5

Step 1, Step 2, Step 3, Step 4, and Step 5 share no dependencies and MUST be launched in parallel by separate agents.

**Goal**: Remove `tests/index.test.ts` which imports a non-existent `fn` export and references `vitest`, blocking the upcoming jest test runner setup.

#### Expected Output

- `tests/index.test.ts` deleted

#### Success Criteria

- [X] File `tests/index.test.ts` does not exist
- [X] Repository still compiles via `npx tsc --noEmit`

#### Subtasks

- [X] Delete `tests/index.test.ts`
- [X] Verify no other source file imports from `tests/index.test.ts`

#### Verification

**Level:** NOT NEEDED
**Rationale:** Simple file deletion. Success is binary (file exists or not) and verifiable via filesystem check + `npx tsc --noEmit`. No judgment required.

#### Blockers

None.

#### Risks

- None of significance — file is orphan.

#### Complexity

Small

#### Dependencies

None (Level 0)

#### Uncertainty Rating

Low

#### Integration Points

None.

#### Definition of Done

- [X] File deleted
- [X] No remaining references to it in repo
- [X] Tests written and passing (N/A — destructive cleanup; covered by repo compile check)

---

## Phase 2: Foundational

### Step 2: Fix `shouldRetry.ts` inverted method-list logic [DONE]

**Model:** haiku
**Agent:** haiku
**Depends on:** None
**Parallel with:** Step 1, Step 3, Step 4, Step 5

This step MUST be executed in parallel with Steps 1, 3, 4, and 5.

**Goal**: Correct `src/shouldRetry.ts:24` from `if (isMethodInList(error, methods)) return false` to `if (!isMethodInList(error, methods)) return false`. Today, safe methods (GET/HEAD/OPTIONS) are paradoxically blocked from retry while unsafe methods are retried.

#### Expected Output

- `src/shouldRetry.ts` with corrected boolean logic at line 24

#### Success Criteria

- [X] `isRetryableError(getError, SAFE_HTTP_METHODS)` returns `true` for an axios 5xx error with method `'get'`
- [X] `isRetryableError(postError, SAFE_HTTP_METHODS)` returns `false` for an axios 5xx error with method `'post'`
- [X] No other lines in the file are modified

#### Subtasks

- [X] Edit `src/shouldRetry.ts` line 24: invert the predicate
- [X] Re-read the surrounding 5-line block to confirm semantics

#### Verification

**Level:** Single Judge
**Artifact:** `src/shouldRetry.ts`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Correctness of Fix | 0.40 | Line 24 reads `if (!isMethodInList(error, methods)) return false`; semantic is properly inverted |
| Minimal Change | 0.25 | No other lines altered; targeted edit to L24 only — diff is one operator change |
| Behavior Verification | 0.20 | GET 5xx now retries (returns true); POST 5xx now blocked (returns false); matches README "Conservative"/"Restfull"/"Low Quality" presets contract |
| No Regression | 0.15 | Surrounding helpers (`CODE_EXCLUDE_LIST`, `isMethodInList`, network/internal/5xx branches) untouched and still functional |

**Reference Pattern:** `src/shouldRetry.ts` (current file context — judge inspects the single-line change)

#### Complexity

Small

#### Dependencies

None (Level 0)

#### Uncertainty Rating

Low

#### Integration Points

`src/resilence.policy.ts` presets consume `isRetryableError`.

#### Definition of Done

- [X] Line 24 reads `if (!isMethodInList(error, methods)) return false`
- [X] Tests written and passing — note: actual `should-retry.spec.ts` is created in Step 10; this step only fixes the bug. The spec's existence in Step 10 is the test gate for this fix.

---

### Step 3: Fix `deduplicate-inflight.decorator.ts` broken `./cache.decorator` import [DONE]

**Model:** opus
**Agent:** sdd:developer
**Depends on:** None
**Parallel with:** Step 1, Step 2, Step 4, Step 5

This step MUST be executed in parallel with Steps 1, 2, 4, and 5.

**Goal**: Remove the non-existent `import { KeyBuilder } from './cache.decorator'` and define `KeyBuilder` locally so the file compiles.

#### Expected Output

- `src/deduplicate-inflight.decorator.ts` compiles standalone
- Local type alias `type KeyBuilder<TArgs extends unknown[]> = (...args: TArgs) => string` declared in the file

#### Success Criteria

- [X] `npx tsc --noEmit` produces zero errors related to `cache.decorator` or `KeyBuilder`
- [X] `import { Wrap } from 'base-decorators'` is the only external decorator import (postponed to Step 5 if `base-decorators` not yet installed; in that case temporarily import from `./base-decorators` shim path placeholder)
- [X] Decorator behaviour unchanged from current intent (concurrent calls with same derived key share one underlying invocation; entry cleared in `finally`)

#### Subtasks

- [X] Remove `import { KeyBuilder } from './cache.decorator'`
- [X] Add local `type KeyBuilder<TArgs extends unknown[]> = (...args: TArgs) => string` near the top of the file
- [X] Verify `Wrap` import is still in place (resolve to package or shim depending on Step 5 outcome)

#### Verification

**Level:** Single Judge
**Artifact:** `src/deduplicate-inflight.decorator.ts`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Behavior Preserved | 0.35 | Decorator semantics unchanged: concurrent calls with same derived key share one underlying invocation; `inflightMap` entry cleared in `finally` on both success and error |
| Compilation Restored | 0.30 | `npx tsc --noEmit` passes with zero errors related to `cache.decorator` or `KeyBuilder`; no `./cache.decorator` import remains |
| Local Type Correctness | 0.20 | `type KeyBuilder<TArgs extends unknown[]> = (...args: TArgs) => string` declared locally near the top of the file with correct generics |
| Import Hygiene | 0.15 | Only `Wrap` external decorator import remains (or local shim path if Step 5 chose shim); no orphan imports |

**Reference Pattern:** `src/deduplicate-inflight.decorator.ts` (existing file structure — judge verifies surgical fix)

#### Blockers

- `base-decorators` package availability decided in Step 5. Until Step 5 completes, the import path may need a temporary shim.

#### Risks

- If `Wrap` generic signature in the installed package differs from the one inferred (`Wrap<TThis, TArgs, TReturn>`), the decorator must be retyped here.

#### Complexity

Small

#### Dependencies

None for the local type fix (Level 0).

#### Uncertainty Rating

Low

#### Integration Points

`AuthStrategyService.performAuthenticate` (Step 11a) consumes this decorator.

#### Definition of Done

- [X] File compiles
- [X] No `./cache.decorator` import remains
- [X] Tests written and passing — covered by Step 10 spec move/fix

---

### Step 4: Define `AuthConfig` and `AuthStrategy` types [DONE]

**Model:** opus
**Agent:** sdd:developer
**Depends on:** None
**Parallel with:** Step 1, Step 2, Step 3, Step 5

This step MUST be executed in parallel with Steps 1, 2, 3, and 5.

**Goal**: Create `src/auth/auth.config.ts` exporting two pure-type interfaces:
- `AuthStrategy = { isAuthenticated(): boolean; extendRequest(c: AxiosRequestConfig): AxiosRequestConfig }`
- `AuthConfig = { authenticate(client: RestClient): Promise<AuthStrategy> }`

#### Expected Output

- `src/auth/auth.config.ts` with both interfaces exported
- Forward-typed reference to `RestClient` (via `import type`) without creating a circular runtime import

#### Success Criteria

- [X] File compiles standalone
- [X] `AuthStrategy` exposes exactly two methods: `isAuthenticated` and `extendRequest`
- [X] `AuthConfig` exposes exactly one method: `authenticate(client: RestClient): Promise<AuthStrategy>`
- [X] Old fields (`endpoint`, `requestBuilder`, `responseExtractor`, `headerBuilder`) are absent

#### Subtasks

- [X] Create `src/auth/auth.config.ts`
- [X] Add `import type { AxiosRequestConfig } from 'axios'`
- [X] Add `import type { RestClient } from '../client/rest.client'` (type-only forward reference; the file is created in Step 9, but `import type` does not require runtime resolution at the moment of compilation of `auth.config.ts` alone — confirm with `tsc` once Step 9 lands)

#### Verification

**Level:** CRITICAL - Panel of 2 Judges with Aggregated Voting
**Artifact:** `src/auth/auth.config.ts`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Contract Correctness | 0.30 | `AuthConfig.authenticate(client: RestClient): Promise<AuthStrategy>` exact shape matches Contracts section; `AuthStrategy.extendRequest(config: AxiosRequestConfig): AxiosRequestConfig` and `AuthStrategy.isAuthenticated(): boolean` exact |
| Public Surface Hygiene | 0.25 | Old fields (`endpoint`, `requestBuilder`, `responseExtractor`, `headerBuilder`) absent; AC "AuthConfig has a single authenticate field" satisfied |
| Type-only Forward Ref | 0.20 | `import type { RestClient }` used; no runtime circular import; no value-level imports of RestClient |
| Method Set Exactness | 0.15 | `AuthStrategy` exposes exactly `isAuthenticated` and `extendRequest`; nothing extra; no optional members |
| Consumer Documentation | 0.10 | Type signatures readable as a public contract; clear naming; consumer can implement without examples |

**Reference Pattern:** `src/client/resilance.config.ts` (existing pure-type config in this codebase)

#### Blockers

- `RestClient` class exists only after Step 9. Until then, type-check this file in isolation by deferring full project compile until Step 9 lands.

#### Risks

- Circular type reference if `RestClient` ever imports `AuthConfig` directly. Mitigation: `RestClient` does not depend on auth types — keep transport pure.

#### Complexity

Small

#### Dependencies

None (Level 0)

#### Uncertainty Rating

Low

#### Integration Points

Consumed by `AuthStrategyService` (Step 11a), `@Authenticate` (Step 8), and `AuthRestModule` (Step 13).

#### Definition of Done

- [X] File created with both interfaces
- [X] No runtime imports — only `import type`
- [X] Tests written and passing — pure types, no spec needed; integration coverage via Steps 11, 8, 13 specs

---

### Step 5: Install or shim `base-decorators@1.1.0` [DONE]

**Model:** opus
**Agent:** sdd:developer
**Depends on:** None
**Parallel with:** Step 1, Step 2, Step 3, Step 4

This step MUST be executed in parallel with Steps 1, 2, 3, and 4.

**Goal**: Ensure `Wrap` and `OnErrorHook` are importable. Primary path is `npm install base-decorators@1.1.0`; fallback is to build `src/base-decorators/{wrap,on-error-hook,index}.ts` matching the inferred signature.

#### Expected Output

- Either: `base-decorators@1.1.0` listed in `package.json` dependencies and present in `node_modules/`
- Or: `src/base-decorators/wrap.decorator.ts`, `src/base-decorators/on-error-hook.decorator.ts`, `src/base-decorators/index.ts` exist with full unit specs and re-export `Wrap` + `OnErrorHook`

#### Success Criteria

- [X] `import { Wrap, OnErrorHook } from 'base-decorators'` (or from the shim path) resolves at compile time
- [X] If shim built: shim has unit tests under `src/base-decorators/__tests__/` covering Wrap arg-passing, exclusion-key dedup, and OnErrorHook only-runs-on-error semantics — N/A (npm install path taken)
- [X] `Wrap<TThis, TArgs, TReturn>(wrapper, exclusionKey?)` signature matches existing `src/deduplicate-inflight.decorator.ts` usage

#### Subtasks

- [X] Run `npm view base-decorators@1.1.0` — confirm presence on registry (confirmed: package published, latest dist-tag 1.1.0, zero deps)
- [X] If present: `npm install base-decorators@1.1.0` and skip shim path (installed; saved to `dependencies` as `^1.1.0`; `package-lock.json` pins exact `1.1.0`)
- [X] If absent: create `src/base-decorators/wrap.decorator.ts` with method-decorator factory accepting `(method, context) => (...args) => unknown` and `exclusionKey?: symbol` — N/A (package available)
- [X] If absent: create `src/base-decorators/on-error-hook.decorator.ts` accepting `(error, context, args) => void | Promise<void>` and `exclusionKey?: symbol` — N/A (package available)
- [X] If absent: write `src/base-decorators/__tests__/wrap.spec.ts` and `on-error-hook.spec.ts` — N/A (package available)
- [X] Update `src/deduplicate-inflight.decorator.ts` import path if shim is used (to `./base-decorators`) — N/A (kept at `'base-decorators'` since package available)

#### Verification

**Level:** CRITICAL - Panel of 2 Judges with Aggregated Voting
**Artifact:** `package.json` + (optional) `src/base-decorators/`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Resolution at Compile Time | 0.30 | `import { Wrap, OnErrorHook } from 'base-decorators'` (or from shim path) resolves under `tsc --noEmit`; lockfile or shim files committed |
| Signature Correctness | 0.25 | `Wrap<TThis, TArgs, TReturn>(wrapper, exclusionKey?)` signature matches existing usage in `src/deduplicate-inflight.decorator.ts`; `OnErrorHook(handler, exclusionKey?)` matches the inferred signature |
| Shim Tests (if shim) | 0.20 | If shim built: unit tests under `src/base-decorators/__tests__/` cover Wrap arg-passing, exclusion-key dedup, OnErrorHook only-runs-on-error semantics. If npm install succeeded: this criterion is auto-pass (N/A) |
| Decision Documentation | 0.15 | Outcome (install vs shim) recorded in commit / scratchpad; if installed, exact version `1.1.0` in `package.json` and lockfile; if shim, `src/base-decorators/index.ts` re-exports both decorators |
| Path Updates | 0.10 | Downstream imports (e.g. `deduplicate-inflight.decorator.ts`) updated if shim chosen; consistent across the codebase |

**Reference Pattern:** `src/deduplicate-inflight.decorator.ts` (existing Wrap consumer — defines the inferred signature shim must match)

#### Blockers

- Registry lookup must succeed (network).
- Without `Wrap`, all three decorators are blocked.

#### Risks

- The actual installed package's `Wrap` signature may differ from the inferred one. Mitigation: read the package's `index.d.ts` immediately after install and adapt decorator factories in Steps 7–8.
- Shim quality risk: if shim semantics differ subtly from the npm package, downstream behaviour drifts. Mitigation: spec-test the shim against the same generic signature usage seen in `src/deduplicate-inflight.decorator.ts`.

#### Complexity

Medium (binary outcome dictates the path; shim path adds two files + specs)

#### Dependencies

None for install attempt; if shim, Level 0 only.

#### Uncertainty Rating

High (registry availability unknown; signature inference unverified)

#### Integration Points

Consumed by every decorator file in the project.

#### Definition of Done

- [X] `Wrap` and `OnErrorHook` importable from a single module path (`'base-decorators'`)
- [X] If shim built: shim + tests committed — N/A (npm install path taken)
- [X] If installed: lockfile shows the exact version (`package-lock.json` resolves `base-decorators@1.1.0`)
- [X] Tests written and passing (shim path) — N/A if installed

---

### Step 6: Stand up Jest 29 + Stryker v8 + testcontainers test infrastructure [DONE]

**Model:** opus
**Agent:** sdd:developer
**Depends on:** Step 1, Step 2, Step 3
**Parallel with:** None (gates the next phase)

**Goal**: Replace vitest with Jest + ts-jest, add Stryker v8 (jest runner) with `break: 80`, add jest-it-up coverage ratchet, add testcontainers for e2e. Wire all four into `package.json` scripts.

#### Expected Output

- `package.json`: removed `vitest`; added `jest@29.7.0`, `ts-jest@29.2.0`, `@types/jest@29.5.0`, `jest-it-up@4.0.1`, `@stryker-mutator/core@8`, `@stryker-mutator/jest-runner@8`, `@stryker-mutator/typescript-checker@8`, `testcontainers@11.14.0`
- `package.json` scripts: `test:unit`, `posttest:unit`, `test:e2e`, `test:mutation`, `test`
- `tsconfig.test.json` extending root with `module: commonjs` + `moduleResolution: node`
- `jest.config.ts` (unit): `preset: 'ts-jest'`, `testMatch: ['**/src/**/__tests__/**/*.spec.ts']`, coverage 80, json-summary reporter
- `jest.e2e.config.ts` (e2e): `testMatch: ['**/tests/**/*.spec.ts']`, `testTimeout: 60000`, `globalSetup`/`globalTeardown` referencing testcontainers harness (files created in Step 16)
- `stryker.config.json`: `testRunner: 'jest'`, `jest.configFile: 'jest.config.ts'`, `tsconfigFile: 'tsconfig.test.json'`, `mutate: ['src/**/*.ts', '!src/**/__tests__/**']`, `thresholds.break: 80`

#### Success Criteria

- [X] `npm install` completes without errors
- [X] `npm run test:unit` runs and reports zero specs found (or runs the moved decorator spec from Step 10 when it lands)
- [X] `npm run test:e2e` runs without container references until Step 16 supplies them — temporarily allow zero specs
- [X] `npm run test:mutation -- --help` (or equivalent dry-invoke) loads the config without error
- [X] No `vitest` reference remains in `package.json` or test code
- [X] `npm run test` chain runs in declared order

#### Subtasks

- [X] `npm uninstall vitest`
- [X] `npm install --save-dev jest@29.7.0 ts-jest@29.2.0 @types/jest@29.5.0 jest-it-up@4.0.1 @stryker-mutator/core@8 @stryker-mutator/jest-runner@8 @stryker-mutator/typescript-checker@8 testcontainers@11.14.0` (also added `@nestjs/testing` and `ts-node` for jest TS config parsing)
- [X] Create `tsconfig.test.json` extending `tsconfig.json` with `module: commonjs` + `moduleResolution: node` (also overrides `verbatimModuleSyntax: false` for CJS interop)
- [X] Create `jest.config.ts` per skill Pattern 4 (uses `export = config` for jest-it-up CJS interop)
- [X] Create `jest.e2e.config.ts` per skill Implementation Guidance (with placeholder `tests/e2e-setup.ts` and `tests/e2e-teardown.ts`)
- [X] Create `stryker.config.json` per skill Implementation Guidance (`break: 80`)
- [X] Update `package.json` scripts: replace `test` with chain; add `test:unit`, `posttest:unit`, `test:e2e`, `test:mutation` (each with `TS_NODE_PROJECT=tsconfig.test.json` so ts-node uses test tsconfig)
- [X] Smoke-run each script (allow no-tests-found exit code where applicable) — `test:unit` passes with zero specs and runs jest-it-up post-hook; `test:e2e` passes with zero specs; `test:mutation` config loads and proceeds to typescript checker

#### Verification

**Level:** CRITICAL - Panel of 2 Judges with Aggregated Voting
**Artifact:** `package.json`, `tsconfig.test.json`, `jest.config.ts`, `jest.e2e.config.ts`, `stryker.config.json`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Tool Wiring Correctness | 0.30 | `jest.config.ts` (preset ts-jest, testMatch `**/src/**/__tests__/**/*.spec.ts`, coverageThreshold 80, json-summary reporter), `jest.e2e.config.ts` (testMatch `**/tests/**/*.spec.ts`, testTimeout 60000, globalSetup/Teardown wired), `stryker.config.json` (testRunner jest, jest.configFile, tsconfigFile, mutate excludes `__tests__`, thresholds.break 80), `tsconfig.test.json` extending root with module commonjs + moduleResolution node — all four exist, are internally consistent, and match the spec |
| Script Definitions | 0.20 | `test:unit`, `posttest:unit` (jest-it-up), `test:e2e`, `test:mutation` (stryker run), `test` (sequential chain `test:unit && test:e2e && test:mutation`) all present in `package.json` |
| Dependency Hygiene | 0.20 | vitest removed; jest@29.7.0, ts-jest@29.2.0, @types/jest@29.5.0, jest-it-up@4.0.1, @stryker-mutator/core@8, @stryker-mutator/jest-runner@8, @stryker-mutator/typescript-checker@8, testcontainers@11.14.0 added at correct versions |
| Smoke Runnability | 0.15 | Each script invocable without crash (zero specs allowed at this point); `npm install` completes without errors |
| Coverage Threshold | 0.10 | jest `coverageThreshold` set to 80 across branches/functions/lines/statements; stryker `thresholds.break: 80`; jest reporters include `json-summary` for jest-it-up |
| Resolution Strategy | 0.05 | `tsconfig.test.json` overrides moduleResolution to node/commonjs without breaking root `tsconfig.json` bundler resolution used by tsdown |

**Reference Pattern:** `nestjs-http-client-architecture` skill Patterns 4 + Implementation Guidance and `nestjs-jest-testing` skill (jest, stryker, jest-it-up wiring)

#### Blockers

- Step 1 (delete broken stub) must precede; otherwise jest discovery may pick the broken vitest file.
- Steps 2–3 fixes must precede; broken compilation blocks ts-jest.

#### Risks

- Stryker v8 + jest@29 compat: documented working combo per skill; verify by running `stryker run --dry-run` after install.
- ts-jest deprecation of `globals.ts-jest` config in newer minors: pin to documented form.

#### Complexity

Large

#### Dependencies

Steps 1, 2, 3 (Level 0)

#### Uncertainty Rating

Medium

#### Integration Points

Every test in the project; CI workflow (Step 16).

#### Definition of Done

- [X] All four scripts present and individually invokable
- [X] Lockfile updated; vitest removed
- [X] Tests written and passing — config files don't have specs themselves; smoke-run the runners

---

## Phase 3: Decorators

### Step 7: Implement `@ExecuteWithPolicy` decorator [DONE]

**Model:** opus
**Agent:** sdd:developer
**Depends on:** Step 5, Step 6
**Parallel with:** Step 8, Step 10, Step 16, Step 18

Steps 7, 8, 10, 16, and 18 all become unblocked after Step 6 (with their additional non-conflicting prerequisites also satisfied) and MUST be launched in parallel by separate agents.

**Goal**: Create `src/client/execute-with-policy.decorator.ts` exporting a method-decorator factory that reads `context.target.policy`, runs the original method via `policy.execute`, and `firstValueFrom`s the returned Observable. Special-case `request` propertyKey to spread `signal: ctx.signal` into `args[0]` before invoking the wrapped method.

#### Expected Output

- `src/client/execute-with-policy.decorator.ts`: factory `ExecuteWithPolicy()` using `Wrap<TThis, TArgs, Promise<AxiosResponse>>` with unique exclusion key `Symbol('executeWithPolicy')`
- `src/client/__tests__/execute-with-policy.decorator.spec.ts`: covers (a) `policy.execute` invoked once per call; (b) original method called inside executor with original args; (c) Observable result unwrapped via `firstValueFrom`; (d) for `request` key, `signal` from `ctx.signal` injected into `args[0]`

#### Success Criteria

- [X] Decorator compiles and applies cleanly to a stub class with `policy: IPolicy` field
- [X] Spec asserts `policy.execute` called with a function; that function invokes the wrapped method with original args; result resolves to the AxiosResponse
- [X] `request`-keyed spec asserts `args[0].signal` is set to `ctx.signal` before the wrapped method receives it
- [X] Unit-test latency for this spec < 500 ms

#### Subtasks

- [X] Create `src/client/execute-with-policy.decorator.ts`
- [X] Implement factory using `Wrap` from base-decorators
- [X] Define `EXECUTE_WITH_POLICY_KEY: unique symbol = Symbol('executeWithPolicy')`
- [X] Inside wrapper: `await ctx.target.policy.execute(async (policyCtx) => firstValueFrom(method(...args)))`; for propertyKey === `'request'`, mutate `args[0]` to spread `signal: policyCtx.signal`
- [X] Create spec with constructor-injected `IPolicy` and `HttpService`-like stub returning `Observable`
- [X] Verify against ACs "All RestClient request methods run through the configured policy", "@ExecuteWithPolicy reads `this.policy` at call time", "request() forwards the policy context's signal"

#### Verification

**Level:** CRITICAL - Panel of 2 Judges with Aggregated Voting
**Artifact:** `src/client/execute-with-policy.decorator.ts` + `src/client/__tests__/execute-with-policy.decorator.spec.ts`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Decorator Semantics | 0.30 | `policy.execute` invoked once per call; `ctx.target.policy` read at call time (not capture time); original method body run inside `policy.execute(async (ctx) => firstValueFrom(method(...args)))`; Observable result unwrapped via `firstValueFrom` |
| Signal Forwarding (request) | 0.20 | For `propertyKey === 'request'`: `args[0].signal` set to `ctx.signal` before wrapped method invocation; AC "request() forwards the policy context's signal" satisfied |
| Test Coverage | 0.20 | Spec asserts: (a) `policy.execute` invoked once per call; (b) original method called inside executor with original args; (c) Observable unwrapped via `firstValueFrom`; (d) `request`-keyed test injects `ctx.signal` into `args[0]` |
| Wrap Integration | 0.15 | Uses `Wrap<TThis, TArgs, Promise<AxiosResponse>>` with unique exclusion key `Symbol('executeWithPolicy')`; auto-bound by Wrap (no `.bind/.call/.apply`) |
| Test Isolation | 0.10 | Constructor-injected `IPolicy` + `HttpService`-like stubs (no `jest.mock` of cockatiel/axios/@nestjs/axios); deterministic timing |
| Class Shape Contract | 0.05 | Reads `context.target.policy` at invocation time so policy can be swapped between calls |

**Reference Pattern:** `src/deduplicate-inflight.decorator.ts` (codebase Wrap-based decorator precedent)

#### Blockers

- Step 5 (base-decorators available)

#### Risks

- `firstValueFrom` resolution timing inside `policy.execute` — ensure async/await chain is correct so retry can intercept.
- `signal` injection for `request` only: do not break args ordering for verbs that don't have a config object at args[0].

#### Complexity

Medium

#### Dependencies

Step 5 (base-decorators), Step 6 (jest infra for spec)

#### Uncertainty Rating

Medium

#### Integration Points

`RestClient` (Step 9).

#### Definition of Done

- [X] Decorator file created and compiles
- [X] Spec file created
- [X] Tests written and passing

---

### Step 8: Implement `@Authenticate` decorator [DONE]

**Model:** opus
**Agent:** sdd:developer
**Depends on:** Step 4, Step 5, Step 6
**Parallel with:** Step 7, Step 10, Step 16, Step 18

Steps 7, 8, 10, 16, and 18 MUST be launched in parallel by separate agents.

**Goal**: Create `src/auth/authenticate.decorator.ts` exporting `Authenticate()` using `Wrap`. Steps inside the wrapper: (1) `await ctx.target.authStrategy.authenticateIfNeeded()`; (2) compute config arg index by `propertyKey` (1 for `get`/`delete`/`head`/`options`/`request`; 2 for `post`/`put`/`patch`/`postForm`/`putForm`/`patchForm`); (3) replace `args[idx]` via `extendRequest(args[idx] ?? {})`; (4) call wrapped method; (5) on `isAxiosError(err) && err.response?.status === 401`: clear auth, re-auth, re-extend, retry once; rethrow otherwise.

#### Expected Output

- `src/auth/authenticate.decorator.ts` factory + module-local helpers `extendConfigAtIndex`, `configArgIndex`
- `src/auth/__tests__/authenticate.decorator.spec.ts`: covers (a) `authenticateIfNeeded` called pre-flight; (b) config arg at correct index extended; (c) original headers preserved + new headers merged; (d) 401 triggers re-auth + retry-once; (e) repeated 401 rethrows after one retry; (f) non-401 axios error rethrows without re-auth; (g) non-axios error rethrows without re-auth

#### Success Criteria

- [X] Decorator compiles
- [X] All 7 spec scenarios above pass
- [X] Unique exclusion key `Symbol('authenticate')` used
- [X] `clearAuth()` called exactly once on 401 path, never on other paths

#### Subtasks

- [X] Create `src/auth/authenticate.decorator.ts`
- [X] Implement `configArgIndex(propertyKey)` and `extendConfigAtIndex(args, idx, strategy)` as module-level helpers
- [X] Implement `Authenticate()` factory using `Wrap` with `AUTHENTICATE_KEY`
- [X] Inside wrapper: pre-flight authenticateIfNeeded -> extend config -> try call -> on 401: clearAuth -> authenticateIfNeeded -> extend -> retry once
- [X] Create spec with stub `AuthStrategyService` (constructor-injected) and stub method that throws/succeeds per scenario
- [X] Verify ACs: "@Authenticate extends the request config", "HTTP 401 triggers exactly one re-auth and retry", "Repeated HTTP 401 propagates", "Non-401 errors do not trigger re-auth"

#### Verification

**Level:** CRITICAL - Panel of 2 Judges with Aggregated Voting
**Artifact:** `src/auth/authenticate.decorator.ts` + `src/auth/__tests__/authenticate.decorator.spec.ts`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Pre-flight Auth Logic | 0.20 | `await ctx.target.authStrategy.authenticateIfNeeded()` runs before wrapped method; `args[idx]` replaced via `extendRequest(args[idx] ?? {})`; original headers preserved + new headers merged |
| 401 Re-auth Once | 0.20 | `clearAuth()` -> `authenticateIfNeeded()` -> re-extend -> retry exactly once on `isAxiosError(err) && err.response?.status === 401`; AC "HTTP 401 triggers exactly one re-auth and retry" satisfied |
| Non-401 Error Handling | 0.15 | Non-401 axios errors and non-axios errors rethrow without re-auth; `clearAuth()` never called on non-401 paths; AC "Non-401 errors do not trigger re-auth" satisfied |
| Config-Arg Index | 0.15 | `configArgIndex(propertyKey)` returns 1 for `get`/`delete`/`head`/`options`/`request`; 2 for `post`/`put`/`patch`/`postForm`/`putForm`/`patchForm`; explicit method-name set (no fallthrough) |
| Test Coverage | 0.20 | All 7 spec scenarios pass: (a) pre-flight authenticateIfNeeded; (b) config arg at correct index; (c) headers merged; (d) 401 -> re-auth + retry once; (e) repeated 401 rethrows after one retry; (f) non-401 axios error rethrows; (g) non-axios error rethrows |
| Decorator Hygiene | 0.10 | Unique exclusion key `Symbol('authenticate')`; immutable `[...args]` copy used for mutation; helpers `extendConfigAtIndex` / `configArgIndex` module-local |

**Reference Pattern:** `src/deduplicate-inflight.decorator.ts` (codebase Wrap pattern) + Architecture Decomposition `@Authenticate` row

#### Blockers

- Step 5 (base-decorators), Step 4 (`AuthStrategy` type)

#### Risks

- Config-arg index mismatch for unusual verbs — keep the method-name set explicit and tested.
- Mutating `args[idx]` vs replacing the array: prefer immutable copy `[...args]` to avoid surprise mutation.

#### Complexity

Medium

#### Dependencies

Steps 4, 5, 6

#### Uncertainty Rating

Medium

#### Integration Points

`AuthRestClient` (Step 12).

#### Definition of Done

- [X] Decorator + helpers in single file
- [X] Spec covers all 7 scenarios
- [X] Tests written and passing

---

## Phase 4: Transport Layer

### Step 9: Build `RestClient` and replace `HttpClient` [DONE]

**Model:** opus
**Agent:** sdd:developer
**Depends on:** Step 5, Step 7
**Parallel with:** None (sole consumer of @ExecuteWithPolicy at this level)

**Goal**: Create `src/client/rest.client.ts` exporting `RestClient` implementing `Loggable`, with `policy: IPolicy<IDefaultPolicyContext, any>` public-readable field, default constructor argument `config: ResilanceConfig = resiliencePolicyPresets[ResilencePresets.CONSERVATIVE]`, and every public verb (`request`, `get`, `delete`, `head`, `post`, `put`, `patch`, `postForm`, `putForm`, `patchForm`) decorated with `@ExecuteWithPolicy()`. Delete `src/client/http.client.ts`.

#### Expected Output

- `src/client/rest.client.ts` with full verb surface
- `src/client/http.client.ts` deleted

#### Success Criteria

- [X] All verbs return `Promise<AxiosResponse<T>>` (decorator unwraps Observable)
- [X] `policy` field publicly readable (required by `@ExecuteWithPolicy`)
- [X] Constructor without explicit config defaults to CONSERVATIVE preset (verified by spec)
- [X] No reference to `HttpClient` anywhere in `src/`
- [X] Implements `Loggable` from `nestjs-log-decorator`
- [X] `request(config)` path forwards `signal` via decorator special-case

#### Subtasks

- [X] Create `src/client/rest.client.ts` per skill Pattern 1 + Example 1
- [X] Apply `@ExecuteWithPolicy()` on every verb
- [X] Delete `src/client/http.client.ts`
- [X] Search `src/` for any leftover `HttpClient` reference and remove
- [X] Verify build typechecks (`npx tsc --noEmit`)

#### Verification

**Level:** CRITICAL - Panel of 2 Judges with Aggregated Voting
**Artifact:** `src/client/rest.client.ts` (and confirmation that `src/client/http.client.ts` is deleted)
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Verb Coverage | 0.25 | Every verb (`request`, `get`, `delete`, `head`, `post`, `put`, `patch`, `postForm`, `putForm`, `patchForm`) decorated with `@ExecuteWithPolicy()`; AC "RestClient replaces HttpClient" + verb-set satisfied |
| Default Preset Behavior | 0.20 | Constructor signature `(httpService: HttpService, config?: ResilanceConfig<unknown>)` with default `resiliencePolicyPresets[ResilencePresets.CONSERVATIVE]` |
| Public Field Visibility | 0.15 | `policy: IPolicy<IDefaultPolicyContext, any>` public-readable field (required by `@ExecuteWithPolicy`); `axiosRef: AxiosInstance` exposed |
| Old Class Removal | 0.15 | `src/client/http.client.ts` deleted; grep `src/` for `HttpClient` returns zero matches; no stale references |
| Loggable Implementation | 0.10 | Implements `Loggable` from `nestjs-log-decorator`; `logger: Logger` field present |
| Type Signatures | 0.10 | All verbs typed `Promise<AxiosResponse<T, D>>` (decorator unwraps Observable); generic params consistent with RestClient Contract section |
| Build Hygiene | 0.05 | `npx tsc --noEmit` zero errors |

**Reference Pattern:** Contracts section "RestClient Contract" + nestjs-http-client-architecture skill Pattern 1 + Example 1

#### Blockers

- Steps 5, 7

#### Risks

- Forgetting a verb leaves an undecorated method that bypasses policy. Mitigation: enumerate the verb set explicitly in spec (the RestClient spec is authored in Step 11b).
- Loggable interface signature change from upstream `nestjs-log-decorator` could break compile. Mitigation: pin to existing version and re-verify.

#### Complexity

Medium

#### Dependencies

Steps 5, 7

#### Uncertainty Rating

Low

#### Integration Points

`AuthRestClient` (Step 12), `AuthRestModule` (Step 13).

#### Definition of Done

- [X] All verbs decorated
- [X] `http.client.ts` deleted
- [X] Build typechecks
- [X] Tests written and passing — spec authored in Step 11b

---

### Step 10: Migrate orphan specs and add foundational unit tests [DONE]

**Model:** opus
**Agent:** sdd:qa-engineer
**Depends on:** Step 2, Step 3, Step 6
**Parallel with:** Step 7, Step 8, Step 16, Step 18

Step 10 only tests pre-existing files (`shouldRetry.ts`, `deduplicate-inflight.decorator.ts`, `resailencePolicyBuilder.ts`) — it does NOT need RestClient (Step 9). It MUST run in parallel with Steps 7, 8, 16, and 18.

**Note:** The three sub-specs (`deduplicate-inflight.decorator.spec.ts` move/fix, `should-retry.spec.ts`, `resilience-policy-builder.spec.ts`) have no inter-dependencies and MUST be authored in parallel by sub-agents within this step.

| Sub-task | Description | Agent | Can Parallel |
|----------|-------------|-------|--------------|
| 10a | Move + fix deduplicate-inflight.decorator.spec.ts under jest | sdd:qa-engineer | Yes |
| 10b | Author should-retry.spec.ts (covers Step 2 fix + branches) | sdd:qa-engineer | Yes |
| 10c | Author resilience-policy-builder.spec.ts (4 branches + Noop) | sdd:qa-engineer | Yes |

**Goal**: Move `src/deduplicate-inflight.decorator.spec.ts` to `src/__tests__/deduplicate-inflight.decorator.spec.ts`, replace `@/cache/...` import with relative path. Add `src/__tests__/should-retry.spec.ts` covering the bug-fix from Step 2 (and all branches). Add `src/client/__tests__/resilience-policy-builder.spec.ts` covering all four config branches (retry / circuit breaker / bulkhead / fallback) and the empty-config NoopPolicy path.

#### Expected Output

- `src/__tests__/deduplicate-inflight.decorator.spec.ts` (moved + fixed)
- `src/__tests__/should-retry.spec.ts` (new; covers SAFE_HTTP_METHODS allow-list, CODE_EXCLUDE_LIST, non-axios errors, network errors)
- `src/client/__tests__/resilience-policy-builder.spec.ts` (new)
- Old `src/deduplicate-inflight.decorator.spec.ts` deleted

#### Success Criteria

- [X] All three specs run under jest with no library mocks
- [X] DeduplicateInflight spec asserts: concurrent calls collapse to one underlying invocation; `inflightMap` cleaned up in `finally` on success and error
- [X] should-retry spec covers every branch including the inverted-logic bug-fix (Step 2): GET 5xx -> retry; POST 5xx -> no retry; ECONNABORTED -> no retry per CODE_EXCLUDE_LIST; non-axios -> retry
- [X] resilience-policy-builder spec covers: empty config -> NoopPolicy; only retry -> single retry policy; only circuit breaker -> single CB; only bulkhead -> single bulkhead; only fallback -> single fallback; all four combined -> wrapped composition; backoff polymorphism (number / array / object / default)

#### Subtasks

- [X] Move spec file (git mv if available) and replace `@/cache/deduplicate-inflight.decorator` import with `'../deduplicate-inflight.decorator'`
- [X] Replace `vitest`-style imports with jest globals
- [X] Add `should-retry.spec.ts` with constructor-injected axios-error fixtures
- [X] Add `resilience-policy-builder.spec.ts` with all five branch tests
- [X] Run `npm run test:unit` — all three specs must pass

#### Verification

**Level:** Per-Spec Judges (3 separate evaluations in parallel)
**Artifacts:** `src/__tests__/{deduplicate-inflight.decorator.spec.ts, should-retry.spec.ts}` + `src/client/__tests__/resilience-policy-builder.spec.ts`
**Threshold:** 4.0/5.0

**Rubric (per spec):**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Coverage of Target | 0.30 | DeduplicateInflight: concurrent-call collapse + finally cleanup on success/error. should-retry: GET 5xx -> retry, POST 5xx -> no retry, ECONNABORTED -> no retry per CODE_EXCLUDE_LIST, non-axios -> retry, network errors. resilience-policy-builder: empty -> Noop, retry-only, CB-only, bulkhead-only, fallback-only, all-four-combined, backoff polymorphism (number / array / object / default) |
| Constructor Injection | 0.20 | No `jest.mock(...)` of axios, cockatiel, @nestjs/axios, base-decorators, nestjs-log-decorator, or p-retry; constructor-injected stubs only |
| Edge Cases | 0.20 | Bug-fix branches covered (Step 2 inversion verified by spec); error paths exercised; finally-cleanup on rejection paths; empty-config NoopPolicy path |
| Test Clarity | 0.15 | Test names describe scenario; arrange-act-assert structure; one logical assertion per `it` block |
| Jest Idioms | 0.15 | Jest globals (`describe`/`it`/`expect`); no `vitest` imports; relative imports (no `@/` path-alias); files at correct paths under `src/__tests__/` or `src/client/__tests__/` |

**Reference Pattern:** `nestjs-jest-testing` skill (Jest unit test conventions) + existing `src/deduplicate-inflight.decorator.spec.ts` (vitest version, to be migrated)

#### Blockers

- Step 6 (jest infra), Step 2 (shouldRetry fix), Step 3 (deduplicate-inflight import fix)

#### Risks

- Hidden behavioural differences between vitest and jest mocks — verify spec assertions still hold under jest.

#### Complexity

Medium

#### Dependencies

Steps 2, 3, 6

#### Uncertainty Rating

Low

#### Integration Points

CI pipeline (Step 16) and mutation-coverage gate (Step 19).

#### Definition of Done

- [X] All three specs present, passing under jest
- [X] No `@/` path-alias imports anywhere
- [X] Tests written and passing

---

## Phase 5: Auth Layer

### Step 11a: Build `AuthStrategyService` (implementation + spec) [DONE]

**Model:** opus
**Agent:** sdd:developer
**Depends on:** Step 3, Step 4, Step 5, Step 6
**Parallel with:** Step 7, Step 8, Step 10, Step 16, Step 18

Step 11a MUST be launched in parallel with Steps 7, 8, 10, 16, and 18 (all gated by Step 6).

**Goal**: Create `src/auth/auth-strategy.service.ts` with `inflightMap: Map<string, Promise<unknown>>` (public for `@DeduplicateInflight`), private `authResult: AuthStrategy | null = null`, and methods `isAuthenticated()`, `authenticateIfNeeded()`, `extendRequest(config)`, `clearAuth()`, plus private `performAuthenticate()` decorated with `@DeduplicateInflight(() => 'authenticate')`. Also author the matching unit spec.

#### Expected Output

- `src/auth/auth-strategy.service.ts`
- `src/auth/__tests__/auth-strategy.service.spec.ts`

#### Success Criteria

- [X] `authenticateIfNeeded` calls `performAuthenticate` only when `!isAuthenticated()` (skip-when-authed AC)
- [X] Concurrent `authenticateIfNeeded` calls produce exactly one `authConfig.authenticate` invocation (single-flight AC)
- [X] `extendRequest` throws if no auth handle yet (or returns config untouched — choose explicit semantic and document)
- [X] `clearAuth()` resets `authResult` to `null` so next `isAuthenticated()` returns `false`

#### Subtasks

- [X] Create `src/auth/auth-strategy.service.ts` per skill Pattern 2
- [X] Apply `@DeduplicateInflight(() => 'authenticate')` to private `performAuthenticate()`
- [X] Create `src/auth/__tests__/auth-strategy.service.spec.ts` with: skip-when-authed; concurrent dedupe; clearAuth; extendRequest-when-not-authenticated behaviour
- [X] Run `npm run test:unit` — spec passes

#### Verification

**Level:** CRITICAL - Panel of 2 Judges with Aggregated Voting
**Artifact:** `src/auth/auth-strategy.service.ts` + `src/auth/__tests__/auth-strategy.service.spec.ts`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Lifecycle Correctness | 0.25 | `isAuthenticated()` returns true iff cached `authResult` exists and its `isAuthenticated()` returns true; `authenticateIfNeeded()` short-circuits when authed; `extendRequest(config)` delegates to cached strategy; `clearAuth()` resets `authResult` to null |
| Single-flight Semantics | 0.25 | Concurrent `authenticateIfNeeded` -> exactly one underlying `authConfig.authenticate` invocation; `@DeduplicateInflight(() => 'authenticate')` applied to private `performAuthenticate`; key constant `'authenticate'` regardless of args |
| Spec Coverage | 0.20 | Spec covers: skip-when-authed AC; concurrent dedupe AC (50ms delayed authenticate, two parallel calls); `clearAuth` resets; explicit semantic for `extendRequest` when no handle (throw or untouched — documented and tested) |
| Field Visibility | 0.10 | `inflightMap: Map<string, Promise<unknown>>` public-readable for `@DeduplicateInflight`; `authResult` private; constructor `(authConfig: AuthConfig, client: RestClient)` |
| extendRequest Semantics | 0.10 | Behavior when no handle is documented and consistent (throw vs untouched); chosen semantic asserted in spec |
| Test Hygiene | 0.10 | Constructor-injected `AuthConfig` + `RestClient` stubs (no `jest.mock` of libraries); deterministic timing (small fixed delays managed by test); jest globals |

**Reference Pattern:** Contracts section "AuthStrategyService Contract" + `src/deduplicate-inflight.decorator.ts` (DeduplicateInflight pattern) + nestjs-http-client-architecture skill Pattern 2

#### Blockers

- Steps 3, 4, 5, 6

#### Risks

- `@DeduplicateInflight` key constancy — must always return the literal `'authenticate'` regardless of args.
- AuthStrategyService field visibility — `inflightMap` MUST be public for the decorator to read it.

#### Complexity

Medium

#### Dependencies

Steps 3, 4, 5, 6

#### Uncertainty Rating

Medium

#### Integration Points

`AuthRestClient` (Step 12), `AuthRestModule` (Step 13), RestClient spec (Step 11b).

#### Definition of Done

- [X] Service file created
- [X] All ACs around AuthStrategyService verified
- [X] Spec written and passing

---

### Step 11b: Author `RestClient` unit spec [DONE]

**Model:** opus
**Agent:** sdd:qa-engineer
**Depends on:** Step 9, Step 11a
**Parallel with:** Step 12

Step 11b MUST be launched in parallel with Step 12 (both share dependencies on Step 9 and Step 11a).

**Goal**: Author `src/client/__tests__/rest.client.spec.ts` (deferred from Step 9) covering all verbs x policy combinations + signal forwarding + default-preset.

#### Expected Output

- `src/client/__tests__/rest.client.spec.ts`

#### Success Criteria

- [X] RestClient spec: every verb passes through `policy.execute` exactly once per call (mock policy + axios)
- [X] RestClient spec: at least one combined-pipeline test (e.g. retry + circuit breaker + bulkhead + fallback) per AC
- [X] RestClient spec: `request({})` forwards `ctx.signal` to axios mock
- [X] RestClient spec: constructor without `config` defaults to CONSERVATIVE preset

#### Subtasks

- [X] Create `src/client/__tests__/rest.client.spec.ts`: per-verb policy pass-through; signal forwarding for `request`; default preset; all four cockatiel policy types in combination
- [X] Run `npm run test:unit` — spec passes

#### Verification

**Level:** Single Judge
**Artifact:** `src/client/__tests__/rest.client.spec.ts`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Verb Coverage | 0.30 | Every verb (`request`, `get`, `delete`, `head`, `post`, `put`, `patch`, `postForm`, `putForm`, `patchForm`) tested; `policy.execute` invoked exactly once per call; underlying axios call invoked correct number of times per policy semantics |
| Combined Pipeline Test | 0.20 | At least one test exercising retry + circuit breaker + bulkhead + fallback together (AC "All four cockatiel policy types are exercised in combination with RestClient" + composed-pipeline test) |
| Signal Forwarding | 0.20 | `restClient.request({})` forwards `ctx.signal` to axios mock; AC "request() forwards the policy context's signal" satisfied via spec |
| Default Preset Assertion | 0.15 | Constructor without explicit `config` -> CONSERVATIVE preset behavior verified (e.g. retry maxAttempts=3 for safe methods on 5xx) |
| Test Isolation | 0.15 | Constructor-injected `IPolicy` + axios stubs (mock only at axios adapter level); no `jest.mock` of cockatiel/@nestjs/axios; deterministic timing |

**Reference Pattern:** nestjs-http-client-architecture skill RestClient testing example + Contracts "RestClient Contract"

#### Blockers

- Steps 9, 11a

#### Risks

- Policy mocking surface drift — keep the mock thin; verify only `policy.execute` is called once per verb.

#### Complexity

Medium

#### Dependencies

Steps 9, 11a

#### Uncertainty Rating

Low

#### Integration Points

Coverage gate (Step 20).

#### Definition of Done

- [X] Spec covers every RestClient verb
- [X] Combined-pipeline test included
- [X] Tests written and passing

#### Notes

- Discovered and fixed a pre-existing bug in `src/resilence.policy.ts`: the
  `defaultCircutBreaker` (used by every preset) had `threshold: 1`, which
  cockatiel's `SamplingBreaker` rejects with `RangeError` (`threshold` must be
  strictly within `(0, 1)`). Adjusted to `0.99` to preserve the original
  "trip on near-total failure" intent. Without this fix the
  "constructor without `config` defaults to CONSERVATIVE preset" success
  criterion was not satisfiable — `new RestClient(httpService)` threw at
  construction time before any verb could be exercised.

---

### Step 12: Build `AuthRestClient` and delete `AuthenticatedHttpService` [DONE]

**Model:** opus
**Agent:** sdd:developer
**Depends on:** Step 8, Step 9, Step 11a
**Parallel with:** Step 11b

Step 12 MUST be launched in parallel with Step 11b (both share dependencies on Step 9 and Step 11a).

**Goal**: Create `src/auth/auth-rest.client.ts` with constructor `(restClient: RestClient, authStrategy: AuthStrategyService)`, public `authStrategy` field for decorator access, every verb is a thin forwarder to `restClient.<verb>(...)` decorated with `@Authenticate()`. Delete `src/auth/authenticated-http.service.ts`. Confirm zero `rxjs` and zero `p-retry` imports anywhere in `src/auth/`.

#### Expected Output

- `src/auth/auth-rest.client.ts`
- `src/auth/__tests__/auth-rest.client.spec.ts`
- `src/auth/authenticated-http.service.ts` deleted
- `src/auth/` directory has zero `from 'rxjs'` and zero `from 'p-retry'` imports

#### Success Criteria

- [X] All verbs forward to underlying RestClient
- [X] @Authenticate applied to every verb
- [X] `authStrategy` field is public-readable
- [X] Spec asserts: `AuthRestClient.get('/x', { headers: { y: 'z' } })` after auth produces a downstream call with merged headers including `Authorization: Bearer X` (when stub `extendRequest` returns Bearer)
- [X] Spec asserts: 401 first, success second -> exactly two underlying RestClient calls; `authenticateIfNeeded` invoked twice
- [X] Spec asserts: 500 -> `authenticateIfNeeded` invoked exactly once (pre-flight)
- [X] grep over `src/auth/` for `'rxjs'` and `'p-retry'` returns nothing

#### Subtasks

- [X] Create `src/auth/auth-rest.client.ts`
- [X] Apply `@Authenticate()` to every verb
- [X] Delete `src/auth/authenticated-http.service.ts`
- [X] Create `src/auth/__tests__/auth-rest.client.spec.ts` with constructor-injected stub RestClient + stub AuthStrategyService
- [X] Verify NFR "No rxjs / p-retry leakage" via grep

#### Verification

**Level:** CRITICAL - Panel of 2 Judges with Aggregated Voting
**Artifact:** `src/auth/auth-rest.client.ts` + `src/auth/__tests__/auth-rest.client.spec.ts` (and confirmation `src/auth/authenticated-http.service.ts` deleted)
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Composition Pattern | 0.20 | Constructor signature `(restClient: RestClient, authStrategy: AuthStrategyService)`; each verb is a thin forwarder to `restClient.<verb>(...)`; `@Authenticate()` applied to every verb |
| No rxjs / p-retry Leakage | 0.20 | Zero `from 'rxjs'` and zero `from 'p-retry'` imports anywhere in `src/auth/` (NFR + AC); grep confirms; no `firstValueFrom` usage |
| Verb Coverage | 0.15 | Every verb (request/get/delete/head/post/put/patch/postForm/putForm/patchForm) decorated and forwards correctly with same generic signature as RestClient |
| Spec Scenario Coverage | 0.20 | Spec asserts: (a) header merge after extendRequest (e.g. `Authorization: Bearer X` + original `y: 'z'`); (b) 401-then-success two-call path with `authenticateIfNeeded` invoked twice; (c) 500 single auth pre-flight (`authenticateIfNeeded` invoked once); (d) all verbs iterated to confirm decoration |
| Old Class Removal | 0.10 | `src/auth/authenticated-http.service.ts` deleted; no references to `AuthenticatedHttpService` in `src/` |
| Field Visibility | 0.10 | `authStrategy: AuthStrategyService` public-readable for `@Authenticate` decorator access |
| Test Hygiene | 0.05 | Constructor-injected stubs (no `jest.mock` of libraries); jest globals; deterministic timing |

**Reference Pattern:** Contracts section "AuthRestClient Contract" + Architecture Decomposition `AuthRestClient` row

#### Blockers

- Steps 8, 9, 11a

#### Risks

- Forgetting `@Authenticate` on a verb leaves it un-authenticated. Mitigation: spec iterates over all verbs.
- Recreating retry logic accidentally — ensure the decorator alone handles 401; non-401 errors are passed through to `RestClient`'s policy.

#### Complexity

Medium

#### Dependencies

Steps 8, 9, 11a

#### Uncertainty Rating

Low

#### Integration Points

`AuthRestModule` (Step 13).

#### Definition of Done

- [X] Client + spec + deletion complete
- [X] No rxjs / p-retry imports in `src/auth/`
- [X] Tests written and passing

---

## Phase 6: Module + Public Surface

### Step 13: Build `AuthRestModule.forRootAsync` [DONE]

**Model:** opus
**Agent:** sdd:developer
**Depends on:** Step 9, Step 11a, Step 12
**Parallel with:** None

**Goal**: Create `src/auth/auth-rest.module.ts` with `static forRootAsync(options: { useFactory, inject?, imports? }): DynamicModule`. Provide tokens for `AUTH_MODULE_OPTIONS`, `RestClient`, `AuthStrategyService`, `AuthRestClient`. Default `resilanceConfig = resiliencePolicyPresets[ResilencePresets.CONSERVATIVE]` when option absent. Export `AuthRestClient` and `RestClient`.

#### Expected Output

- `src/auth/auth-rest.module.ts` per skill Pattern 5

#### Success Criteria

- [X] `AuthRestModule.forRootAsync({ useFactory })` produces a valid `DynamicModule`
- [X] Bootstrapped via `Test.createTestingModule` resolves both `AuthRestClient` and `RestClient`
- [X] When factory returns options without `resilanceConfig`, the constructed `RestClient.policy` matches CONSERVATIVE preset (assert by checking that retry policy applies to GET 5xx through three attempts)
- [X] Module accepts `inject` and `imports` arrays passed through to NestJS DI

#### Subtasks

- [X] Create `src/auth/auth-rest.module.ts`
- [X] Define `AUTH_MODULE_OPTIONS` symbol
- [X] Implement `forRootAsync` per skill Pattern 5
- [X] Default-preset fallback in the `RestClient` factory
- [X] Spec deferred to Step 15

#### Verification

**Level:** CRITICAL - Panel of 2 Judges with Aggregated Voting
**Artifact:** `src/auth/auth-rest.module.ts`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| forRootAsync Contract | 0.25 | Exact signature: `static forRootAsync(options: { useFactory: (...args: unknown[]) => Promise<AuthRestModuleOptions> | AuthRestModuleOptions; inject?: unknown[]; imports?: unknown[] }): DynamicModule` matches Contracts section |
| Provider Wiring | 0.25 | Providers for `AUTH_MODULE_OPTIONS`, `RestClient`, `AuthStrategyService`, `AuthRestClient` registered in correct dependency order; AUTH_MODULE_OPTIONS resolved first; no circular DI |
| Default Preset Fallback | 0.20 | `opts.resilanceConfig ?? resiliencePolicyPresets[ResilencePresets.CONSERVATIVE]` resolved inside `RestClient` factory; AC "AuthRestModule defaults to CONSERVATIVE preset" satisfied |
| Exports | 0.15 | Module `exports` array contains both `AuthRestClient` and `RestClient` (consumer can inject either) |
| inject/imports Pass-through | 0.10 | NestJS-idiomatic propagation of `inject` and `imports` arrays from `forRootAsync` options into the dynamic module result |
| Module Symbol Hygiene | 0.05 | `AUTH_MODULE_OPTIONS` defined as Symbol or string token consistently across providers; not a magic string |

**Reference Pattern:** nestjs-http-client-architecture skill Pattern 5 (forRootAsync) + Contracts section "AuthRestModule Contract"

#### Blockers

- Steps 9, 11a, 12

#### Risks

- Provider ordering / circular DI: keep `AUTH_MODULE_OPTIONS` first; resolve in dependency order.
- Re-exporting `RestClient` from this module while it's also constructed per-request could cause two instances if the consumer registers `RestClient` elsewhere. Mitigation: document that this module is the single source of truth.

#### Complexity

Medium

#### Dependencies

Steps 9, 11a, 12

#### Uncertainty Rating

Medium

#### Integration Points

Public surface (Step 14), e2e (Step 17).

#### Definition of Done

- [X] Module file created
- [X] forRootAsync signature matches contract
- [X] Tests written and passing — spec authored in Step 15

---

### Step 14: Rewrite `src/index.ts` public surface [DONE]

**Model:** opus
**Agent:** sdd:developer
**Depends on:** Step 9, Step 11a, Step 12, Step 13
**Parallel with:** None

**Goal**: Update `src/index.ts` to export the full new public surface and remove all references to deleted classes. Exports must include: `RestClient`, `AuthRestClient`, `AuthStrategyService`, `AuthRestModule`, `AuthConfig`, `AuthStrategy`, `ResilanceConfig` (and sub-types `RetryConfig`, `CircuitBreakerConfig`, `BulkheadConfig`, `FallbackConfig`), `ResilencePresets`, `resiliencePolicyPresets`, `ExecuteWithPolicy`, `Authenticate`, `DeduplicateInflight`.

#### Expected Output

- `src/index.ts` rewritten

#### Success Criteria

- [X] `import { RestClient, AuthRestClient, AuthStrategyService, AuthRestModule, AuthConfig, AuthStrategy } from '..'` resolves from a fresh consumer perspective
- [X] No `HttpClient` or `AuthenticatedHttpService` exports remain
- [X] `npm run build` produces `dist/` with all listed names in `dist/index.d.cts`

#### Subtasks

- [X] Rewrite `src/index.ts`
- [X] Run `npm run build` to confirm `dist/` reflects the new surface
- [X] grep `dist/index.d.cts` for the names listed above
- [X] grep `src/` for `HttpClient` / `AuthenticatedHttpService` to confirm zero references

#### Verification

**Level:** CRITICAL - Panel of 2 Judges with Aggregated Voting
**Artifact:** `src/index.ts` (and `dist/index.d.cts` after build)
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Export Completeness | 0.30 | All required names exported: `RestClient`, `AuthRestClient`, `AuthStrategyService`, `AuthRestModule`, `AuthConfig`, `AuthStrategy`, `ResilanceConfig` (+ sub-types `RetryConfig`, `CircuitBreakerConfig`, `BulkheadConfig`, `FallbackConfig`), `ResilencePresets`, `resiliencePolicyPresets`, `ExecuteWithPolicy`, `Authenticate`, `DeduplicateInflight` |
| Old Class Removal | 0.25 | Zero `HttpClient` and zero `AuthenticatedHttpService` exports; grep `src/` for these names returns zero matches; AC satisfied |
| Type vs Runtime Exports | 0.20 | Type-only exports use `export type` (e.g. `AuthConfig`, `AuthStrategy`, `ResilanceConfig` and sub-types); runtime classes/decorators use `export`/`export {}`; mixing avoided |
| Build Verification | 0.15 | `npm run build` produces `dist/index.cjs` and `dist/index.d.cts` containing all listed names; AC "Definition of Done: dist contains the new public surface" satisfied |
| No Stale References | 0.10 | grep `src/` for `HttpClient`, `AuthenticatedHttpService`, `withHttpRetry`, old AuthConfig fields (`endpoint`/`requestBuilder`/`responseExtractor`/`headerBuilder`), local `isRetryableError` helper returns zero |

**Reference Pattern:** Acceptance Criteria "Definition of Done" list + Contracts section as the source-of-truth for the public surface

#### Blockers

- Steps 9, 11a, 12, 13

#### Risks

- Type-only exports must use `export type`; runtime exports must use `export`. Mixing leads to runtime errors.

#### Complexity

Small

#### Dependencies

Steps 9, 11a, 12, 13

#### Uncertainty Rating

Low

#### Integration Points

E2e specs (Step 17), README API reference (Step 19).

#### Definition of Done

- [X] Full public surface exported
- [X] Build green
- [X] Tests written and passing — covered indirectly via Step 15 module spec and Step 17 e2e specs

---

### Step 15: Author `AuthRestModule` spec [DONE]

**Model:** opus
**Agent:** sdd:qa-engineer
**Depends on:** Step 14
**Parallel with:** None

Step 15 MUST run sequentially after Step 14 to avoid drift between the spec and the just-rewritten public surface.

**Goal**: Create `src/auth/__tests__/auth-rest.module.spec.ts` using `Test.createTestingModule` from `@nestjs/testing` to bootstrap `AuthRestModule.forRootAsync(...)` and assert both clients resolve, plus the default-preset fallback.

#### Expected Output

- `src/auth/__tests__/auth-rest.module.spec.ts`

#### Success Criteria

- [X] Bootstrap with `useFactory: () => ({ httpService, authConfig })` resolves without error
- [X] `module.get(AuthRestClient)` and `module.get(RestClient)` return instances
- [X] When factory omits `resilanceConfig`, the resolved `RestClient.policy` reflects CONSERVATIVE preset (verify via behavioural assertion: 5xx GET retries 3 times)
- [X] When factory provides explicit `resilanceConfig`, it overrides the default

#### Subtasks

- [X] Add `@nestjs/testing` to devDependencies if not present
- [X] Create the spec
- [X] Mock `HttpService` constructor-injection style; do not `jest.mock('@nestjs/axios')`
- [X] Run under jest

#### Verification

**Level:** Single Judge
**Artifact:** `src/auth/__tests__/auth-rest.module.spec.ts`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Bootstrap Coverage | 0.30 | `Test.createTestingModule({ imports: [AuthRestModule.forRootAsync({ useFactory })] })` bootstraps without error; AC "AuthRestModule.forRootAsync exports both clients" satisfied |
| Resolution Assertion | 0.25 | `module.get(AuthRestClient)` and `module.get(RestClient)` both return instances of the correct types |
| Default-Preset Assertion | 0.25 | When `useFactory` returns options without `resilanceConfig`, resolved `RestClient.policy` reflects CONSERVATIVE preset (behavioural assertion: 5xx GET retries 3 times) |
| Override Assertion | 0.15 | Explicit `resilanceConfig` in factory output overrides default; behavioural assertion verifies the override is applied |
| Test Hygiene | 0.05 | No `jest.mock('@nestjs/axios')`; constructor-style `HttpService` mock; jest globals; deterministic timing |

**Reference Pattern:** Acceptance Criteria "AuthRestModule defaults to CONSERVATIVE preset" + nestjs-jest-testing skill (NestJS testing module setup)

#### Blockers

- Step 14

#### Risks

- `@nestjs/testing` version drift from `@nestjs/common` peer; use existing peer-deps version.

#### Complexity

Medium

#### Dependencies

Step 14

#### Uncertainty Rating

Low

#### Integration Points

CI verify chain (Step 18).

#### Definition of Done

- [X] Spec covers both clients and default-preset assertion
- [X] Tests written and passing

---

## Phase 7: E2E

### Step 16: Stand up testcontainers harness [DONE]

**Model:** opus
**Agent:** sdd:developer
**Depends on:** Step 6
**Parallel with:** Step 7, Step 8, Step 10, Step 18

Step 16 MUST be launched in parallel with Steps 7, 8, 10, and 18.

**Goal**: Create `tests/e2e-setup.ts` and `tests/e2e-teardown.ts` using `GenericContainer('kennethreitz/httpbin')` with `Wait.forHttp('/get', 80).forStatusCode(200)`. Expose `process.env.TEST_HTTP_BASE_URL` to specs. Wire into `jest.e2e.config.ts` as `globalSetup`/`globalTeardown`.

#### Expected Output

- `tests/e2e-setup.ts`
- `tests/e2e-teardown.ts`
- `jest.e2e.config.ts` updated

#### Success Criteria

- [X] `npm run test:e2e` starts a container and stops it on completion
- [X] `process.env.TEST_HTTP_BASE_URL` available inside specs
- [X] Setup/teardown timeout handled (testTimeout: 60000)

#### Subtasks

- [X] Create `tests/e2e-setup.ts` per skill Example 2
- [X] Create `tests/e2e-teardown.ts`
- [X] Wire `globalSetup`/`globalTeardown` paths in `jest.e2e.config.ts` (already wired before this step; verified)
- [X] Smoke-run: trivial spec hitting `${TEST_HTTP_BASE_URL}/get` via plain `axios.get` (`tests/smoke.e2e.spec.ts`)

#### Verification

**Level:** Single Judge
**Artifact:** `tests/e2e-setup.ts` + `tests/e2e-teardown.ts` + `jest.e2e.config.ts` (globalSetup/globalTeardown wiring)
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Container Lifecycle | 0.30 | `GenericContainer('kennethreitz/httpbin')` started in setup; stopped in teardown; `Wait.forHttp('/get', 80).forStatusCode(200)` strategy used; container handle persisted across setup/teardown |
| Env Var Exposure | 0.20 | `process.env.TEST_HTTP_BASE_URL` set in setup and available inside specs (computed from container's mapped port + host) |
| Jest Wiring | 0.20 | `globalSetup` and `globalTeardown` paths set in `jest.e2e.config.ts` pointing to the harness files |
| Timeout Handling | 0.15 | `testTimeout: 60000` set in `jest.e2e.config.ts` to cover image pull on first run |
| Smoke-Run Verified | 0.15 | Trivial spec hitting `${TEST_HTTP_BASE_URL}/get` via plain `axios.get` returns 200; container start/stop cycle observed |

**Reference Pattern:** `testcontainers` skill (DockerComposeEnvironment / GenericContainer harness pattern) + nestjs-http-client-architecture skill Example 2

#### Blockers

- Step 6, Docker available locally.

#### Risks

- Docker not available in some CI runners — verify the chosen GitHub runner has Docker (`ubuntu-latest` does).
- httpbin image pull time on first run; testTimeout 60s should cover.

#### Complexity

Medium

#### Dependencies

Step 6

#### Uncertainty Rating

Medium

#### Integration Points

Step 17 e2e specs; CI workflow (Step 18).

#### Definition of Done

- [X] Container lifecycle works
- [X] env var exposed
- [X] Tests written and passing — smoke spec used as gate

---

### Step 17: Author e2e specs for `RestClient` and `AuthRestClient` [DONE]

**Model:** opus
**Agent:** sdd:qa-engineer
**Depends on:** Step 14, Step 16
**Parallel with:** Step 19

Steps 17 and 19 share the same prerequisite (Step 14) and MUST be launched in parallel by separate agents.

**Note:** The two e2e specs (`rest-client.e2e.spec.ts` and `auth-rest-client.e2e.spec.ts`) are independent and MUST be authored in parallel by sub-agents.

| Sub-task | Description | Agent | Can Parallel |
|----------|-------------|-------|--------------|
| 17a | rest-client.e2e.spec.ts (httpbin /get, /status/500, /anything) | sdd:qa-engineer | Yes |
| 17b | auth-rest-client.e2e.spec.ts (header verify, /status/401 re-auth) | sdd:qa-engineer | Yes |

**Goal**: Create `tests/rest-client.e2e.spec.ts` (httpbin `/get`, `/status/500`, `/anything`) and `tests/auth-rest-client.e2e.spec.ts` (httpbin `/anything` for header verification; `/status/401` then success for re-auth flow). Both specs use real `RestClient` / `AuthRestClient` from the public surface.

#### Expected Output

- `tests/rest-client.e2e.spec.ts`
- `tests/auth-rest-client.e2e.spec.ts`

#### Success Criteria

- [X] `npm run test:e2e` exits 0 within 2 minutes (NFR)
- [X] rest-client spec: GET `/get` returns 200; GET `/status/500` exhausts retries; POST `/anything` echoes body
- [X] auth-rest-client spec: stub `authenticate` returns Bearer; GET `/anything` request includes `Authorization: Bearer X` in echoed headers; first call gets 401 from `/status/401`, retry path reaches `/anything` successfully (or, alternatively, two `/anything` calls verify "exactly one re-auth on 401")
- [X] Specs use the public surface from `src/index.ts` (consumer-style import)

#### Subtasks

- [X] Create `tests/rest-client.e2e.spec.ts`
- [X] Create `tests/auth-rest-client.e2e.spec.ts`
- [X] Build a stub `AuthConfig` whose `authenticate` returns a synchronous Bearer-injecting `extendRequest`
- [X] Run `npm run test:e2e` end-to-end

#### Verification

**Level:** Per-Spec Judges (2 separate evaluations in parallel)
**Artifacts:** `tests/rest-client.e2e.spec.ts` and `tests/auth-rest-client.e2e.spec.ts`
**Threshold:** 4.0/5.0

**Rubric (per spec):**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Scenario Coverage | 0.30 | rest-client.e2e: GET `/get` returns 200; GET `/status/500` exhausts retries (3 attempts under CONSERVATIVE); POST `/anything` echoes body. auth-rest-client.e2e: stub `authenticate` returns Bearer; GET `/anything` shows `Authorization: Bearer X` in echoed headers; first 401 from `/status/401` triggers re-auth path |
| Public-Surface Import | 0.20 | Spec imports `RestClient` / `AuthRestClient` from the public surface (consumer-style — `from '../src/index'` or via package name); not internal paths |
| Determinism | 0.20 | No real wall-clock waits; respects `testTimeout: 60000`; suite completes within NFR-mandated 2 minutes |
| Container Usage | 0.15 | Uses `process.env.TEST_HTTP_BASE_URL` from harness (Step 16); no hard-coded ports or hostnames |
| Assertions | 0.15 | Strong assertions on response status codes, response bodies, echoed headers (httpbin echoes back); not just `expect().not.toThrow()` |

**Reference Pattern:** Acceptance Criteria "test:e2e starts a testcontainers dummy service and exercises the clients" + Runtime Scenarios (Successful authenticated GET; HTTP 401 -> re-auth -> retry once)

#### Blockers

- Steps 14, 16

#### Risks

- httpbin's `/status/401` behaviour differs across forks — pin to `kennethreitz/httpbin`.
- Network/DNS flakiness in CI — set retry on the test runner if needed.

#### Complexity

Medium

#### Dependencies

Steps 14, 16

#### Uncertainty Rating

Medium

#### Integration Points

CI workflow (Step 18).

#### Definition of Done

- [X] Both specs pass end-to-end
- [X] Tests written and passing

---

## Phase 8: Polish

### Step 18: Rename `build.yaml` to `verify.yaml` and run full chain [DONE]

**Model:** haiku
**Agent:** haiku
**Depends on:** Step 6
**Parallel with:** Step 7, Step 8, Step 10, Step 16

Step 18 only needs the npm scripts from Step 6 in place; the workflow file change does NOT require e2e specs to exist (Step 17 / Step 20 cover the actual CI green-check). Step 18 MUST be launched in parallel with Steps 7, 8, 10, and 16.

**Goal**: Rename `.github/workflows/build.yaml` to `verify.yaml`, update its job to run `npm ci && npm run test && npm run build`. Confirm Docker is available on the runner.

#### Expected Output

- `.github/workflows/verify.yaml` (new name; updated content)
- `.github/workflows/build.yaml` deleted

#### Success Criteria

- [ ] On push/PR to `master`, the workflow runs and exits 0 when local `npm run test && npm run build` is green
- [X] No `build.yaml` remains
- [X] Workflow runs `npm run test` (chains unit/e2e/mutation) and `npm run build`

#### Subtasks

- [X] `git mv .github/workflows/build.yaml .github/workflows/verify.yaml`
- [X] Update the workflow YAML: rename `name:` to `verify`; replace test step with `npm run test`; ensure `services` or `runs-on: ubuntu-latest` provides Docker for testcontainers
- [ ] Push branch and confirm green (handled by repo owner pre-merge)

#### Verification

**Level:** Single Judge
**Artifact:** `.github/workflows/verify.yaml`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Rename Correctness | 0.30 | `.github/workflows/verify.yaml` exists with the new content; `.github/workflows/build.yaml` deleted (git mv preferred); AC "verify.yaml replaces build.yaml" satisfied |
| Job Definition | 0.30 | Workflow runs `npm ci && npm run test && npm run build` (or equivalent ordered steps); test chain reaches both unit + e2e + mutation gates |
| Docker Availability | 0.20 | `runs-on: ubuntu-latest` (provides Docker for testcontainers) or explicit `services: docker` block; no manual Docker setup needed |
| Workflow Name | 0.10 | `name: verify` (top-level) consistent with file name |
| Trigger Configuration | 0.10 | Triggers on push and pull_request to `master` branch (per AC) |

**Reference Pattern:** Existing `.github/workflows/build.yaml` (current source) + nestjs-jest-testing skill (reusable GitHub Actions verify workflow)

#### Blockers

- Step 6 (test scripts must exist in package.json before workflow references them)

#### Risks

- Mutation testing on CI may exceed minutes-of-compute budget — verify or mark `test:mutation` as a separate scheduled job if needed.

#### Complexity

Small

#### Dependencies

Step 6 only (CI green-check is asserted in Step 20; this step only edits the workflow file)

#### Uncertainty Rating

Medium

#### Integration Points

Repo CI; PR gates.

#### Definition of Done

- [X] verify.yaml runs the full chain
- [X] build.yaml absent
- [ ] Tests written and passing — workflow itself is the test

---

### Step 19: Update README and CONTRIBUTING [DONE]

**Model:** opus
**Agent:** opus
**Depends on:** Step 14
**Parallel with:** Step 17

Steps 17 and 19 MUST be launched in parallel by separate agents.

**Note:** The README and CONTRIBUTING updates are independent files and MAY be authored in parallel by sub-agents.

| Sub-task | Description | Agent | Can Parallel |
|----------|-------------|-------|--------------|
| 19a | README.md rewrite (quick-start, usage, API reference) | opus | Yes |
| 19b | CONTRIBUTING.md update (test commands + Docker prereq) | opus | Yes |

**Goal**: Update `README.md` with quick-start (`AuthRestModule.forRootAsync` example), usage examples (Bearer + Basic `authenticate` callbacks; bare `RestClient` usage), and an API reference section listing every public class, decorator, and config type. Update `CONTRIBUTING.md` to document `test:unit`, `test:e2e`, `test:mutation`, `test`, and prerequisite (Docker for e2e).

#### Expected Output

- `README.md` updated
- `CONTRIBUTING.md` updated

#### Success Criteria

- [X] README quick-start covers `AuthRestModule.forRootAsync` with at least one Bearer example and one Basic example
- [X] README has API reference entries for: `RestClient`, `AuthRestClient`, `AuthStrategyService`, `AuthRestModule`, `AuthConfig`, `AuthStrategy`, `ResilanceConfig`, `ResilencePresets`, `resiliencePolicyPresets`, `@ExecuteWithPolicy`, `@Authenticate`, `@DeduplicateInflight`
- [X] CONTRIBUTING.md documents the four test commands and Docker prereq

#### Subtasks

- [X] Update `README.md`: rewrite Features bullets to match implemented surface; add Quick Start; add Usage; add API Reference section
- [X] Update `CONTRIBUTING.md` with new commands
- [X] Verify all code samples in docs typecheck (mental compile or run via `tsx` if practical)

#### Verification

**Level:** Per-Doc Judges (2 separate evaluations in parallel)
**Artifacts:** `README.md` (19a) and `CONTRIBUTING.md` (19b)
**Threshold:** 4.0/5.0

**Rubric for README.md (19a):**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Quick-start Coverage | 0.25 | `AuthRestModule.forRootAsync` example with at least one Bearer and one Basic `authenticate` callback variant; runnable code shape |
| API Reference Completeness | 0.30 | Documented entries for: `RestClient`, `AuthRestClient`, `AuthStrategyService`, `AuthRestModule`, `AuthConfig`, `AuthStrategy`, `ResilanceConfig`, `ResilencePresets`, `resiliencePolicyPresets`, `@ExecuteWithPolicy`, `@Authenticate`, `@DeduplicateInflight` |
| Accuracy | 0.20 | Code samples reflect implemented surface (no `HttpClient`/`AuthenticatedHttpService`/old AuthConfig fields); samples typecheck mentally; preset names spelled correctly |
| Usage Examples | 0.15 | Bare `RestClient` usage shown; preset selection (CONSERVATIVE / RESTFULL / LOW_QUALITY) documented; integration scenarios (401 retry, concurrent auth) referenced |
| Consistency | 0.10 | Terminology matches code: `RestClient`/`AuthRestClient` (not `HttpClient`); `AuthRestModule.forRootAsync` (not `forRoot`); decorator names with `@` prefix |

**Rubric for CONTRIBUTING.md (19b):**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Test Commands Documented | 0.40 | `test:unit`, `test:e2e`, `test:mutation`, `test` (chain) all documented with descriptions |
| Prerequisite Documentation | 0.30 | Docker prereq for `test:e2e` clearly stated; mention testcontainers / httpbin if relevant |
| Accuracy | 0.20 | Commands match `package.json` scripts exactly; no stale `vitest` references |
| Clarity | 0.10 | Step-by-step usable by a new contributor; commands invocable as written |

**Reference Pattern:** Existing `README.md` structure (Features, Configuration Strategies, Special Thanks) + Acceptance Criteria "README documents quick-start, usage, and API reference"

#### Blockers

- Step 14

#### Risks

- Docs drift if surface changes after this step — keep this step as late as possible.

#### Complexity

Medium

#### Dependencies

Step 14

#### Uncertainty Rating

Low

#### Integration Points

Consumer onboarding.

#### Definition of Done

- [X] README + CONTRIBUTING updated to match implemented surface
- [X] Tests written and passing — N/A docs-only

---

### Step 20: Final verification — coverage ratchet + mutation gate [DONE]

**Model:** opus
**Agent:** sdd:qa-engineer
**Depends on:** All prior steps (1-19)
**Parallel with:** None — final gate

**Goal**: Run the full `npm run test` chain. If `coverageThreshold` not met, write additional tests until coverage >= 80% all dimensions and `jest-it-up` ratchets the floor. If Stryker mutation score < 80%, identify surviving mutants in the report and add tests until score >= 80%.

#### Expected Output

- `npm run test` exits 0
- Coverage `coverage/coverage-summary.json` shows all four metrics >= configured threshold
- Stryker `reports/mutation/mutation.html` shows score >= 80%

#### Success Criteria

- [X] `npm run test:unit` -> exit 0; coverage >= 80% branches/functions/lines/statements
- [X] `posttest:unit` (jest-it-up) ratchets thresholds without regression
- [X] `npm run test:e2e` -> exit 0 in < 2 minutes
- [X] `npm run test:mutation` -> exit 0 with mutation score >= 80%
- [X] `npm run test` chain exits 0 end-to-end

#### Subtasks

- [X] Run `npm run test:unit` and inspect `coverage/coverage-summary.json`
- [X] Add tests as needed until coverage gates pass
- [X] Run `npm run test:mutation`; inspect mutation report
- [X] Strengthen specs for any surviving mutant clusters (boundary conditions, error paths, equality flips)
- [X] Re-run mutation; iterate until >= 80%
- [X] Run full `npm run test`; confirm green

#### Verification

**Level:** CRITICAL - Panel of 2 Judges with Aggregated Voting
**Artifact:** `coverage/coverage-summary.json` + `reports/mutation/mutation.html` + `npm run test` exit status
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Unit Coverage Met | 0.25 | All four metrics (branches, functions, lines, statements) >= 80% in `coverage/coverage-summary.json`; AC "test:unit reports coverage" satisfied |
| jest-it-up Ratchet | 0.15 | `posttest:unit` ratchets thresholds in jest config without regression; running again with same coverage exits 0 |
| E2E Latency | 0.15 | `npm run test:e2e` exits 0 in < 2 minutes (NFR); container lifecycle clean |
| Mutation Score | 0.25 | Stryker mutation score >= 80%; surviving mutants analyzed and addressed; `break: 80` enforced; AC "test:mutation enforces a mutation score of at least 80%" satisfied |
| Test Chain Green | 0.15 | `npm run test` exits 0 end-to-end (unit + e2e + mutation chained sequentially); failure in any sub-suite aborts chain |
| Iteration Discipline | 0.05 | Surviving mutant clusters (boundary conditions, equality flips, error paths) analyzed in scratchpad/notes; spec strengthening targeted at survivors, not superficial assertion bumps |

**Reference Pattern:** Acceptance Criteria "Definition of Done (Task Level)" + nestjs-jest-testing skill (Stryker survivor analysis pattern)

#### Blockers

- All prior steps.

#### Risks

- Mutation gate may require many additional spec assertions; budget for an iteration loop.
- jest-it-up may bump thresholds above 80% if current run exceeds — that is intended behaviour.

#### Complexity

Large

#### Dependencies

All prior steps

#### Uncertainty Rating

High (mutation score outcome unknown until first run)

#### Integration Points

Final release gate.

#### Definition of Done

- [X] All four metrics pass
- [X] Mutation score >= 80%
- [X] `npm run test` chain green
- [X] Tests written and passing (the iteration is itself the work)

---

## Verification Summary

| Step | Verification Level | Judges | Threshold | Artifacts |
|------|-------------------|--------|-----------|-----------|
| 1 | NONE | - | - | tests/index.test.ts deletion (binary) |
| 2 | Single Judge | 1 | 4.0/5.0 | src/shouldRetry.ts (single-line fix) |
| 3 | Single Judge | 1 | 4.0/5.0 | src/deduplicate-inflight.decorator.ts (import + local KeyBuilder type) |
| 4 | Panel (2) | 2 | 4.0/5.0 | src/auth/auth.config.ts (AuthConfig + AuthStrategy types) |
| 5 | Panel (2) | 2 | 4.0/5.0 | base-decorators package (or shim under src/base-decorators/) |
| 6 | Panel (2) | 2 | 4.0/5.0 | jest/stryker/testcontainers configs + package.json scripts |
| 7 | Panel (2) | 2 | 4.0/5.0 | @ExecuteWithPolicy decorator + spec |
| 8 | Panel (2) | 2 | 4.0/5.0 | @Authenticate decorator + spec |
| 9 | Panel (2) | 2 | 4.0/5.0 | RestClient transport class |
| 10 | Per-Item (3) | 3 | 4.0/5.0 | dedup-inflight, should-retry, resilience-policy-builder specs |
| 11a | Panel (2) | 2 | 4.0/5.0 | AuthStrategyService + spec |
| 11b | Single Judge | 1 | 4.0/5.0 | RestClient unit spec |
| 12 | Panel (2) | 2 | 4.0/5.0 | AuthRestClient + spec |
| 13 | Panel (2) | 2 | 4.0/5.0 | AuthRestModule.forRootAsync |
| 14 | Panel (2) | 2 | 4.0/5.0 | src/index.ts public surface |
| 15 | Single Judge | 1 | 4.0/5.0 | AuthRestModule spec |
| 16 | Single Judge | 1 | 4.0/5.0 | testcontainers e2e harness |
| 17 | Per-Item (2) | 2 | 4.0/5.0 | rest-client + auth-rest-client e2e specs |
| 18 | Single Judge | 1 | 4.0/5.0 | .github/workflows/verify.yaml |
| 19 | Per-Item (2) | 2 | 4.0/5.0 | README.md + CONTRIBUTING.md |
| 20 | Panel (2) | 2 | 4.0/5.0 | coverage-summary.json + mutation report + test chain status |

**Total Evaluations:** 35 (Single: 6 × 1 = 6; Panel: 11 × 2 = 22; Per-Item: 3 + 2 + 2 = 7; NONE: 1 step skipped)
**Implementation Command:** `/implement .specs/tasks/draft/complete-initial-feature-set.feature.md`

---

## Implementation Summary

| Step | Goal | Output | Est. Effort |
|------|------|--------|-------------|
| 1 | Delete broken vitest stub | tests/index.test.ts removed | S |
| 2 | Fix shouldRetry inverted logic | shouldRetry.ts:24 corrected | S |
| 3 | Fix deduplicate-inflight import | KeyBuilder local in deduplicate-inflight.decorator.ts | S |
| 4 | AuthConfig + AuthStrategy types | src/auth/auth.config.ts | S |
| 5 | base-decorators install or shim | base-decorators available; optional shim + tests | M |
| 6 | Jest+Stryker+testcontainers infra | configs + scripts; vitest removed | L |
| 7 | @ExecuteWithPolicy decorator + spec | execute-with-policy.decorator.ts + spec | M |
| 8 | @Authenticate decorator + spec | authenticate.decorator.ts + spec | M |
| 9 | RestClient (replace HttpClient) | rest.client.ts; http.client.ts deleted | M |
| 10 | Foundational specs (move + new) | deduplicate/should-retry/policy-builder specs | M |
| 11a | AuthStrategyService impl + spec | auth-strategy.service.ts + spec | M |
| 11b | RestClient unit spec | rest.client.spec.ts | M |
| 12 | AuthRestClient (replace AuthenticatedHttpService) | auth-rest.client.ts + spec; old deleted | M |
| 13 | AuthRestModule.forRootAsync | auth-rest.module.ts | M |
| 14 | Rewrite src/index.ts public surface | full export list | S |
| 15 | AuthRestModule spec | auth-rest.module.spec.ts | M |
| 16 | testcontainers harness | tests/e2e-setup.ts + teardown + jest.e2e.config wiring | M |
| 17 | E2E specs (RestClient + AuthRestClient) | 2 e2e specs | M |
| 18 | Rename build.yaml -> verify.yaml | workflow updated | S |
| 19 | README + CONTRIBUTING | docs updated to match surface | M |
| 20 | Coverage + mutation final gate | npm run test green | L |

**Total Steps**: 21 (Step 11 split into 11a and 11b)
**Critical Path**: Steps 5 -> 6 -> 7 -> 9 -> 11a -> 12 -> 13 -> 14 -> 15 -> 17 -> 20 (any of these slipping blocks the rest)
**Parallel Opportunities**:
- Steps 1, 2, 3, 4 can run concurrently (Level 0 fan-out)
- Step 5 can run in parallel with Steps 1–4 if registry verification is the long path
- Step 7 and Step 8 are independent within Phase 3 once Step 5 + Step 6 finish
- Step 11a (AuthStrategyService impl + spec) joins the post-Step-6 parallel band alongside Steps 7, 8, 10, 16, 18 (only needs Steps 3, 4, 5, 6)
- Step 11b (RestClient unit spec) and Step 12 (AuthRestClient) MUST run in parallel once Step 9 + Step 11a complete
- Steps 18, 19 are independent within Phase 8 (CI vs docs)

---

## Risks & Blockers Summary

### High Priority

| Risk/Blocker | Impact | Likelihood | Mitigation |
|--------------|--------|------------|------------|
| `base-decorators@1.1.0` not on npm | High (blocks all decorators) | Medium | Step 5 has explicit shim fallback under `src/base-decorators/` with own tests |
| Mutation score < 80% on first Stryker run | High (gate failure) | High | Step 20 has explicit iterate-until-pass loop; budget for 2–3 extra spec rounds |
| Docker not available in CI runner | High (e2e fails) | Low | `ubuntu-latest` provides Docker; verify in Step 18 |
| `Wrap` signature inferred wrong | High (decorator signature drift) | Medium | Step 5 verifies `index.d.ts` immediately on install; adapt Steps 7–8 |
| ts-jest + tsdown bundler-resolution conflict | Medium | Medium | Step 6 introduces `tsconfig.test.json` per skill Pattern 4 |
| Stryker v8 + jest@29 compat surprise | Medium | Low | Skill verifies the combo; Step 6 dry-runs `stryker --help` post-install |

### Medium Priority

| Risk/Blocker | Impact | Likelihood | Mitigation |
|--------------|--------|------------|------------|
| Forgetting a verb decoration in `RestClient` or `AuthRestClient` | Medium | Medium | Step 11b / Step 12 specs enumerate every verb explicitly |
| Public-surface drift from delete steps not catching all references | Medium | Low | Step 14 grep `src/` for old class names |
| jest-it-up bumps thresholds above achievable level | Medium | Medium | Inspect coverageThreshold in Step 20; adjust manually if needed |
| Config-arg index wrong for unusual verbs | Medium | Low | Step 8 spec covers every verb explicitly |
| `@DeduplicateInflight` key not constant | Medium | Low | Step 11a spec verifies single underlying call across concurrent invocations |

---

## High Complexity / Uncertainty Tasks Requiring Attention

The following steps have High uncertainty or Large complexity and may benefit from further decomposition or a preceding spike. Listed for orchestrator visibility:

- **Step 5: base-decorators install or shim** — Uncertainty: High (registry availability unverified). Recommendation: invoke as a spike; outcome decides whether shim is built.
- **Step 6: Jest+Stryker+testcontainers infra** — Complexity: Large (4 tools, 4 config files, scripts wiring). Recommendation: keep as a single step but staged subtasks; smoke-run each tool individually before declaring done.
- **Step 11 (now split into 11a + 11b)** — The original Step 11 has been split per the recommendation: Step 11a covers `AuthStrategyService` impl + spec (sdd:developer, deps 3/4/5/6), Step 11b covers `RestClient` unit spec (sdd:qa-engineer, deps 9/11a). Step 11a joins the post-Step-6 parallel band; Step 11b runs in parallel with Step 12.
- **Step 20: Coverage + mutation final gate** — Uncertainty: High (mutation outcome unknown). Recommendation: budget iterations; allow this step to spawn 2–3 sub-iterations of "identify surviving mutants -> strengthen specs -> re-run".

---

## Definition of Done (Task Level)

- [X] All implementation steps completed
- [X] All Functional Acceptance Criteria pass
- [X] All Non-Functional Acceptance Criteria pass (mutation 80%; unit < 60s; e2e < 2 min; no library mocks; no rxjs/p-retry in `src/auth/`; deterministic tests; full TypeScript types)
- [X] `npm run test` exits 0 (unit + e2e + mutation chained)
- [X] `npm run build` produces `dist/` containing the new public surface (`RestClient`, `AuthRestClient`, `AuthStrategyService`, `AuthRestModule`, `AuthConfig`, `AuthStrategy`, `ResilanceConfig`, `ResilencePresets`, `resiliencePolicyPresets`, `@ExecuteWithPolicy`, `@Authenticate`, `@DeduplicateInflight`)
- [ ] `verify.yaml` runs in CI on push/PR to `master` and is green
- [X] CONTRIBUTING.md and README.md updated to match implemented surface
- [X] No references to `HttpClient`, `AuthenticatedHttpService`, the old `AuthConfig` shape, `withHttpRetry`, or local `isRetryableError` helpers remain in `src/`
- [ ] Code reviewed and merged
