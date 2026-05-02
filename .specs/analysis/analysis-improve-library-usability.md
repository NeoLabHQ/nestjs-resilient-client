---
title: Codebase Impact Analysis - Improve library usability
task_file: .specs/tasks/draft/improve-library-usability.feature.md
scratchpad: .specs/scratchpad/875a3ebd.md
created: 2026-05-01
status: complete
---

# Codebase Impact Analysis: Improve Library Usability

## Summary

- **Files to Modify**: 8 source files
- **Files to Create**: 5 new files (rxjs-pipeline.ts + 4 e2e tests)
- **Files to Delete**: 0
- **Test Files Affected**: 6 unit test files, 5 e2e test files
- **Risk Level**: High (breaking API changes on AuthRestModuleOptions + class rename)

---

## Files to be Modified/Created

### Primary Changes

```
src/
├── client/
│   ├── hookable-http.service.ts        # MODIFY: rename abstract class to BaseHttpService;
│   │                                   #   add new concrete HookableHttpService extends BaseHttpService
│   │                                   #   with HooksConfig constructor param and dispatch override;
│   │                                   #   apply RxJS pipeline in callUnderlying Observable branch
│   ├── resilance.config.ts             # MODIFY: add DeduplicationConfig, RateLimiterConfig,
│   │                                   #   ThrottlingConfig interfaces; add optional fields
│   │                                   #   deduplication?, rateLimiter?, throttling? to ResilanceConfig
│   ├── rest.client.ts                  # MODIFY: add hooks?: HooksConfig as third constructor param;
│   │                                   #   call super(httpService, hooks); extend new HookableHttpService
│   ├── rest.module.ts                  # MODIFY: populate @Module({}) decorator for zero-config import;
│   │                                   #   add hooks? to RestModuleOptions + RestFromHttpServiceOptions;
│   │                                   #   add timeout conflict resolution logic in both factory methods
│   ├── rxjs-pipeline.ts                # CREATE: RxJS operator builders — deduplicationOperator,
│   │                                   #   rateLimiterOperator, throttlingOperator; parallel to
│   │                                   #   resailencePolicyBuilder.ts
│   └── __tests__/
│       ├── hookable-http.service.spec.ts  # MODIFY: update ConcreteHookable to extend BaseHttpService;
│       │                                   #   add HookableHttpService hooks describe block (AC-8,9,10)
│       ├── rest.client.spec.ts            # MODIFY: add hooks constructor forwarding test (AC-11)
│       ├── rest.module.spec.ts            # MODIFY: add zero-config, timeout-precedence,
│       │                                   #   hooks-wiring tests (AC-1, AC-2, AC-13, AC-15)
│       └── rxjs-pipeline.spec.ts          # CREATE: unit tests for RxJS operator builders
├── auth/
│   ├── auth-rest.client.ts             # MODIFY: add hooks?: HooksConfig as third constructor param;
│   │                                   #   call super(restClient, hooks)
│   ├── auth-rest.module.ts             # MODIFY: BREAKING — rewrite AuthRestModuleOptions to extend
│   │                                   #   RestModuleOptions (drop httpService, gain axios + hooks);
│   │                                   #   use internal HttpModule.registerAsync(opts.axios ?? {});
│   │                                   #   pass opts.hooks to AuthRestClient constructor
│   └── __tests__/
│       ├── auth-rest.client.spec.ts    # MODIFY: add hooks constructor forwarding test (AC-12)
│       └── auth-rest.module.spec.ts    # MODIFY: rewrite bootstrap for new options shape;
│                                       #   add axios and hooks wiring tests (AC-14)
├── index.ts                            # MODIFY: export BaseHttpService; export HooksConfig type;
│                                       #   export DeduplicationConfig, RateLimiterConfig,
│                                       #   ThrottlingConfig; export AuthRestModuleOptions type
tests/
├── zero-config.e2e.spec.ts             # CREATE: imports: [RestModule] zero-config e2e (AC-15)
├── deduplication.e2e.spec.ts           # CREATE: concurrent identical GETs -> 1 upstream call (AC-3)
├── rate-limiter.e2e.spec.ts            # CREATE: token-bucket rate limiting e2e (AC-4)
├── throttling.e2e.spec.ts              # CREATE: invocation boundary rate limit e2e (AC-6)
└── rest-client.e2e.spec.ts             # MODIFY: add axios.timeout vs preset timeout case (AC-1)
README.md                               # MODIFY: rename Quick Start -> Usage; insert new Quick Start
                                        #   before Resilience Patterns; document timeout precedence,
                                        #   new RxJS policies, hook system with code examples
```

---

## Useful Resources for Implementation

### Pattern References

```
src/client/
├── resailencePolicyBuilder.ts          # Template for rxjs-pipeline.ts: builder function per config
│                                       #   field, composed and exported from one place
├── hookable-http.service.ts:251        # callUnderlying — RxJS pipeline inserts BEFORE firstValueFrom,
│                                       #   INSIDE the isObservable(result) branch at line 256
└── rest.module.ts:280                  # forRootAsync — AuthRestModule must replicate this exact pattern
                                        #   for internal HttpModule.registerAsync(opts.axios ?? {})
```

---

## Key Interfaces & Contracts

### Functions/Methods to Modify

| Location | Name | Current Signature | Change Required |
|----------|------|-------------------|-----------------|
| `src/client/hookable-http.service.ts:183` | `HookableHttpService` constructor | `(httpService: HttpServiceLike)` | Rename class to `BaseHttpService`; new `HookableHttpService` adds `hooks?: HooksConfig` param |
| `src/client/hookable-http.service.ts:251` | `callUnderlying` | `(verb, args) => Promise<AxiosResponse<T>>` | Apply rxjsPipeline operators to Observable before `firstValueFrom`; need rxjsConfig access |
| `src/client/rest.client.ts:125` | `RestClient` constructor | `(httpService: HttpService, config?: ResilanceConfig<unknown>)` | Add `hooks?: HooksConfig` as third param; call `super(httpService, hooks)` |
| `src/auth/auth-rest.client.ts:91` | `AuthRestClient` constructor | `(restClient: RestClient, authProcessor: AuthProcessor)` | Add `hooks?: HooksConfig` as third param; call `super(restClient, hooks)` |
| `src/client/rest.module.ts:198` | `RestModule.forHttpService` | factory reads `{httpService, resilience?}` | Read `hooks` from `RestFromHttpServiceOptions`; pass as `new RestClient(http, resilience, hooks)` |
| `src/client/rest.module.ts:280` | `RestModule.forRootAsync` | factory reads `{axios?, resilience?}` | Add timeout-conflict stripping; read and forward `opts.hooks` to `RestClient` constructor |
| `src/auth/auth-rest.module.ts:251` | `AuthRestModule.forRootAsync` | factory returns `{httpService, resilience?}` | BREAKING: factory returns `{axios?, resilience?, hooks?}`; internal `HttpModule.registerAsync(opts.axios)` |

### Classes/Components Affected

| Location | Name | Description | Change Required |
|----------|------|-------------|-----------------|
| `src/client/hookable-http.service.ts:175` | `HookableHttpService` (abstract) | Base template-method class | RENAME to `BaseHttpService`; keep export alias for both |
| `src/client/hookable-http.service.ts` (new) | `HookableHttpService` (concrete) | New hooks-aware subclass | CREATE: `class HookableHttpService extends BaseHttpService`, `dispatch` applies `onInvoke`/`onReturn`/`onError` |
| `src/client/rest.client.ts:95` | `RestClient` | Resilient HTTP client | Extends new `HookableHttpService`; constructor gains `hooks` param |
| `src/auth/auth-rest.client.ts:53` | `AuthRestClient` | Authenticated HTTP client | Extends new `HookableHttpService`; constructor gains `hooks` param |
| `src/client/rest.module.ts:155` | `RestModule` | NestJS dynamic module | Populate `@Module({imports:[HttpModule], providers:[RestClient], exports:[RestClient]})` |
| `src/auth/auth-rest.module.ts:182` | `AuthRestModule` | NestJS dynamic module | Rework `forRootAsync` for new options shape |

### Types/Interfaces to Update

| Location | Name | Fields Affected | Change Required |
|----------|------|-----------------|-----------------|
| `src/client/hookable-http.service.ts` | `HooksConfig` (NEW) | `onInvoke`, `onReturn`, `onError` | CREATE interface: `onInvoke?(verb, args): InvokeArgs \| Promise<InvokeArgs>`; `onReturn?(verb, args, res): AxiosResponse \| Promise<AxiosResponse>`; `onError?(verb, args, err): void \| never` |
| `src/client/resilance.config.ts:235` | `ResilanceConfig<T,S,R>` | `deduplication?`, `rateLimiter?`, `throttling?` | ADD three optional fields |
| `src/client/resilance.config.ts` | `DeduplicationConfig` (NEW) | (empty or minimal) | CREATE: `interface DeduplicationConfig {}` — key derived automatically from verb+url |
| `src/client/resilance.config.ts` | `RateLimiterConfig` (NEW) | `strategy`, `capacity`, `refillRatePerSec` | CREATE: `interface RateLimiterConfig { strategy: 'token-bucket' \| 'leaky-bucket'; capacity: number; refillRatePerSec: number }` |
| `src/client/resilance.config.ts` | `ThrottlingConfig` (NEW) | `requestsPerInterval`, `intervalMs` | CREATE: `interface ThrottlingConfig { requestsPerInterval: number; intervalMs: number }` |
| `src/client/rest.module.ts:77` | `RestModuleOptions` | `hooks?` | ADD `hooks?: HooksConfig` |
| `src/client/rest.module.ts:38` | `RestFromHttpServiceOptions` | `hooks?` | ADD `hooks?: HooksConfig` |
| `src/auth/auth-rest.module.ts:43` | `AuthRestModuleOptions` | `httpService` DROPPED; `axios?`, `hooks?` ADDED | REWRITE: `interface AuthRestModuleOptions extends RestModuleOptions` (inherits `axios?`, `resilience?`, `hooks?`; `httpService` removed — BREAKING) |

---

## Integration Points

| File | Relationship | Impact | Action Needed |
|------|--------------|--------|---------------|
| `src/index.ts` | Re-exports all public symbols | High | Export `BaseHttpService`, `HooksConfig`, new RxJS config types, `AuthRestModuleOptions` |
| `src/client/__tests__/hookable-http.service.spec.ts` | Tests abstract class via `ConcreteHookable` | High | `ConcreteHookable` must extend `BaseHttpService`; add hooks describe block |
| `src/client/__tests__/rest.module.spec.ts` | Tests `REST_MODULE_OPTIONS`, DI wiring | High | Add zero-config, timeout-precedence, hooks-wiring tests |
| `src/auth/__tests__/auth-rest.module.spec.ts` | Tests `AUTH_MODULE_OPTIONS`, DI wiring | High | Rewrite bootstrap helper; update all factory calls to new options shape |
| `tests/auth-rest-client.e2e.spec.ts` | E2e tests `AuthRestClient` | High | Update factory to new options shape (no `httpService` in factory return) |
| `src/__tests__/index.spec.ts` | Smoke tests all exports | Medium | Add `BaseHttpService`, `HooksConfig`, new types |

---

## Similar Implementations

### Pattern 1: resailencePolicyBuilder.ts — builder parallel for RxJS pipeline

- **Location**: `/workspaces/nestjs-http-client/src/client/resailencePolicyBuilder.ts`
- **Why relevant**: The new `rxjs-pipeline.ts` is the RxJS equivalent — one builder per config field, all composed in a single exported function. Follow the naming and structure exactly.
- **Key files**: `resailencePolicyBuilder.ts` for structure; `resilance.config.ts` for how types are defined

### Pattern 2: RestModule.forRootAsync — HttpModule.registerAsync pattern

- **Location**: `/workspaces/nestjs-http-client/src/client/rest.module.ts:295-310`
- **Why relevant**: `AuthRestModule.forRootAsync` must replicate this exact pattern to support `opts.axios` — `HttpModule.registerAsync({ imports: userImports, inject, useFactory: async (...args) => opts.axios ?? {} })`

### Pattern 3: dispatch override testing with DispatchOverrideHookable

- **Location**: `/workspaces/nestjs-http-client/src/client/__tests__/hookable-http.service.spec.ts:26-52`
- **Why relevant**: New `HookableHttpService` hook tests follow this pattern — subclass, inject spy hooks, call verb, assert on transformed args/response

---

## Test Coverage

### Existing Tests to Update

| Test File | Tests Affected | Update Required |
|-----------|----------------|-----------------|
| `src/client/__tests__/hookable-http.service.spec.ts` | `ConcreteHookable extends HookableHttpService` | Update to `extends BaseHttpService`; add hook tests for AC-8, AC-9, AC-10 |
| `src/client/__tests__/rest.client.spec.ts` | Constructor tests | Add hooks-forwarding test for AC-11 |
| `src/client/__tests__/rest.module.spec.ts` | Bootstrap + DI tests | Add zero-config (AC-15), timeout-precedence (AC-1, AC-2), hooks-wiring (AC-13) |
| `src/auth/__tests__/auth-rest.client.spec.ts` | Constructor tests | Add hooks-forwarding test for AC-12 |
| `src/auth/__tests__/auth-rest.module.spec.ts` | All bootstrap tests | Rewrite for new options shape; add axios + hooks tests for AC-14 |
| `src/__tests__/index.spec.ts` | Export smoke tests | Add new exports: `BaseHttpService`, `HooksConfig`, new config types |

### New Tests Needed

| Test Type | Location | Coverage Target |
|-----------|----------|-----------------|
| Unit | `src/client/__tests__/hookable-http.service.spec.ts` | onInvoke args transform (AC-8), onReturn response substitute (AC-9), onError fallback response (AC-10) |
| Unit | `src/client/__tests__/rxjs-pipeline.spec.ts` (NEW) | Deduplication operator, rate-limiter operator, throttling operator |
| E2e | `tests/zero-config.e2e.spec.ts` (NEW) | `imports: [RestModule]` yields injectable `RestClient`, CONSERVATIVE preset applies (AC-15, AC-18) |
| E2e | `tests/deduplication.e2e.spec.ts` (NEW) | 100 concurrent GETs → 1 upstream request (AC-3) |
| E2e | `tests/rate-limiter.e2e.spec.ts` (NEW) | Token-bucket: 2 immediate, then ~1/sec for 8 more (AC-4) |
| E2e | `tests/throttling.e2e.spec.ts` (NEW) | 100 requests → ≤11 upstream within 1s (AC-6) |
| E2e | `tests/rest-client.e2e.spec.ts` | Add axios.timeout = 5000 with 6000ms upstream → ECONNABORTED, no preset timeout layered (AC-1) |

---

## Risk Assessment

### High Risk Areas

| Area | Risk | Mitigation |
|------|------|------------|
| `AuthRestModuleOptions` breaking change (drop `httpService`) | All consumers using `inject: [HttpService], useFactory: (http) => ({ httpService: http })` will break | Document migration; new e2e test covers new pattern |
| Class rename `HookableHttpService` → `BaseHttpService` | Any consumer subclassing the abstract class will break at compile time | Export both names; document in README; update CLAUDE.md |
| Timeout precedence rule logic | Strip preset timeout but NOT user-explicit timeout — distinguishing requires knowing if resilience was user-supplied or defaulted | AC-1 vs AC-2 tests guard this; condition is `opts.resilience === undefined` (no user resilience) AND `opts.axios?.timeout > 0` |
| `AuthRestModule` internal restructuring | Factory must create `HttpModule.registerAsync` from `opts.axios` AND inject resulting `HttpService` into `RestModule.forHttpService` | Follow `RestModule.forRootAsync` pattern exactly |
| RxJS deduplication key stability | If key derivation is inconsistent across concurrent calls, deduplication breaks silently | Unit test with explicit key assertions; key must be `${verb}:${url ?? config.url ?? ''}` |
| Zero-config `@Module({})` uses axios defaults | No `baseURL` — consumers must pass absolute URLs | Document clearly in README Quick Start |

---

## Recommended Exploration

Before implementation, developer should read:

1. `/workspaces/nestjs-http-client/src/client/hookable-http.service.ts:251-260` — `callUnderlying` — the exact insertion point for RxJS operators (inside `isObservable(result)` branch before `firstValueFrom`)
2. `/workspaces/nestjs-http-client/src/client/rest.module.ts:295-338` — `forRootAsync` HttpModule.registerAsync pattern — replicate in `AuthRestModule`
3. `/workspaces/nestjs-http-client/src/auth/auth-rest.module.ts:264-290` — current `forRootAsync` imports/providers to understand what must change when `httpService` is dropped from options
4. `/workspaces/nestjs-http-client/.claude/skills/nestjs-http-client-architecture/SKILL.md` (Patterns 5–9) — all architectural decisions already made; do not deviate
5. `/workspaces/nestjs-http-client/src/client/__tests__/hookable-http.service.spec.ts:26-52` — `DispatchOverrideHookable` pattern — follow for new hook tests

---

## Verification Summary

| Check | Status | Notes |
|-------|--------|-------|
| All affected files identified | OK | 8 source files + 6 unit test files + 5 e2e test files + README |
| Integration points mapped | OK | index.ts, all test files, e2e bootstrap patterns |
| Similar patterns found | OK | resailencePolicyBuilder, RestModule.forRootAsync, DispatchOverrideHookable |
| Test coverage analyzed | OK | 6 unit specs updated + 1 new unit spec + 4 new e2e + 1 e2e updated |
| Risks assessed | OK | Breaking AuthRestModuleOptions, class rename, dedup keying, timeout logic |

Limitations/Caveats:
- `timeLimiter` field is explicitly excluded per user clarification — only the existing `timeout` (cockatiel TimeoutPolicy) is retained.
- The exact RxJS operator chain for token-bucket rate limiter requires design decisions on observable concurrency semantics not fully resolved in the task spec; the AC provides the external contract only.
- `AuthRestModuleOptions` breaking change: the `inject: [HttpService]` in existing consumer factory calls must be removed; consumers now only configure `axios: { baseURL, ... }` and the module owns the HttpService lifecycle.
