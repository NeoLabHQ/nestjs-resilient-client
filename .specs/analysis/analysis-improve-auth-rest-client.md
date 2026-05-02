---
title: Codebase Impact Analysis - Improve AuthRestClient
task_file: .specs/tasks/draft/improve-auth-rest-client.feature.md
scratchpad: .specs/scratchpad/5c3a8633.md, .specs/scratchpad/adfaaa29.md
created: 2026-04-30
status: complete
---

# Codebase Impact Analysis: Improve AuthRestClient

## Summary

- **Files to Modify**: 14 files
- **Files to Rename**: 2 files (auth-strategy.service.ts -> auth-processor.ts; auth-strategy.service.spec.ts -> auth-processor.spec.ts)
- **Files to Delete**: 0 files (originals are renamed/replaced in place)
- **Test Files Affected**: 4 files
- **Risk Level**: Medium (pre-1.0 breaking change; resilience pipeline untouched)

---

## Files to be Modified/Created

### Primary Changes

```
src/
├── index.ts                               # UPDATE: swap AuthStrategyService -> AuthProcessor export,
│                                          #   remove AuthConfig from type exports
└── auth/
    ├── auth.config.ts                     # UPDATE: delete AuthConfig interface; extend AuthStrategy
    │                                      #   interface with authenticate(client) + session-invalidation method
    ├── auth-strategy.service.ts           # RENAME -> auth-processor.ts (class rename to AuthProcessor,
    │                                      #   drop authResult field, delegate all methods to injected strategy)
    ├── auth-rest.client.ts                # UPDATE: import AuthProcessor instead of AuthStrategyService,
    │                                      #   update field/constructor types
    ├── auth-rest.module.ts                # UPDATE: remove AuthConfig import, update AuthRestModuleOptions
    │                                      #   to accept strategy class, rewire AuthProcessor provider to
    │                                      #   use class-based DI injection
    └── __tests__/
        ├── auth-strategy.service.spec.ts  # RENAME -> auth-processor.spec.ts (full rewrite for
        │                                  #   AuthProcessor: no authConfig stub, strategy IS the class)
        ├── auth-rest.client.spec.ts       # UPDATE: import path/type for AuthProcessor (minor)
        └── auth-rest.module.spec.ts       # UPDATE: full rewrite of bootstrap() factory signature,
                                           #   remove AuthConfig stub, use class-based AuthStrategy stub
```

### Test Changes

```
tests/
├── auth-rest-client.e2e.spec.ts           # UPDATE: remove CountingAuthConfig/AuthStrategyService,
│                                          #   rewrite buildSut() using AuthProcessor + class strategy
└── rest-client.e2e.spec.ts               # UPDATE: add static-token RestModule.forRootAsync example test
                                           #   (or create new static-token.e2e.spec.ts)
```

### Client-Layer JSDoc Updates

```
src/
├── client/
│   ├── rest.client.ts                     # UPDATE: add @example JSDoc to RestClient class and all
│   │                                      #   public methods (request, get, delete, head, post, put,
│   │                                      #   patch, postForm, putForm, patchForm, axiosRef getter)
│   ├── hookable-http.service.ts           # UPDATE: add @example JSDoc to HookableHttpService class,
│   │                                      #   dispatch method, and callUnderlying method
│   ├── rest.module.ts                     # UPDATE: add @example JSDoc to RestModule.forRootAsync,
│   │                                      #   forHttpService, and RestModuleOptions type
│   └── resilance.config.ts               # UPDATE: add @example JSDoc to ResilanceConfig,
│                                          #   RetryConfig, CircuitBreakerConfig, BulkheadConfig,
│                                          #   FallbackConfig, and TimeoutConfig interfaces
└── resilence.policy.ts                   # UPDATE: add @example JSDoc to ResilencePresets export
                                           #   and each named preset constant (CONSERVATIVE,
                                           #   RESTFULL, LOW_QUALITY)
```

### Documentation Updates

```
README.md                                  # UPDATE: replace AuthConfig pattern in all examples,
                                           #   rename AuthStrategyService -> AuthProcessor in API Reference,
                                           #   add static-token example using RestModule.forRootAsync,
                                           #   add guidance note in "Authenticated client" section,
                                           #   add JSDoc @example to every exported class/method
```

---

## Useful Resources for Implementation

### Pattern References

```
src/
├── auth/
│   └── auth-strategy.service.ts           # Current AuthStrategyService: single-flight pattern via
│                                          #   @DeduplicateInflight — preserve this in AuthProcessor
├── deduplicate-inflight.decorator.ts      # @DeduplicateInflight decorator — unchanged, still used
│                                          #   by AuthProcessor.performAuthenticate
└── client/
    └── rest.module.ts                     # forRootAsync and forHttpService patterns for DynamicModule
                                           #   construction — reference for AuthRestModule rewrite
```

---

## Key Interfaces & Contracts

### Interfaces to Rewrite

| Location | Name | Current Shape | Required Change |
|----------|------|---------------|-----------------|
| `src/auth/auth.config.ts` | `AuthStrategy` | `{ isAuthenticated(): bool; extendRequest(config): config }` | Add `authenticate(client: RestClient): Promise<void>` and a session-invalidation method (e.g. `invalidate(): void`) |
| `src/auth/auth.config.ts` | `AuthConfig` | `{ authenticate(client): Promise<AuthStrategy> }` | **DELETE** — entire interface removed |

### Classes to Rename / Refactor

| Location | Current Name | New Name | Change Required |
|----------|-------------|----------|-----------------|
| `src/auth/auth-strategy.service.ts` | `AuthStrategyService` | `AuthProcessor` | Rename class; rename file to `auth-processor.ts`; drop `authResult: AuthStrategy\|null` field; change constructor from `(authConfig: AuthConfig, client: unknown)` to `(strategy: AuthStrategy, client: RestClient)`; rewrite all methods to delegate to injected strategy |
| `src/auth/__tests__/auth-strategy.service.spec.ts` | — | `auth-processor.spec.ts` | Full test rewrite matching new AuthProcessor semantics |

### Methods to Modify (AuthProcessor replacing AuthStrategyService)

| Location | Method | Current Behavior | New Behavior |
|----------|--------|-----------------|--------------|
| `src/auth/auth-strategy.service.ts:78` | `isAuthenticated()` | Returns `authResult?.isAuthenticated() ?? false` | Returns `strategy.isAuthenticated()` directly |
| `src/auth/auth-strategy.service.ts:92` | `authenticateIfNeeded()` | Checks `isAuthenticated()`, calls `performAuthenticate()` | Unchanged guard logic |
| `src/auth/auth-strategy.service.ts:105` | `extendRequest()` | Guards on `authResult === null`, delegates to `authResult.extendRequest()` | Delegates directly to `strategy.extendRequest()` |
| `src/auth/auth-strategy.service.ts:118` | `clearAuth()` | Sets `authResult = null` | Calls `strategy.<session-invalidation-method>()` (name TBD — see Risk Assessment; decide before implementing AuthProcessor) |
| `src/auth/auth-strategy.service.ts:134` | `performAuthenticate()` | `this.authResult = await authConfig.authenticate(client)` (stores returned strategy) | `await strategy.authenticate(client)` (void return — strategy manages its own state) |

### Types to Update (AuthRestModuleOptions and AuthRestClient fields)

| Location | Name | Fields Affected | Change Required |
|----------|------|-----------------|-----------------|
| `src/auth/auth-rest.module.ts:28` | `AuthRestModuleOptions` | `authConfig: AuthConfig` | Replace with strategy class registration (e.g. `strategy: Type<AuthStrategy>` or a DI token approach) |
| `src/auth/auth-rest.client.ts:44` | `AuthRestClient` | `readonly authStrategy: AuthStrategyService` | Update field type from `AuthStrategyService` to `AuthProcessor` |
| `src/auth/auth-rest.client.ts:46` | `AuthRestClient` | constructor parameter `authStrategy: AuthStrategyService` | Update parameter type from `AuthStrategyService` to `AuthProcessor` |

### Files Requiring Import Path Updates

| File | Current Import | New Import |
|------|---------------|-----------|
| `src/auth/auth-rest.client.ts:5` | `import type { AuthStrategyService } from './auth-strategy.service'` | `import type { AuthProcessor } from './auth-processor'` |
| `src/auth/auth-rest.module.ts:9` | `import { AuthStrategyService } from './auth-strategy.service'` | `import { AuthProcessor } from './auth-processor'` |
| `src/auth/auth-rest.module.ts:10` | `import type { AuthConfig } from './auth.config'` | Remove — AuthConfig deleted |
| `src/index.ts:6` | `export { AuthStrategyService } from './auth/auth-strategy.service'` | `export { AuthProcessor } from './auth/auth-processor'` |
| `src/index.ts:12` | `export type { AuthConfig, AuthStrategy } from './auth/auth.config'` | `export type { AuthStrategy } from './auth/auth.config'` |

---

## Integration Points

Files that interact with affected code and will need updates:

| File | Relationship | Impact | Action Needed |
|------|--------------|--------|---------------|
| `src/auth/auth-rest.client.ts` | Imports and constructs with `AuthStrategyService` | High | Update import, field type, constructor param type |
| `src/auth/auth-rest.module.ts` | Imports `AuthConfig`, `AuthStrategyService`; wires both in providers | High | Full provider section rewrite |
| `src/index.ts` | Re-exports `AuthStrategyService` and `AuthConfig` | High | Swap exports |
| `src/auth/__tests__/auth-strategy.service.spec.ts` | Tests `AuthStrategyService` with `AuthConfig` stubs | High | Full file rewrite (rename to auth-processor.spec.ts) |
| `src/auth/__tests__/auth-rest.module.spec.ts` | Uses `AuthConfig` stub in bootstrap factory | High | Rewrite bootstrap factory and stubs |
| `src/auth/__tests__/auth-rest.client.spec.ts:4` | `import type { AuthStrategyService }` | Low | Update import only — structural stub shape is unchanged |
| `tests/auth-rest-client.e2e.spec.ts` | Uses `AuthStrategyService`, `AuthConfig`, `CountingAuthConfig` pattern | High | Rewrite `buildSut()` and auth stubs |
| `README.md` | Documents `AuthConfig`, `AuthStrategyService`, `AuthRestModuleOptions.authConfig` | High | Multiple sections rewritten + new static-token example |

---

## Similar Implementations

### Single-Flight Pattern (preserve in AuthProcessor)

- **Location**: `src/auth/auth-strategy.service.ts:133`
- **Why relevant**: The `@DeduplicateInflight(() => AUTHENTICATE_DEDUP_KEY)` on `performAuthenticate` is the single-flight mechanism. It must be preserved unchanged in AuthProcessor. The `inflightMap: Map<string, Promise<unknown>>` public field requirement also carries over.
- **Key files**:
  - `src/deduplicate-inflight.decorator.ts` — decorator implementation (not modified)
  - `src/auth/auth-strategy.service.ts:44-46` — inflightMap field pattern to copy

### DynamicModule forRootAsync Pattern

- **Location**: `src/client/rest.module.ts`
- **Why relevant**: `RestModule.forHttpService()` and `RestModule.forRootAsync()` are reference implementations of the NestJS dynamic-module provider-injection pattern. AuthRestModule's updated `forRootAsync` should follow the same structure when wiring the class-based strategy provider.
- **Key files**:
  - `src/client/rest.module.ts:100-129` — `forHttpService` pattern

---

## Test Coverage

### Existing Tests to Update

| Test File | Tests Affected | Update Required |
|-----------|----------------|-----------------|
| `src/auth/__tests__/auth-strategy.service.spec.ts` | All (12 tests across 4 describe blocks) | Full rewrite: rename file to auth-processor.spec.ts, replace AuthConfig stub with class-based AuthStrategy stub, test AuthProcessor delegation semantics (no authResult state) |
| `src/auth/__tests__/auth-rest.module.spec.ts` | `bootstrap()` helper + all 7 tests | Rewrite `createAuthConfigStub()` to class-based stub, update `bootstrap()` factory to new options shape |
| `src/auth/__tests__/auth-rest.client.spec.ts` | Import line only (line 4) | Update import: `AuthStrategyService` -> `AuthProcessor` from new path |
| `tests/auth-rest-client.e2e.spec.ts` | `buildSut()`, `CountingAuthConfig` class (lines 57-85) | Delete `CountingAuthConfig implements AuthConfig`, replace with `CountingAuthStrategy implements AuthStrategy`; rewrite `buildSut()` without AuthStrategyService constructor |

### New Tests Needed

| Test Type | Location | Coverage Target |
|-----------|----------|-----------------|
| Unit | `src/auth/__tests__/auth-processor.spec.ts` (rename of existing) | AuthProcessor constructor with injected AuthStrategy class; delegation to strategy.isAuthenticated/extendRequest/authenticate; single-flight via @DeduplicateInflight |
| E2E | `tests/rest-client.e2e.spec.ts` or new `tests/static-token.e2e.spec.ts` | Static-token RestModule.forRootAsync example: axios.headers.Authorization forwarded on every outbound request |
| E2E | `tests/auth-rest-client.e2e.spec.ts` | Dynamic auth flow with class-based AuthStrategy (replace CountingAuthConfig with CountingAuthStrategy) |

---

## Risk Assessment

### High Risk Areas

| Area | Risk | Mitigation |
|------|------|------------|
| AuthRestModule provider wiring | Class-based strategy DI requires different NestJS provider registration pattern (Type<T> vs instance); incorrect wiring silently breaks DI container | Write the module spec bootstrap test first; verify strategy class is instantiated by DI container with access to other providers |
| AuthStrategy session-invalidation method | Task says "session-invalidation method" but does not name it; AuthProcessor.clearAuth() must delegate to it | Decide method name upfront (e.g. `invalidate(): void`) and add it to the AuthStrategy interface before implementing AuthProcessor |
| Single-flight semantics after removing authResult | With authResult gone, the single-flight guard in authenticateIfNeeded() relies on isAuthenticated() from the strategy; two concurrent callers could both pass the guard if isAuthenticated() returns false | Verify @DeduplicateInflight on performAuthenticate is sufficient (it is — the decorator gates the underlying call regardless of the guard) |
| jest-it-up coverage ratchet | Rewriting `auth-strategy.service.spec.ts` into `auth-processor.spec.ts` can drop branch/line/statement coverage below the ratcheted floor recorded by jest-it-up, causing `npm run test:unit` posttest to fail | Run `npm run test:unit --coverage` after every spec rewrite; confirm the jest-it-up floor is not regressed before merging |
| Stryker mutation score regression | Refactoring AuthProcessor changes the mutation surface; the existing Stryker baseline may no longer align, causing `npm run test:mutation` to regress | Run `npm run test:mutation` against the refactored AuthProcessor before merging; update the Stryker baseline only if the structural simplification intentionally reduces the killable-mutation count |

---

## Recommended Exploration

Before implementation, developer should read:

1. `src/auth/auth-strategy.service.ts` — Understand the current authResult state machine and single-flight pattern before deciding how AuthProcessor delegates without it
2. `src/auth/auth-rest.module.ts:143-173` — Current provider registration order; understand what changes when AuthProcessor replaces AuthStrategyService and AuthConfig is gone
3. `src/deduplicate-inflight.decorator.ts` — Understand the inflightMap contract required by @DeduplicateInflight so AuthProcessor correctly exposes the public inflightMap field
4. `src/auth/__tests__/auth-rest.module.spec.ts:110-138` — The bootstrap() helper shows the existing module integration test pattern; this is the first test to rewrite

---

## Verification Summary

| Check | Status | Notes |
|-------|--------|-------|
| All affected files identified | OK | 14 src files + 4 test files + README (includes 5 client-layer JSDoc files) |
| Integration points mapped | OK | All AuthConfig/AuthStrategyService references traced to exact file:line |
| Similar patterns found | OK | Single-flight pattern in auth-strategy.service.ts; DynamicModule pattern in rest.module.ts |
| Test coverage analyzed | OK | 4 test files need updates; 1-2 new test cases needed |
| Risks assessed | OK | 5 risk areas documented (added jest-it-up and Stryker regression) |

Limitations/Caveats:
- The exact name of the session-invalidation method on AuthStrategy interface is not defined in the task spec; implementation must decide (likely `invalidate(): void` or `clearSession(): void`). The method table consistently uses `<session-invalidation-method>()` as a placeholder until the name is settled.
- The exact NestJS provider registration pattern for the class-based strategy (Type<AuthStrategy> token vs STRATEGY symbol token) must be decided during implementation.
- JSDoc @example audit spans ALL exported classes and public methods across the entire repository (not just auth files) — scope explicitly includes HookableHttpService, RestClient, RestModule, ResilanceConfig types, and ResilencePresets in the client layer.
