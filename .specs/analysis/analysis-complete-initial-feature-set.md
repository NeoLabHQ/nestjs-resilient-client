---
title: Codebase Impact Analysis - Complete initial feature set
task_file: .specs/tasks/draft/complete-initial-feature-set.feature.md
scratchpad: .specs/scratchpad/7049abc0.md
created: 2026-04-26
status: complete
---

# Codebase Impact Analysis: Complete initial feature set

## Summary

- **Files to Modify**: 8 files
- **Files to Create**: 19 files
- **Files to Delete**: 4 files
- **Test Files Affected**: 2 existing (broken), 8+ new
- **Risk Level**: High (significant refactor + test infrastructure migration vitest -> Jest + missing base-decorators dependency)

---

## Critical Pre-Implementation Findings

### Existing Bugs in Draft Code (Must Fix First)

1. `src/client/http.client.ts:16` - References `ResilencePresets.CONSERVATIVE` but the enum is defined in `src/resilence.policy.ts` and is never imported into this file.
2. `src/client/http.client.ts:4-8` - Dead imports: `isAxiosError`, `circuitBreaker`, `ExponentialBackoff`, `handleAll`, `handleWhen`, `retry`, `SamplingBreaker`, `wrap` imported but unused.
3. `src/shouldRetry.ts:24-28` - Logic is inverted. `if (isMethodInList(error, methods)) return false` means "if method IS in the allowed list, do NOT retry" — backwards. Safe methods (GET/HEAD/OPTIONS) should be retried.
4. `src/deduplicate-inflight.decorator.ts:1` - Imports `Wrap` from `'base-decorators'` which is **not installed** (absent from node_modules and not on npm).
5. `src/deduplicate-inflight.decorator.ts:2` - Imports `KeyBuilder` from `'./cache.decorator'` which **does not exist** anywhere in src/.
6. `src/deduplicate-inflight.decorator.spec.ts:1` - Imports from `'@/cache/deduplicate-inflight.decorator'` — no `@/` path alias configured.
7. `src/deduplicate-inflight.decorator.spec.ts` - Uses `jest.fn()` but project runs **vitest**. Cannot execute.
8. `tests/index.test.ts:2` - Imports `fn` from `'../src'` but `src/index.ts` exports no such function.

### Missing Dependency: `base-decorators`
The task requires `Wrap` and `OnErrorHook` from `base-decorators`. This package is **not published to npm** and is **not installed**. Must be implemented as an internal module (`src/base-decorators/`) before any dependent decorators can be built.

---

## Files to be Modified/Created

### Primary Changes

```
src/
├── client/
│   ├── http.client.ts                         # DELETE: replaced by rest.client.ts
│   ├── rest.client.ts                         # NEW: RestClient (renamed HttpClient, @ExecuteWithPolicy applied to all methods)
│   ├── execute-with-policy.decorator.ts       # NEW: @ExecuteWithPolicy decorator using Wrap from base-decorators
│   ├── resilance.config.ts                    # KEEP: type definitions unchanged
│   └── resailencePolicyBuilder.ts             # KEEP: policy builder unchanged
│   └── __tests__/
│       ├── rest.client.spec.ts                # NEW: Unit tests (mock axios only, all policy combinations)
│       └── resilience-policy-builder.spec.ts  # NEW: Policy builder combination unit tests
├── auth/
│   ├── authenticated-http.service.ts          # DELETE: replaced by auth-rest.client.ts
│   ├── auth-rest.client.ts                    # NEW: AuthRestClient (uses RestClient + @Authenticate)
│   ├── auth-strategy.service.ts               # NEW: AuthStrategyService (isAuthenticated, authenticateIfNeeded, extendRequest)
│   ├── auth-rest.module.ts                    # NEW: AuthRestModule NestJS dynamic module
│   ├── auth.config.ts                         # NEW: New AuthConfig interface (single authenticate() method)
│   ├── authenticate.decorator.ts              # NEW: @Authenticate decorator (Wrap + OnErrorHook)
│   └── __tests__/
│       ├── auth-rest.client.spec.ts           # NEW: AuthRestClient unit tests
│       └── auth-strategy.service.spec.ts      # NEW: AuthStrategyService unit tests
├── base-decorators/                           # NEW: Internal implementation (base-decorators not on npm)
│   ├── wrap.decorator.ts                      # NEW: Wrap method decorator factory
│   └── on-error-hook.decorator.ts             # NEW: OnErrorHook decorator
├── __tests__/
│   ├── should-retry.spec.ts                   # NEW: Unit tests for shouldRetry (covers bug fix)
│   └── deduplicate-inflight.decorator.spec.ts # MOVE+FIX: Move from src/ root, fix imports and test runner
├── deduplicate-inflight.decorator.ts          # MODIFY: Fix broken imports (base-decorators, cache.decorator)
├── axios.ts                                   # KEEP: getRequestRoute unchanged
├── resilence.policy.ts                        # KEEP: presets unchanged
├── shouldRetry.ts                             # MODIFY: Fix inverted isRetryableError logic (line 24)
└── index.ts                                   # MODIFY: Update all exports for renamed/new components

tests/
├── index.test.ts                              # DELETE: broken, references non-existent export
└── e2e/
    └── rest-client.e2e-spec.ts               # NEW: E2E tests using testcontainers

.github/
└── workflows/
    ├── build.yaml                             # DELETE: renamed to verify.yaml
    └── verify.yaml                            # NEW: Renamed CI with updated test commands
```

### Configuration Files

```
/
├── jest.config.ts                             # NEW: Jest unit test config with coverage thresholds
├── jest.config.e2e.ts                         # NEW: Jest e2e config with testcontainers global setup
├── stryker.config.ts                          # NEW: Stryker mutation testing (break: 80 threshold)
├── package.json                               # MODIFY: Add jest/ts-jest/stryker/testcontainers deps, remove vitest, new scripts
├── CONTRIBUTING.md                            # MODIFY: Document test:unit, test:e2e, test:mutation commands
└── README.md                                  # MODIFY: Quick start, usage examples, API reference
```

---

## Key Interfaces & Contracts

### New Interfaces to Create

| Location | Name | Fields | Purpose |
|----------|------|--------|---------|
| `src/auth/auth.config.ts` | `AuthConfig` | `authenticate(client: RestClient): Promise<AuthStrategy>` | Replaces old multi-field config |
| `src/auth/auth.config.ts` | `AuthStrategy` | `extendRequest(c: AxiosRequestConfig): AxiosRequestConfig; isAuthenticated(): boolean` | Auth strategy object returned by authenticate() |

### Functions/Methods to Modify

| Location | Name | Current Signature | Change Required |
|----------|------|-------------------|-----------------|
| `src/shouldRetry.ts:17` | `isRetryableError` | `if (isMethodInList(error, methods)) return false` | Fix to `if (!isMethodInList(error, methods)) return false` |
| `src/client/http.client.ts:70` | `executeRequest` | `private async executeRequest(factory)` | Extract to `@ExecuteWithPolicy` decorator; remove from class |
| `src/auth/authenticated-http.service.ts:182` | `executeRequest` | `private async executeRequest(factory)` | Remove entirely; replaced by @Authenticate + RestClient policy |
| `src/auth/authenticated-http.service.ts:233` | `withHttpRetry` | `private async withHttpRetry(fn)` | Remove; RestClient handles retries via policy |
| `src/auth/authenticated-http.service.ts:249` | `withAuthRetry` | `private async withAuthRetry(fn)` | Remove; replaced by OnErrorHook in @Authenticate |

### Classes/Components Affected

| Location | Name | Description | Change Required |
|----------|------|-------------|-----------------|
| `src/client/http.client.ts:12` | `HttpClient` | Core HTTP wrapper | Rename to `RestClient`, move to `rest.client.ts`, apply `@ExecuteWithPolicy` |
| `src/auth/authenticated-http.service.ts:139` | `AuthenticatedHttpService` | Auth HTTP wrapper | Rename to `AuthRestClient`, refactor to accept `RestClient` + `AuthStrategyService`, apply `@Authenticate` |
| `src/auth/authenticated-http.service.ts:9` | `AuthConfig` | Auth config interface | Complete replacement: old 4-field interface → single `authenticate()` method |

### Decorator Contracts

| Decorator | Location | Required Class Fields | Dependencies |
|-----------|----------|-----------------------|--------------|
| `@ExecuteWithPolicy` | `src/client/execute-with-policy.decorator.ts` | `policy: IPolicy<IDefaultPolicyContext, any>` | `Wrap` from base-decorators, `firstValueFrom` from rxjs |
| `@Authenticate` | `src/auth/authenticate.decorator.ts` | `authStrategy: AuthStrategyService` | `Wrap` + `OnErrorHook` from base-decorators |
| `@DeduplicateInflight` | `src/deduplicate-inflight.decorator.ts` | `inflightMap: Map<string, Promise<unknown>>` | `Wrap` from base-decorators |

---

## Integration Points

| File | Relationship | Impact | Action Needed |
|------|--------------|--------|---------------|
| `src/resilence.policy.ts` | Imports `isRetryableError` from `shouldRetry.ts` | Medium | Verify presets still correct after bug fix |
| `src/client/resailencePolicyBuilder.ts` | Used by RestClient constructor | Low | No change needed |
| `src/axios.ts` | `getRequestRoute` used in auth service logging | Low | May still be used by AuthRestClient for error logging |
| `node_modules/nestjs-log-decorator` | `Loggable` interface on HttpClient | Low | RestClient must still implement `Loggable` |
| `node_modules/cockatiel` | All policy types used by policy builder | Medium | RestClient still uses these via policy |
| `node_modules/@nestjs/axios` | `HttpService` used by RestClient | Medium | RestClient keeps HttpService injection |
| `node_modules/rxjs` | `firstValueFrom`, `Observable` used in executeRequest | Medium | Must remain in `@ExecuteWithPolicy` decorator |
| `node_modules/p-retry` | Used by AuthenticatedHttpService | Low | Remove after AuthRestClient refactor |

---

## Similar Implementations

### Pattern 1: executeRequest wrapping Observable with policy

- **Location**: `src/client/http.client.ts:70-74`
- **Why relevant**: The exact pattern `@ExecuteWithPolicy` must replicate
- **Key files**:
  - `src/client/http.client.ts` — `policy.execute(async (ctx) => await firstValueFrom(requestFactory(ctx)))` is the core logic

### Pattern 2: DeduplicateInflight using Wrap from base-decorators

- **Location**: `src/deduplicate-inflight.decorator.ts:29-49`
- **Why relevant**: Shows the `Wrap` call signature and how the decorated class's `inflightMap` property is accessed via `context.target`
- **Key files**:
  - `src/deduplicate-inflight.decorator.ts` — `Wrap<ClassShape, TArgs, ReturnType>((method, context) => async (...args) => {...}, EXCLUSION_KEY)`

### Pattern 3: AuthenticatedHttpService single-flight authenticate

- **Location**: `src/auth/authenticated-http.service.ts:197-211`
- **Why relevant**: Shows the `authenticationPromise` single-flight pattern that `@DeduplicateInflight` will replace in AuthStrategyService
- **Key files**:
  - `src/auth/authenticated-http.service.ts` — `if (this.authenticationPromise) return this.authenticationPromise`

---

## Test Coverage

### Existing Tests to Fix/Delete

| Test File | Current State | Action |
|-----------|---------------|--------|
| `tests/index.test.ts` | Imports non-existent `fn` export; uses vitest | DELETE and replace with e2e tests |
| `src/deduplicate-inflight.decorator.spec.ts` | Wrong import path (`@/cache/...`), uses `jest.fn()` with vitest runner | MOVE to `src/__tests__/`, fix imports, update for chosen test runner |

### New Tests Needed

| Test Type | Location | Coverage Target |
|-----------|----------|-----------------|
| Unit | `src/client/__tests__/rest.client.spec.ts` | RestClient with retry, circuitBreaker, bulkhead, fallback — mock axios only |
| Unit | `src/client/__tests__/resilience-policy-builder.spec.ts` | All policy type combinations |
| Unit | `src/auth/__tests__/auth-strategy.service.spec.ts` | isAuthenticated, authenticateIfNeeded, extendRequest, deduplication behavior |
| Unit | `src/auth/__tests__/auth-rest.client.spec.ts` | Auth flow, 401 triggers re-auth, all HTTP methods |
| Unit | `src/__tests__/should-retry.spec.ts` | All code paths including the inverted logic fix |
| Unit | `src/__tests__/deduplicate-inflight.decorator.spec.ts` | Existing tests migrated + fixed |
| E2E | `tests/e2e/rest-client.e2e-spec.ts` | Real HTTP to testcontainer service |
| Mutation | Stryker covers `src/**/*.ts` | 80% mutation score threshold |

---

## npm Scripts to Add (package.json)

```json
"test:unit": "jest --config jest.config.ts --coverage",
"test:e2e": "jest --config jest.config.e2e.ts",
"test:mutation": "stryker run",
"test": "npm run test:unit && npm run test:e2e && npm run test:mutation"
```

---

## Risk Assessment

### High Risk Areas

| Area | Risk | Mitigation |
|------|------|------------|
| `base-decorators` not on npm | `@ExecuteWithPolicy`, `@Authenticate`, `@DeduplicateInflight` all depend on `Wrap`/`OnErrorHook` — cannot install | Create internal `src/base-decorators/` module first; infer API from `deduplicate-inflight.decorator.ts` usage |
| Vitest → Jest migration | All test config, scripts, and type checking reference vitest | Systematically remove vitest, install jest + ts-jest; update tsconfig types if needed |
| `isRetryableError` logic inversion | Bug causes retries to SKIP safe methods and retry unsafe ones — opposite of intended behavior | Fix `src/shouldRetry.ts:24`: `if (isMethodInList(...))` → `if (!isMethodInList(...))` |
| AuthConfig interface breaking change | New shape is completely different from old — consumer migration required | Document clearly in README migration section |
| `@ExecuteWithPolicy` Observable + signal forwarding | Must preserve signal forwarding for cancellation (only `request()` method did this in original) | Ensure decorator passes `ctx.signal` to axios for the `request()` method path |

---

## Verification Summary

| Check | Status | Notes |
|-------|--------|-------|
| All affected files identified | ✅ | 8 modify, 19 create, 4 delete |
| Integration points mapped | ✅ | 8 integration points documented |
| Similar patterns found | ✅ | 3 reference patterns from existing code |
| Test coverage analyzed | ✅ | 2 broken existing, 8 new required |
| Risks assessed | ✅ | 5 high-risk areas with mitigations |
| Existing bugs catalogued | ✅ | 8 bugs in draft code with file:line references |

**Limitations/Caveats**: The `base-decorators` package API (specifically `Wrap` and `OnErrorHook`) must be inferred from the single usage example in `src/deduplicate-inflight.decorator.ts`. The `Wrap` generic signature appears to be `Wrap<ClassShape, TArgs, ReturnType>(wrapperFn, exclusionKey?)`. This must be validated when implementing the internal module.
