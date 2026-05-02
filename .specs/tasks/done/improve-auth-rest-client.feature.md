---
title: Improve AuthRestClient
---

## Initial User Prompt

refactor Auth module

### Context

AuthModule currently expect to receive inline AuthStratgy object as response from authenticate function in AuthConfig. This violates NestJS class based DI pattern. Rewrite it using AuthStrategy as a class pattern.

Important: library not yet released, breaking changes are allowed.

### Requirements

- Remove AuthConfig interface.
- Rename AuthStrategyService to AuthProcessor.
- Change AuthModule. It should now receive class that implements AuthStrategy interface. This class should be injected to AuthProcessor. Then AuthProcessor should be injected to AuthRestClient.
- AuthStrategy interface now should include additional method: `authenticate(client: RestClient): Promise<void>`.
- AuthProcessor should provide same functionality like now, but instead of holding authResult state, it should just call AuthStrategy methods directly.
- update readme with new API and usage + add example of static auth with RestClient:
```ts
@Module({
  imports: [
    RestModule.forRootAsync({
      useFactory: (config: ConfigService) => ({
        axios: {
          baseURL: 'https://api.example.com',
          headers: {
            'Authorization': `Bearer ${config.get('API_TOKEN')}`,
          },
        },
      }),
    }),
  ],
  exports: [RestClient],
})
```
Add test that this example actually works. 

Then add note in `Authenticated client` section, that for static API tokens, you can use `RestClient` directly, but if you need some dynamic authentication, the `AuthRestModule` simplify creation of it.

#### Additional changes

- Add jsdocs usage examples for each class and method in the repository.

#### Testing

- Add unit tests for new or update functionality.
- Add e2e tests for new or update functionality.
- Iterate till all tests pass.

## Description

> **Required Skill**: You MUST use and analyse `nestjs-http-client-architecture` skill before doing any modification to task file or starting implementation of it!
>
> Skill location: `.claude/skills/nestjs-http-client-architecture/SKILL.md`

The current `AuthRestModule` API requires consumers to supply an `AuthConfig` factory whose `authenticate(client)` callback returns an inline `AuthStrategy` literal. This shape fights NestJS conventions: the strategy cannot use class-based dependency injection (no `ConfigService`, no logger, no secrets vault), cannot be tested in isolation, and forces `AuthStrategyService` to cache the returned literal in a local `authResult` field that mirrors lifecycle data the strategy already owns. Library consumers who only need a static API token are also poorly served — they reach for the heavy `AuthRestModule` stack when `RestModule` with axios `headers.Authorization` would do the job.

This task refactors the auth layer to a class-based, idiomatic NestJS shape. `AuthConfig` is deleted. `AuthStrategy` becomes an interface implemented by a consumer-supplied class, registered with `AuthRestModule.forRootAsync`, and instantiated by the NestJS DI container with full access to the surrounding provider graph. The interface gains an `authenticate(client: RestClient): Promise<void>` method so the strategy itself owns the handshake; `AuthStrategyService` is renamed to `AuthProcessor`, drops its cached `authResult`, and simply delegates to the injected strategy while preserving the existing single-flight coalescing and 401-recovery contracts. The README is updated to cover both paths: a runnable static-token example via `RestModule` (with a test that asserts the header is forwarded), plus a guidance note in the "Authenticated client" section steering readers toward the right module for their use case. Every exported class and public method in the repository receives a JSDoc usage example.

This is a pre-1.0 cleanup — breaking changes are explicit and intentional. No backward-compatibility shim is added. Functional invariants (single-flight authentication, 401 → clear → re-auth → replay-once, cancellation forwarding) are preserved bit-for-bit; the resilience pipeline and `RestClient` transport are not touched.

**Scope**:

- **Included**:
  - Delete the `AuthConfig` interface and all its references.
  - Add `authenticate(client: RestClient): Promise<void>` and a session-invalidation method to the `AuthStrategy` interface.
  - Rename `AuthStrategyService` → `AuthProcessor`; remove the `authResult` field and the state it implies.
  - Update `AuthRestModule.forRootAsync` to accept a class implementing `AuthStrategy`, register it as a provider, and inject it into `AuthProcessor`.
  - Update `AuthRestClient` constructor and per-request lifecycle to consume the renamed `AuthProcessor`.
  - Add a static-token usage example to the README using `RestModule.forRootAsync` with `axios.headers`.
  - Add a guidance note in the "Authenticated client" section explaining when to use `RestModule` (static credentials) versus `AuthRestModule` (dynamic credentials).
  - Add JSDoc `@example` blocks on every exported class and every public method in the repository.
  - Add unit tests for the renamed/refactored components.
  - Add e2e tests covering both the new dynamic-auth class flow and the static-token example.
  - Iterate until `npm run lint`, `npm run typecheck`, `npm run test:unit`, and `npm run test:e2e` all pass.

- **Excluded**:
  - Changes to `RestClient`, `HookableHttpService`, or any cockatiel resilience builder/preset.
  - Built-in `AuthStrategy` implementations (Bearer, Basic, OAuth2). Future work.
  - Multiple-named-strategy support (one strategy per app for this task).
  - Backward-compatibility shims, deprecation warnings, or migration codemods (pre-1.0).
  - Telemetry / observability hooks on auth events.
  - Changes to retry semantics, circuit-breaker behaviour, or any preset.

**User Scenarios**:

1. **Primary Flow (Dynamic auth)**: A consumer defines an `AuthStrategy` class with full DI access, registers it via `AuthRestModule.forRootAsync`, injects `AuthRestClient`, and makes resilient authenticated requests; the strategy class is instantiated once by NestJS and reused across calls.
2. **Alternative Flow (Static API token)**: A consumer with a static token registers `RestModule.forRootAsync` with `axios.headers.Authorization`, injects `RestClient` directly, and gets the header on every outgoing request — no auth module, no strategy class.
3. **Error Handling**: A 401 response triggers session invalidation, a fresh `strategy.authenticate(client)` call (single-flight across concurrent callers), and exactly one replay of the original request with the refreshed credentials; any further failure propagates.

---

## Acceptance Criteria

### Functional Requirements

- [X] **AuthConfig removed**: The `AuthConfig` interface no longer exists in the public or internal API surface.
  - Given: any consumer of the library
  - When: they search the codebase or generated type definitions for `AuthConfig`
  - Then: no `AuthConfig` interface, type alias, or import exists anywhere in `src/`

- [X] **AuthStrategy is a class injectable**: Consumer-supplied strategies are NestJS class providers.
  - Given: a consumer-supplied class implementing `AuthStrategy` registered with `AuthRestModule.forRootAsync`
  - When: the NestJS application boots
  - Then: the class is instantiated by the DI container with access to all other registered providers, and the resolved instance is the one used by `AuthProcessor`

- [X] **AuthStrategy.authenticate(client) declared**: The interface owns its own handshake method.
  - Given: the `AuthStrategy` interface
  - When: a consumer inspects its declaration
  - Then: it includes `authenticate(client: RestClient): Promise<void>` alongside `isAuthenticated()` and `extendRequest(config)`

- [X] **AuthProcessor holds no cached auth result**: The processor delegates instead of caching.
  - Given: the renamed `AuthProcessor` class
  - When: its source and runtime behaviour are inspected
  - Then: it carries no `authResult` field; `isAuthenticated`, `extendRequest`, and the session-invalidation method delegate directly to the injected strategy

- [X] **Single-flight authentication preserved**: Concurrent first-time callers coalesce into one handshake.
  - Given: a strategy whose `authenticate` resolves after a measurable delay
  - When: N concurrent requests trigger first-time authentication via `AuthProcessor`
  - Then: the strategy's `authenticate(client)` method is invoked exactly once, and all N requests succeed using the resulting session

- [X] **401 recovery preserved**: One replay against an invalidated session, with the original config re-extended.
  - Given: a strategy that initially yields credentials the upstream rejects with HTTP 401
  - When: `AuthRestClient` issues a request that receives 401
  - Then: the session is invalidated, `strategy.authenticate(client)` is invoked again, the original (pre-extension) request config is re-extended, and the request is replayed exactly once before any further error propagates

- [X] **Static-token README example is runnable and tested**: `RestModule` is sufficient for static credentials.
  - Given: a NestJS module assembled per the new README static-token example using `RestModule.forRootAsync` with `axios.headers.Authorization`
  - When: an automated test issues an HTTP request through the resolved `RestClient`
  - Then: the outgoing request carries the configured `Authorization` header value verbatim

- [X] **README guidance note for module choice**: Readers can pick the right module on first read.
  - Given: a new reader of the README
  - When: they reach the "Authenticated client" section
  - Then: a note clearly states that static credentials should use `RestModule` directly, while dynamic credentials should use `AuthRestModule`

- [X] **JSDoc usage examples on every public class and method**: Every public surface ships with at least one example.
  - Given: the repository's public surface
  - When: any exported class or public method is inspected (IDE hover, generated docs, or source review)
  - Then: a JSDoc block is present that includes at least one `@example` snippet illustrating typical usage

- [X] **All tests pass after the refactor**: CI is green.
  - Given: the refactored branch
  - When: `npm run lint`, `npm run typecheck`, `npm run test:unit`, and `npm run test:e2e` are executed
  - Then: each command exits with status 0; unit-test coverage does not drop below the existing `jest-it-up` floor; mutation score does not regress versus the current Stryker baseline

### Non-Functional Requirements

- [X] **Behaviour preservation**: Single-flight authentication, 401 recovery semantics, and signal-based cancellation forwarding behave identically to the pre-refactor implementation.
- [X] **Documentation completeness**: 100% of exported classes and public methods carry a JSDoc `@example`.
- [X] **Build health**: `npm run build` produces a clean dist with no type errors.

### Definition of Done

- [X] All functional acceptance criteria pass.
- [X] All non-functional acceptance criteria pass.
- [X] Unit tests added/updated for `AuthProcessor`, `AuthRestClient`, and `AuthRestModule` cover the new strategy-class lifecycle.
- [X] e2e tests added for the static-token `RestModule` example AND a dynamic-auth class strategy flow.
- [X] Existing test suite green (`npm run test`).
- [X] README updated with the new static-token example and the module-choice guidance note.
- [X] JSDoc `@example` audit complete across exported classes and public methods.
- [X] No remaining references to `AuthConfig` or `AuthStrategyService`.
- [ ] Code reviewed.

---

## Architecture

### References

- **Skill**: `.claude/skills/nestjs-http-client-architecture/SKILL.md`
- **Codebase Analysis**: `.specs/analysis/analysis-improve-auth-rest-client.md`
- **Scratchpad**: `.specs/scratchpad/44a567d4.md`

### Solution Strategy

**Architecture Pattern**: Layered + Hexagonal (Ports & Adapters). Layered separation between `src/client/` (transport + resilience) and `src/auth/` (auth lifecycle); hexagonal port-adapter pattern where `AuthStrategy` is the port and the consumer-supplied class is the adapter, plugged in via NestJS DI. Codebase precedent: `HttpServiceLike` port + `HttpService`/`RestClient` adapters at `src/client/hookable-http.service.ts:50`.

**Approach**: Refactor the auth layer from a factory-returned `AuthConfig` pattern to a NestJS-idiomatic class-based DI pattern. The `AuthStrategy` interface gains an `authenticate(client)` method and an `invalidate()` method, owning its full session lifecycle. The renamed `AuthProcessor` (formerly `AuthStrategyService`) drops its `authResult` cache and becomes a thin orchestration shell that delegates to the injected strategy and preserves the single-flight `@DeduplicateInflight` guarantee. `AuthRestModule.forRootAsync` accepts the strategy class as a top-level synchronous argument so NestJS can resolve and instantiate it via `useClass` self-binding with full DI access. `AuthConfig` is deleted. A static-token example using `RestModule` with `axios.headers.Authorization` is added to the README and verified by an e2e test. JSDoc `@example` blocks are added to every exported class and public method.

**Key Decisions**:

1. **Top-level synchronous `authStrategy: Type<AuthStrategy>` on `forRootAsync`**: the class identity must be known at module-static time for `useClass` registration; runtime data (`httpService`, `resilience`) stays in the async `useFactory`. More idiomatic than `ModuleRef.create()` workarounds.
2. **Self-bind the strategy via `{ provide: options.authStrategy, useClass: options.authStrategy }`**: NestJS resolves the constructor and injects all available providers, satisfying the "AuthStrategy is a class injectable" AC.
3. **Session-invalidation method named `invalidate()`**: parallels `clearAuth()` semantically without coupling vocabulary.
4. **Field rename `authStrategy` → `authProcessor` on `AuthRestClient`**: keeps vocabulary consistent with the class rename. Pre-1.0 breaking change is in scope.
5. **Preserve `inflightMap` + `@DeduplicateInflight('authenticate')` on `AuthProcessor.performAuthenticate`**: single-flight invariant unchanged; only the underlying call shifts from `authConfig.authenticate(client)` to `strategy.authenticate(client)`.
6. **Static-token guidance**: documented and tested as the canonical static-credentials path via `RestModule.forRootAsync({ axios: { headers: { Authorization } } })`.

**Trade-offs Accepted**:

- Split options shape on `forRootAsync` (synchronous class field + async data factory) is unconventional, accepted for the gain in DI idiomatic-ness.
- Strategy now owns invalidation; consumers must implement `invalidate()` even for trivial strategies. Accepted because it pushes session ownership where it belongs.

### Architecture Decomposition

**Components**:

| Component | Responsibility | Dependencies |
|-----------|---------------|--------------|
| `AuthStrategy` (interface, expanded) | Port: full auth session lifecycle (`authenticate`, `isAuthenticated`, `extendRequest`, `invalidate`) | `RestClient` (forward-typed), `AxiosRequestConfig` |
| `AuthProcessor` (class, renamed from `AuthStrategyService`) | Orchestrates pre-flight, single-flight, invalidate; delegates to injected strategy | `AuthStrategy`, `RestClient`, `@DeduplicateInflight` |
| `AuthRestClient` (refactored) | Composes RestClient + AuthProcessor; runs auth lifecycle in `dispatch` | `RestClient`, `AuthProcessor` |
| `AuthRestModule` (refactored) | NestJS dynamic module wiring strategy (via `useClass`), AuthProcessor, AuthRestClient | NestJS DI, `RestModule` |
| Static-token e2e test | Verifies `RestModule` + `axios.headers.Authorization` flow | testcontainers httpbin |

**Interactions**:

```
[Consumer Module]
      │
      ▼
[AuthRestModule.forRootAsync({ authStrategy: MyClass, useFactory })]
      │
      ▼
[NestJS DI Container]
   │   │   │
   │   │   └─► { provide: MyClass, useClass: MyClass } ─► instantiates MyClass with deps
   │   └─────► AUTH_MODULE_OPTIONS (httpService, resilience?)
   └─────────► RestModule.forHttpService(...) ─► RestClient
                                                       │
                                                       ▼
   ┌─► AuthProcessor(strategy: MyClass, client: RestClient)
                                                       │
                                                       ▼
   └─► AuthRestClient(restClient, authProcessor)
```

### Expected Changes

```
src/
├── index.ts                                  # UPDATE: swap AuthStrategyService → AuthProcessor export; remove AuthConfig type export
├── auth/
│   ├── auth.config.ts                        # UPDATE: delete AuthConfig; expand AuthStrategy with authenticate(client) + invalidate()
│   ├── auth-strategy.service.ts              # DELETE (replaced by auth-processor.ts)
│   ├── auth-processor.ts                     # NEW: AuthProcessor class (drop authResult; delegate to injected strategy)
│   ├── auth-rest.client.ts                   # UPDATE: rename field authStrategy → authProcessor; type AuthStrategyService → AuthProcessor
│   ├── auth-rest.module.ts                   # UPDATE: drop AuthConfig; new options shape; useClass strategy registration
│   └── __tests__/
│       ├── auth-strategy.service.spec.ts     # DELETE (replaced by auth-processor.spec.ts)
│       ├── auth-processor.spec.ts            # NEW: tests for AuthProcessor delegation + single-flight + invalidate
│       ├── auth-rest.client.spec.ts          # UPDATE: import path; field rename
│       └── auth-rest.module.spec.ts          # UPDATE: bootstrap factory for new options shape; class-based strategy stub
├── client/
│   ├── rest.client.ts                        # UPDATE: add @example JSDoc to class + every public method
│   ├── hookable-http.service.ts              # UPDATE: add @example JSDoc to class + dispatch + callUnderlying + every verb
│   ├── rest.module.ts                        # UPDATE: add @example JSDoc to forRootAsync, forHttpService, options types
│   └── resilance.config.ts                   # UPDATE: add @example JSDoc to ResilanceConfig + sub-types
└── resilence.policy.ts                       # UPDATE: add @example JSDoc to ResilencePresets + each preset constant

tests/
├── auth-rest-client.e2e.spec.ts              # UPDATE: replace CountingAuthConfig with CountingAuthStrategy
└── static-token.e2e.spec.ts                  # NEW: tests RestModule.forRootAsync + axios.headers.Authorization

README.md                                     # UPDATE: rewrite auth examples; add static-token example; add module-choice guidance note
```

### Building Block View

```
+------------------------------------------------------+
|                     AuthRestModule                   |
+------------------------------------------------------+
|                                                      |
|  +--------------+     +-------------------------+    |
|  | RestModule   |---->| RestClient              |    |
|  | .forHttp...  |     | (resilience pipeline)   |    |
|  +--------------+     +-----------+-------------+    |
|                                   |                  |
|                                   v                  |
|  +-------------+    +---------------------------+    |
|  | AuthStrategy|--->| AuthProcessor             |    |
|  | (useClass)  |    | - authenticateIfNeeded    |    |
|  | consumer    |    | - extendRequest           |    |
|  | class       |    | - clearAuth               |    |
|  +-------------+    | - inflightMap             |    |
|                     |   (single-flight)         |    |
|                     +-------------+-------------+    |
|                                   |                  |
|                                   v                  |
|         +---------------------------------------+    |
|         | AuthRestClient (extends Hookable)     |    |
|         | dispatch: pre-flight + extend + 401   |    |
|         | recovery via callUnderlying           |    |
|         +---------------------------------------+    |
|                                                      |
+------------------------------------------------------+
```

### Runtime Scenarios

**Scenario: First authenticated request (cold-start)**

```
Caller ─► AuthRestClient.get('/x')
   │
   ▼
[dispatch] authProcessor.authenticateIfNeeded()
   │  strategy.isAuthenticated() → false
   ▼
[performAuthenticate @DeduplicateInflight]
   │  strategy.authenticate(restClient)
   │    └─► strategy stores token internally
   ▼
[dispatch] config = authProcessor.extendRequest(originalConfig)
   │  strategy.extendRequest → { Authorization: ... }
   ▼
[super.dispatch → RestClient policy.execute → axios]
   ▼
upstream 200 → response
```

**Scenario: Concurrent first-time (single-flight)**

```
Caller-1 ────┐
             ├─► AuthRestClient.get(...)
Caller-2 ────┘
             │
             ▼
Both pre-flight: authenticateIfNeeded()
             │
             ▼
performAuthenticate() — @DeduplicateInflight key='authenticate'
             │
             ▼
strategy.authenticate(client) called EXACTLY ONCE
             │
             ▼
Both callers proceed past pre-flight, share session
```

**Scenario: 401 → re-auth → retry once**

```
Caller ─► AuthRestClient.get('/x')
   │
   ▼
pre-flight isAuthenticated() → true
extendRequest → stale Authorization
   │
   ▼
super.dispatch → RestClient → axios → 401
   │
   ▼
catch: isAxiosError && status === 401
   │
   ▼
authProcessor.clearAuth() → strategy.invalidate()
authProcessor.authenticateIfNeeded() → strategy.authenticate(client) (single-flight)
retryConfig = authProcessor.extendRequest(initialArgs.config)   ← ORIGINAL config (replaces stale header)
callUnderlying('get', retryArgs)                                ← bypass dispatch override; no double pre-flight
   │
   ▼
upstream 200 → response (or 2nd 401 propagates as-is)
```

**State Transitions** (consumer-implemented strategy):

```
[Uninit]  ──strategy.authenticate()──►          [Active]
[Active]  ──token expires/rejected:             [Stale]
            isAuthenticated()=false──►
[Stale]   ──strategy.authenticate() on next     [Active]
            pre-flight──►
[Active]  ──strategy.invalidate() (401 path)──► [Invalid]
[Invalid] ──strategy.authenticate()──►          [Active]
```

### Architecture Decisions

#### Strategy class registration: `useClass` self-binding

**Status**: Accepted

**Context**: NestJS DI must instantiate the consumer's `AuthStrategy` class with full constructor injection so the class can use `ConfigService`, logger, vault, etc.

**Options**:

1. Self-bind via `{ provide: options.authStrategy, useClass: options.authStrategy }`.
2. Use `ModuleRef.create(StrategyClass)` lazily inside AuthProcessor.
3. Symbol token + consumer registers `useClass` separately.

**Decision**: Option 1 — self-binding via `useClass` with the class itself as the provider token.

**Consequences**:

- Consumer's strategy class is a first-class NestJS provider; `@Inject(...)` works inside it.
- Module spec test must verify the strategy is resolved through DI (not constructed manually).
- `forRootAsync` options shape splits class identity (synchronous) from runtime data (async factory).

#### Session-invalidation method name: `invalidate()`

**Status**: Accepted

**Context**: With `authResult` removed from `AuthProcessor`, `clearAuth()` must signal the strategy to drop its session. The strategy interface needs a name for this method.

**Options**:

1. `invalidate(): void`
2. `clearSession(): void`
3. `reset(): void`

**Decision**: `invalidate(): void`.

**Consequences**:

- Reads naturally on the strategy ("invalidate my session").
- Distinct from `AuthProcessor.clearAuth()` so the layered semantics stay readable.
- Strategy implementers must implement it even for trivial strategies; documented in the interface JSDoc.

#### Field rename: `authStrategy` → `authProcessor` on `AuthRestClient`

**Status**: Accepted

**Context**: The current public field on `AuthRestClient` is `authStrategy: AuthStrategyService`. After the rename, the type is `AuthProcessor`. Mismatched name + type would be confusing.

**Options**:

1. Rename field to `authProcessor`.
2. Keep field name `authStrategy`; only retype.

**Decision**: Rename to `authProcessor`.

**Consequences**:

- Vocabulary consistent with class rename.
- Pre-1.0 breaking change — accepted explicitly in task scope.
- Adapters/tests reading the field must update.

### High-Level Structure

```
Feature: Class-based AuthStrategy DI
├── Entry Point: AuthRestModule.forRootAsync({ authStrategy: MyClass, useFactory })
├── Core Logic:  AuthProcessor orchestrates pre-flight + single-flight; AuthRestClient.dispatch runs auth lifecycle
├── Data Layer:  Strategy class owns its own session state (no processor cache)
└── Output:      AuthRestClient injectable; resilient + authenticated HTTP calls
```

### Workflow Steps

```
1. Consumer defines MyAuthStrategy ─► 2. Registers via forRootAsync ─► 3. NestJS instantiates strategy via useClass
        │                                       │                                  │
        ▼                                       ▼                                  ▼
   class with deps                       AuthRestModule wires                AuthProcessor injected
   (ConfigService, etc.)                 strategy + AuthProcessor             with strategy + RestClient
                                          + AuthRestClient
        │                                       │                                  │
        └───────────────────────────────────────┴─────────────► 4. AuthRestClient.get(...) ─► 5. response
```

### Contracts

**Interface Contract — `AuthStrategy` (expanded)**:

```ts
interface AuthStrategy {
  /**
   * Performs the authentication handshake. Stores resulting session state
   * on the implementing class. Called by AuthProcessor inside a
   * single-flight wrapper.
   */
  authenticate(client: RestClient): Promise<void>

  /** Returns true while the current credentials are still valid. */
  isAuthenticated(): boolean

  /**
   * Returns a NEW AxiosRequestConfig with credentials applied.
   * MUST NOT mutate the input.
   */
  extendRequest(config: AxiosRequestConfig): AxiosRequestConfig

  /**
   * Drops the current session. Subsequent isAuthenticated() must return
   * false until a fresh authenticate() completes. Called on the 401 path.
   */
  invalidate(): void
}
```

**Module Contract — `AuthRestModule.forRootAsync`**:

```ts
interface AuthRestModuleOptions {
  httpService: HttpService
  resilience?: ResilanceConfig<unknown>
}

AuthRestModule.forRootAsync(options: {
  authStrategy: Type<AuthStrategy>           // synchronous class token
  useFactory: (...args: unknown[]) => Promise<AuthRestModuleOptions> | AuthRestModuleOptions
  inject?: unknown[]
  imports?: unknown[]
}): DynamicModule
```

**Class Contract — `AuthProcessor`**:

```ts
class AuthProcessor {
  readonly inflightMap: Map<string, Promise<unknown>>
  constructor(strategy: AuthStrategy, client: RestClient)
  isAuthenticated(): boolean
  authenticateIfNeeded(): Promise<void>
  extendRequest(config: AxiosRequestConfig): AxiosRequestConfig
  clearAuth(): void
}
```

---

## Implementation Process

You MUST launch for each step a separate agent, instead of performing all steps yourself. And for each step marked as parallel, you MUST launch separate agents in parallel.

**CRITICAL:** For each agent you MUST:
1. Use the **Agent** type specified in the step (e.g., `haiku`, `sdd:developer`, `sdd:tech-writer`, `sdd:qa-engineer`)
2. Provide path to task file and prompt which step to implement
3. Require agent to implement exactly that step, not more, not less, not other steps

### Parallelization Overview

```
Step 1 (L0.1)        Step 2 (L0.2)        Step 11 (L4.2)
[sdd:developer]      [sdd:tech-writer]    [sdd:qa-engineer]
(interface)          (client JSDoc)       (static e2e)
    │                    │                    │
    ▼                    │                    │
Step 3 (L1.1)            │                    │
[sdd:developer]          │                    │
(AuthProcessor)          │                    │
    │                    │                    │
    ├──────────────┐     │                    │
    ▼              ▼     │                    │
Step 4 (L1.2)  Step 5 (L2.1)                  │
[sdd:qa-eng]   [sdd:developer]                │
(AP tests)     (AuthRestClient)               │
                   │                          │
                   ├──────────────┐           │
                   ▼              ▼           │
              Step 6 (L2.2)  Step 7 (L3.1)    │
              [sdd:qa-eng]   [sdd:developer]  │
              (ARC tests)    (Module)         │
                                  │           │
                       ┌──────────┼─────┐     │
                       ▼          ▼     ▼     │
                  Step 8 (L3.2) Step 9  Step 12
                  [sdd:qa-eng]  (L3.3)  (L4.3)
                  (Mod tests)   [haiku] [sdd:tech-
                                        writer]
                                  │
                                  ▼
                            Step 10 (L4.1)
                            [sdd:qa-engineer]
                            (auth e2e)

         (after Step 7 + Step 11)
                                  ▼
                            Step 13 (L5.1)
                            [sdd:tech-writer]
                            (README)
                                  │
       all of 2, 4, 6, 8, 10, 12, 13 complete
                                  ▼
                            Step 14 (L5.2)
                            [sdd:qa-engineer]
                            (final gate)
```

**Parallel Execution Groups:**
- **Group 0 (immediate start, MUST run in parallel)**: Step 1, Step 2, Step 11
- **Group 1 (after Step 3, MUST run in parallel)**: Step 4, Step 5
- **Group 2 (after Step 5, MUST run in parallel)**: Step 6, Step 7
- **Group 3 (after Step 7, MUST run in parallel)**: Step 8, Step 9, Step 12
- **Group 4 (after Step 9 / Step 7 + Step 11)**: Step 10, Step 13 (can run together)
- **Final (sequential)**: Step 14

### Implementation Strategy

**Approach**: Bottom-Up (building blocks first), with Mixed at the JSDoc, README, and integration phases.

**Rationale**: The auth refactor's complexity is concentrated at the lowest layer (the `AuthStrategy` interface contract + `AuthProcessor` class). Without those primitives, nothing downstream compiles. Strict bottom-up ordering surfaces type errors at the bottom of the dependency chain where they are cheapest to fix. Higher-level concerns (module wiring, e2e tests, README) are well-defined orchestrations once the building blocks are in place. JSDoc audits on the client layer are pure additive work and orthogonal to the dependency chain — they are scheduled as a parallel-safe stream that can run in any phase. Auth-layer JSDoc must follow the auth refactor (its content depends on the new shapes).

### Least-to-Most Decomposition Chain

```
Level 0 (no deps):
  L0.1 AuthStrategy interface (add authenticate + invalidate; delete AuthConfig)
  L0.2 Client-layer JSDoc audit (independent of auth refactor)

Level 1 (depends on L0.1):
  L1.1 AuthProcessor class (delegates to injected strategy; @DeduplicateInflight preserved)
  L1.2 AuthProcessor unit tests (verify delegation + single-flight + invalidate)

Level 2 (depends on L1.1):
  L2.1 AuthRestClient refactor (rename field/type; same dispatch lifecycle)
  L2.2 AuthRestClient unit test updates (import + field rename)

Level 3 (depends on L1.1, L2.1):
  L3.1 AuthRestModule refactor (useClass self-binding for strategy class)
  L3.2 AuthRestModule unit tests (verify DI instantiation invariant)
  L3.3 src/index.ts exports update

Level 4 (depends on Level 1-3 outputs):
  L4.1 e2e refactor (CountingAuthStrategy class replaces CountingAuthConfig)
  L4.2 Static-token e2e (new file; depends only on RestModule which is unchanged)
  L4.3 Auth-layer JSDoc audit (new exported surface)

Level 5 (depends on all of Level 1-4):
  L5.1 README rewrite (auth examples + static-token example + guidance note)
  L5.2 Test integration verification (lint + typecheck + unit + e2e + build)
```

### Phase Overview

```
Phase 1: Foundation         (L0.1 — interface contract; L0.2 parallel)
    │
    ▼
Phase 2: AuthProcessor      (L1.1 + L1.2 paired)
    │
    ▼
Phase 3: AuthRestClient     (L2.1 + L2.2 paired)
    │
    ▼
Phase 4: AuthRestModule     (L3.1 + L3.2 paired, then L3.3)
    │
    ▼
Phase 5: Integration        (L4.1, L4.2, L4.3 in parallel)
    │
    ▼
Phase 6: Polish & Verify    (L5.1 + L5.2)
```

---

### Step 1 (L0.1): Redefine `AuthStrategy` interface and delete `AuthConfig` [DONE]

**Model:** opus
**Agent:** sdd:developer
**Depends on:** None
**Parallel with:** Step 2, Step 11

**Goal**: Establish the new auth contract: `AuthStrategy` becomes a full session-lifecycle interface owning `authenticate`, `isAuthenticated`, `extendRequest`, and `invalidate`. `AuthConfig` ceases to exist.

#### Expected Output

- `src/auth/auth.config.ts` updated: `AuthConfig` interface deleted; `AuthStrategy` interface expanded with `authenticate(client: RestClient): Promise<void>` and `invalidate(): void`.
- JSDoc on `AuthStrategy` updated to document the new lifecycle ownership and method semantics.

#### Success Criteria

- [ ] `AuthConfig` interface no longer present in `src/auth/auth.config.ts`.
- [ ] `AuthStrategy` interface declares all four members: `authenticate`, `isAuthenticated`, `extendRequest`, `invalidate`.
- [ ] `npm run typecheck` reports the expected breakage cascade in dependent files (`auth-rest.module.ts`, `auth-strategy.service.ts`, `auth-rest-client.e2e.spec.ts`, etc.) — these failures are addressed by subsequent steps.
- [ ] No other files in `src/` are modified.

#### Subtasks

- [ ] Edit `src/auth/auth.config.ts` to delete `AuthConfig` interface
- [ ] Edit `src/auth/auth.config.ts` to add `authenticate(client: RestClient): Promise<void>` to `AuthStrategy`
- [ ] Edit `src/auth/auth.config.ts` to add `invalidate(): void` to `AuthStrategy`
- [ ] Update `AuthStrategy` JSDoc to describe session-lifecycle ownership

#### Blockers

- None

#### Risks

- Risk: Forward-typed `RestClient` import causes circular dependency. Mitigation: `import type { RestClient }` (already in place); verify with `npm run typecheck` after edit.

#### Complexity

Small

#### Uncertainty Rating

Low

#### Dependencies

- None (foundation)

#### Integration Points

- Consumed by L1.1 (AuthProcessor implementation)
- Consumed by L4.1 (e2e CountingAuthStrategy)
- Consumed by L3.1 (AuthRestModule provider type token)

#### Definition of Done

- [ ] All subtasks completed
- [ ] `AuthConfig` references in `src/auth/auth.config.ts` removed
- [ ] New methods present on `AuthStrategy`
- [ ] No new lint errors introduced (typecheck breakage in dependents is expected and intentional)

#### Verification

**Level:** ✅ CRITICAL - Panel of 2 Judges with Aggregated Voting
**Artifact:** `src/auth/auth.config.ts`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Contract Correctness | 0.30 | `AuthStrategy` declares all 4 methods with exact signatures from spec (`authenticate(client: RestClient): Promise<void>`, `isAuthenticated(): boolean`, `extendRequest(config: AxiosRequestConfig): AxiosRequestConfig`, `invalidate(): void`); `AuthConfig` interface fully removed |
| Type Safety | 0.20 | `RestClient` is forward-typed via `import type` (no circular dep); `AxiosRequestConfig` import preserved; non-mutation contract on `extendRequest` documented |
| JSDoc Quality | 0.20 | Each method documents semantics: `authenticate` notes single-flight ownership, `extendRequest` notes no-mutation, `invalidate` notes session-drop behavior |
| Scope Discipline | 0.15 | Only `auth.config.ts` modified; no other `src/` files touched in this step |
| Pre-1.0 Cleanup | 0.15 | No backward-compat shims for `AuthConfig`; clean removal aligns with pre-1.0 breaking-change scope |

**Reference Pattern:** `src/client/hookable-http.service.ts` (HttpServiceLike port pattern)

---

### Step 2 (L0.2): Client-layer JSDoc audit (parallel-safe) [DONE]

**Model:** sonnet
**Agent:** sdd:tech-writer
**Depends on:** None
**Parallel with:** All other steps except Step 14
**Note:** This step is fully orthogonal to the auth refactor and MUST be launched in parallel from the very start of execution.

**Goal**: Add at least one `@example` block to every exported class and public method in the client + presets layer so 100% of the non-auth public surface ships with usage examples.

#### Expected Output

- `src/client/rest.client.ts` — `RestClient` class JSDoc updated with `@example`; every public method (`request`, `get`, `delete`, `head`, `post`, `put`, `patch`, `postForm`, `putForm`, `patchForm`, `axiosRef` getter) gains an `@example` block.
- `src/client/hookable-http.service.ts` — `HookableHttpService` class JSDoc updated with `@example`; protected `dispatch` and `callUnderlying` documented with `@example`; every verb method already inherits but receive a class-level `@example` showing the subclass extension pattern. `HttpVerb`, `InvokeArgs`, `HttpServiceLike` types receive `@example` blocks.
- `src/client/rest.module.ts` — `RestModule.forRootAsync`, `RestModule.forHttpService`, `RestModuleOptions`, `RestFromHttpServiceOptions` updated with `@example` blocks. `REST_MODULE_OPTIONS` symbol documented with usage example.
- `src/client/resilance.config.ts` — `ResilanceConfig`, `RetryConfig`, `CircuitBreakerConfig`, `BulkheadConfig`, `FallbackConfig`, `TimeoutConfig` each gain at least one `@example` block.
- `src/resilence.policy.ts` — `ResilencePresets` const + each named preset (`CONSERVATIVE`, `RESTFULL`, `LOW_QUALITY`) gains an `@example` block.

#### Success Criteria

- [ ] Every exported class in `src/client/*` and `src/resilence.policy.ts` has a JSDoc block containing at least one `@example`.
- [ ] Every public method on those classes has a JSDoc block containing at least one `@example`.
- [ ] Every exported interface/type in those files has a JSDoc block containing at least one `@example`.
- [ ] `npm run lint` and `npm run typecheck` still pass.
- [ ] `npm run build` produces a clean dist.

#### Subtasks

- [ ] Add `@example` blocks in `src/client/rest.client.ts` (class + 11 public method/getter sites)
- [ ] Add `@example` blocks in `src/client/hookable-http.service.ts` (class + 12 method/type sites)
- [ ] Add `@example` blocks in `src/client/rest.module.ts` (class + 2 static methods + 2 interfaces + 1 symbol)
- [ ] Add `@example` blocks in `src/client/resilance.config.ts` (6 interfaces)
- [ ] Add `@example` blocks in `src/resilence.policy.ts` (1 const object + 3 named preset values)
- [ ] Run `npm run lint` and `npm run build` to verify

#### Blockers

- None

#### Risks

- Risk: `@example` snippets could drift from real API. Mitigation: copy verbatim from existing tests/README where possible; keep snippets minimal.

#### Complexity

Medium

#### Uncertainty Rating

Low

#### Dependencies

- None (orthogonal to auth refactor)

#### Integration Points

- None at runtime; consumed by IDE hover, generated docs, README cross-references

#### Definition of Done

- [ ] All subtasks completed
- [ ] All targeted public surfaces carry `@example` blocks
- [ ] `npm run lint`, `npm run typecheck`, `npm run build` pass
- [ ] No behavioural changes — pure documentation additions

#### Verification

**Level:** ✅ Per-File Judges (5 separate evaluations in parallel)
**Artifacts:** `src/client/rest.client.ts`, `src/client/hookable-http.service.ts`, `src/client/rest.module.ts`, `src/client/resilance.config.ts`, `src/resilence.policy.ts`
**Threshold:** 4.0/5.0

**Rubric (per file):**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Coverage Completeness | 0.30 | Every exported class, public method, exported interface/type/symbol in this file has a JSDoc block containing at least one `@example` |
| Example Accuracy | 0.25 | `@example` snippets compile against the current API (verb signatures, options shapes, preset names match implementation; no stale references) |
| Snippet Quality | 0.20 | Examples are minimal yet illustrative (show typical usage), not type repetitions; subclass extension pattern shown for `HookableHttpService` |
| No Behavioural Changes | 0.15 | Pure documentation additions; no runtime code modified in this file |
| Lint/Build Health | 0.10 | `npm run lint` and `npm run build` pass after edits to this file |

**Reference Pattern:** Existing JSDoc on `RestModule.forRootAsync` in `src/client/rest.module.ts`

---

### Step 3 (L1.1): Implement `AuthProcessor` class [DONE]

**Model:** opus
**Agent:** sdd:developer
**Depends on:** Step 1
**Parallel with:** Step 2, Step 11 (both still running from Group 0)

**Goal**: Replace `AuthStrategyService` with the renamed, simplified `AuthProcessor` that owns no cached `authResult` and delegates all session queries directly to the injected `AuthStrategy` class instance.

#### Expected Output

- New file `src/auth/auth-processor.ts` containing `export class AuthProcessor` with:
  - `readonly inflightMap = new Map<string, Promise<unknown>>()`
  - Constructor `(private readonly strategy: AuthStrategy, private readonly client: RestClient)`
  - `isAuthenticated(): boolean` — delegates to `strategy.isAuthenticated()`
  - `async authenticateIfNeeded(): Promise<void>` — short-circuits when authenticated, else calls `performAuthenticate()`
  - `extendRequest(config: AxiosRequestConfig): AxiosRequestConfig` — delegates to `strategy.extendRequest(config)`
  - `clearAuth(): void` — calls `strategy.invalidate()`
  - `@DeduplicateInflight(() => 'authenticate') private async performAuthenticate(): Promise<void>` — calls `await strategy.authenticate(client)`
- Local `AUTHENTICATE_DEDUP_KEY` constant preserved.
- File `src/auth/auth-strategy.service.ts` deleted.
- JSDoc on `AuthProcessor` documents: single-flight invariant via `@DeduplicateInflight`, the no-cached-state contract, and how `clearAuth` delegates to `strategy.invalidate()`.

#### Success Criteria

- [ ] `src/auth/auth-processor.ts` exists with the class shape above.
- [ ] `src/auth/auth-strategy.service.ts` no longer exists.
- [ ] `AuthProcessor` has no `authResult` field and no `AuthConfig` import.
- [ ] `@DeduplicateInflight(() => 'authenticate')` decorates `performAuthenticate`.
- [ ] `inflightMap` is a public readonly field (required by `@DeduplicateInflight`).
- [ ] `npm run typecheck` passes for `src/auth/auth-processor.ts` against the L0.1 interface (failures elsewhere are expected and addressed in later steps).

#### Subtasks

- [X] Create `src/auth/auth-processor.ts` with the class skeleton
- [X] Implement `isAuthenticated`, `authenticateIfNeeded`, `extendRequest`, `clearAuth`, `performAuthenticate`
- [X] Apply `@DeduplicateInflight(() => 'authenticate')` to `performAuthenticate`
- [X] Add JSDoc with `@example` block on the class (delegation + single-flight illustration)
- [X] Delete `src/auth/auth-strategy.service.ts`

#### Blockers

- L0.1 must complete first (interface must declare `authenticate` and `invalidate`).

#### Risks

- Risk: Removing the `authResult` cache changes single-flight subtlety — concurrent callers can both pass the `isAuthenticated()` guard before either runs `performAuthenticate`. Mitigation: `@DeduplicateInflight` gates the underlying call regardless of the guard, so single-flight holds. Verify with the dedicated concurrent-callers test in L1.2.
- Risk: `AuthProcessor` field type for `client` changes from `unknown` to `RestClient`, tightening the constructor contract. Mitigation: this is intentional (the architecture decision in the task spec calls for it); the only callers are `AuthRestModule` and unit/e2e tests, all updated in subsequent steps.

#### Complexity

Small

#### Uncertainty Rating

Low

#### Dependencies

- L0.1 (AuthStrategy interface includes `authenticate` and `invalidate`)

#### Integration Points

- Consumed by L2.1 (AuthRestClient field/constructor type)
- Consumed by L3.1 (AuthRestModule provider wiring)
- Consumed by L4.1 (e2e buildSut)

#### Definition of Done

- [X] All subtasks completed
- [X] `AuthProcessor` class compiles against the L0.1 interface
- [X] Old `auth-strategy.service.ts` deleted
- [X] JSDoc with `@example` block present on the class

#### Verification

**Level:** ✅ CRITICAL - Panel of 2 Judges with Aggregated Voting
**Artifact:** `src/auth/auth-processor.ts`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Correctness | 0.25 | Class shape matches contract: no `authResult` field; `readonly inflightMap = new Map<string, Promise<unknown>>()`; constructor takes `(strategy: AuthStrategy, client: RestClient)`; all 5 methods present (`isAuthenticated`, `authenticateIfNeeded`, `extendRequest`, `clearAuth`, `performAuthenticate`) |
| Single-Flight Preservation | 0.25 | `@DeduplicateInflight(() => 'authenticate')` decorates `performAuthenticate`; `AUTHENTICATE_DEDUP_KEY` constant retained; concurrent callers must coalesce to a single `strategy.authenticate(client)` invocation |
| Delegation Correctness | 0.20 | `isAuthenticated` delegates to `strategy.isAuthenticated()`; `extendRequest` delegates to `strategy.extendRequest(config)`; `clearAuth` delegates to `strategy.invalidate()`; no internal caching of session state |
| File Hygiene | 0.15 | `src/auth/auth-strategy.service.ts` deleted; no `AuthConfig` import; no stale references to `AuthStrategyService` |
| JSDoc & @example | 0.15 | Class JSDoc explains delegation contract and single-flight invariant; includes a concrete `@example` block illustrating typical construction and usage |

**Reference Pattern:** Previous `src/auth/auth-strategy.service.ts` (single-flight orchestration pattern with `@DeduplicateInflight`)

---

### Step 4 (L1.2): Write `AuthProcessor` unit tests [DONE]

**Model:** opus
**Agent:** sdd:qa-engineer
**Depends on:** Step 3
**Parallel with:** Step 5
**Note:** Steps 4 and 5 share the same dependency (Step 3) and MUST be launched in parallel by separate agents.

**Goal**: Verify the new `AuthProcessor` delegates correctly to its injected strategy and preserves the single-flight contract previously held by `AuthStrategyService`.

#### Expected Output

- New file `src/auth/__tests__/auth-processor.spec.ts` with the following test suites:
  - `isAuthenticated()` — delegates to strategy.isAuthenticated() (true and false branches)
  - `authenticateIfNeeded()` — skips when authenticated, calls strategy.authenticate when not, forwards `client`, single-flight (concurrent N callers → 1 strategy.authenticate invocation), inflightMap cleanup after completion
  - `extendRequest()` — delegates to strategy.extendRequest()
  - `clearAuth()` — calls strategy.invalidate(); after clearAuth a stale strategy reports unauthenticated and the next authenticateIfNeeded triggers a fresh strategy.authenticate
- Old file `src/auth/__tests__/auth-strategy.service.spec.ts` deleted.

#### Success Criteria

- [ ] `auth-processor.spec.ts` exists with at least 10 tests covering the four method groups above.
- [ ] `auth-strategy.service.spec.ts` no longer exists.
- [ ] Single-flight test verifies exactly one `strategy.authenticate` call across N concurrent `authenticateIfNeeded()` callers.
- [ ] `clearAuth` test verifies `strategy.invalidate()` was called.
- [ ] `npm run test:unit` runs the new spec successfully.
- [ ] `npm run test:cov` shows coverage for `auth-processor.ts` at or above the existing jest-it-up floor.

#### Subtasks

- [ ] Create test file with `createStrategyStub()` helper returning a `jest.Mocked<AuthStrategy>` shape
- [ ] Write `isAuthenticated()` tests (true/false delegation)
- [ ] Write `authenticateIfNeeded()` tests (skip-when-authed, re-auth-when-stale, forwards client, single-flight via Promise.all, inflightMap cleanup)
- [ ] Write `extendRequest()` tests (delegation to strategy)
- [ ] Write `clearAuth()` tests (invalidate is called; subsequent authenticateIfNeeded triggers fresh authenticate)
- [ ] Delete `src/auth/__tests__/auth-strategy.service.spec.ts`
- [ ] Run `npm run test:unit` and `npm run test:cov` to confirm coverage holds

#### Blockers

- L1.1 must complete first (AuthProcessor class must exist).

#### Risks

- Risk: jest-it-up coverage floor regression. Mitigation: run `npm run test:cov` immediately after spec is written; if floor regresses, add additional branch tests (e.g. test that `extendRequest` called before any `authenticateIfNeeded` still delegates — covers the "no authResult cache" branch removal).

#### Complexity

Medium

#### Uncertainty Rating

Low

#### Dependencies

- L0.1 (interface)
- L1.1 (class implementation)

#### Integration Points

- Tests gate against `auth-processor.ts` directly

#### Definition of Done

- [ ] All subtasks completed
- [ ] All test cases pass
- [ ] Tests cover delegation, single-flight, inflightMap cleanup, invalidate
- [ ] Coverage floor not regressed (`npm run test:cov` passes)
- [ ] Old spec file deleted

#### Verification

**Level:** ✅ Single Judge
**Artifact:** `src/auth/__tests__/auth-processor.spec.ts`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Coverage of Behavior | 0.25 | At least 10 tests across 4 method groups: `isAuthenticated()` (true/false delegation), `authenticateIfNeeded()` (skip-when-authed, re-auth-when-stale, forwards client), `extendRequest()` (delegation), `clearAuth()` (calls `strategy.invalidate()`) |
| Single-Flight Test | 0.25 | Concurrent N callers via `Promise.all([...])` invoke `strategy.authenticate` exactly once; `inflightMap` is empty after the awaited promise resolves |
| Edge Cases | 0.20 | Invalidate-then-reauth path tested: after `clearAuth()` strategy reports unauthenticated, next `authenticateIfNeeded()` triggers a fresh `strategy.authenticate(client)` call |
| Test Isolation | 0.15 | `createStrategyStub()` helper produces a clean `jest.Mocked<AuthStrategy>` per test; tests are independent |
| Cleanup & Coverage | 0.15 | Old `src/auth/__tests__/auth-strategy.service.spec.ts` deleted; jest-it-up coverage floor not regressed (verified by running `npm run test:cov`) |

**Reference Pattern:** Existing `src/auth/__tests__/auth-strategy.service.spec.ts` (single-flight test pattern)

---

### Step 5 (L2.1): Refactor `AuthRestClient` to consume `AuthProcessor` [DONE]

**Model:** opus
**Agent:** sdd:developer
**Depends on:** Step 3
**Parallel with:** Step 4
**Note:** Steps 4 and 5 share the same dependency (Step 3) and MUST be launched in parallel by separate agents.

**Goal**: Update the authenticated client facade to reference the renamed processor type and field, with no changes to its dispatch lifecycle semantics.

#### Expected Output

- `src/auth/auth-rest.client.ts` updated:
  - Import `AuthProcessor` from `./auth-processor` (replace `AuthStrategyService` import).
  - Public field `authStrategy: AuthStrategyService` renamed to `authProcessor: AuthProcessor`.
  - Constructor parameter renamed and retyped: `authProcessor: AuthProcessor`.
  - All internal `this.authStrategy.X` references updated to `this.authProcessor.X` in `dispatch`.
  - JSDoc updated: every `AuthStrategyService` mention becomes `AuthProcessor`; `@example` block added to the class.

#### Success Criteria

- [ ] No `AuthStrategyService` references in `auth-rest.client.ts`.
- [ ] `client.authProcessor` is the new public-readable field.
- [ ] Dispatch lifecycle (pre-flight, extend, 401 retry) is byte-equivalent to pre-refactor (only identifier renames).
- [ ] `npm run typecheck` passes for `auth-rest.client.ts` (against L0.1 + L1.1).

#### Subtasks

- [ ] Update import in `src/auth/auth-rest.client.ts`
- [ ] Rename public field `authStrategy` → `authProcessor`
- [ ] Rename constructor parameter and update assignment
- [ ] Update internal references in `dispatch`
- [ ] Update JSDoc references and add `@example` block

#### Blockers

- L1.1 must complete (AuthProcessor must exist as a type).

#### Risks

- Risk: External adapters reading `client.authStrategy` directly will break (pre-1.0 breaking change documented in task). Mitigation: update the unit test, e2e test, and module wiring in the next steps before merge.

#### Complexity

Small

#### Uncertainty Rating

Low

#### Dependencies

- L1.1 (AuthProcessor type)

#### Integration Points

- Consumed by L2.2 (unit test field reference)
- Consumed by L3.1 (module provider wiring)
- Consumed by L4.1 (e2e buildSut)

#### Definition of Done

- [ ] All subtasks completed
- [ ] `AuthRestClient` references `AuthProcessor` exclusively
- [ ] Dispatch lifecycle unchanged (byte-equivalent semantics)
- [ ] JSDoc has `@example` block on the class

#### Verification

**Level:** ✅ Single Judge
**Artifact:** `src/auth/auth-rest.client.ts`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Behavior Preserved | 0.35 | Dispatch lifecycle (pre-flight `authenticateIfNeeded`, `extendRequest`, 401 catch → `clearAuth` → reauth → re-extend ORIGINAL config → `callUnderlying` once) is byte-equivalent to pre-refactor implementation; only identifier renames |
| Rename Completeness | 0.25 | All `AuthStrategyService` references replaced with `AuthProcessor`; public field `authStrategy` renamed to `authProcessor`; constructor parameter and assignment updated |
| Type Correctness | 0.20 | Imports `AuthProcessor` from `./auth-processor` (replacing old import); typecheck passes against L0.1 interface and L1.1 class |
| JSDoc Updates | 0.15 | All `AuthStrategyService` mentions in JSDoc updated to `AuthProcessor`; class-level `@example` block added showing typical construction |
| No Scope Creep | 0.05 | No dispatch logic changes; no new functionality introduced; pure refactor |

**Reference Pattern:** Pre-refactor `src/auth/auth-rest.client.ts` (dispatch lifecycle preserved verbatim modulo renames)

---

### Step 6 (L2.2): Update `AuthRestClient` unit tests [DONE]

**Model:** opus
**Agent:** sdd:qa-engineer
**Depends on:** Step 5
**Parallel with:** Step 7
**Note:** Steps 6 and 7 both depend on Step 5 and MUST be launched in parallel by separate agents.

**Goal**: Update the existing `auth-rest.client.spec.ts` to reflect the field/type renames; preserve all existing test behaviour.

#### Expected Output

- `src/auth/__tests__/auth-rest.client.spec.ts` updated:
  - Import `AuthProcessor` from `../auth-processor` (replace `AuthStrategyService` import).
  - `buildSut()` casts to `AuthProcessor` when constructing the `AuthRestClient`.
  - Test description "exposes authStrategy as a public-readable field" updated to read `authProcessor`.
  - All `client.authStrategy` references → `client.authProcessor`.
  - Stub shape (`AuthStrategyStub`) retained — it's structurally compatible with `AuthProcessor`'s consumed surface (`authenticateIfNeeded`, `extendRequest`, `clearAuth`).

#### Success Criteria

- [ ] Test file imports `AuthProcessor` not `AuthStrategyService`.
- [ ] Field reference assertion uses `authProcessor`.
- [ ] All 17 existing tests pass.
- [ ] `npm run test:unit` exits 0.

#### Subtasks

- [ ] Update import line
- [ ] Update `buildSut()` cast type
- [ ] Update field reference test from `authStrategy` to `authProcessor`
- [ ] Run `npm run test:unit` to verify

#### Blockers

- L2.1 must complete (AuthRestClient type renames in place).

#### Risks

- Risk: Stub object missing the `inflightMap` field would not satisfy `AuthProcessor`'s public interface. Mitigation: stub is cast through `as unknown as AuthProcessor`; the AuthRestClient only calls `authenticateIfNeeded`, `extendRequest`, `clearAuth` — not `inflightMap` — so the structural-stub pattern continues to work.

#### Complexity

Small

#### Uncertainty Rating

Low

#### Dependencies

- L2.1 (AuthRestClient field/type renames)

#### Integration Points

- Tests gate against the refactored `AuthRestClient`.

#### Definition of Done

- [ ] All subtasks completed
- [ ] All 17 tests pass
- [ ] No `AuthStrategyService` references remain in the spec

#### Verification

**Level:** ✅ Single Judge
**Artifact:** `src/auth/__tests__/auth-rest.client.spec.ts`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Reference Updates | 0.35 | Import switched from `AuthStrategyService` to `AuthProcessor` from `../auth-processor`; `buildSut()` casts stub to `AuthProcessor`; the field-existence assertion reads `authProcessor` not `authStrategy` |
| Test Preservation | 0.30 | All 17 existing tests pass with no behavioural change; `AuthStrategyStub` shape unchanged; assertions on call counts and config arguments unchanged |
| Stub Compatibility | 0.20 | `AuthStrategyStub` cast through `as unknown as AuthProcessor` works because only `authenticateIfNeeded`, `extendRequest`, `clearAuth` are consumed; `inflightMap` not required by `AuthRestClient` |
| No Scope Creep | 0.15 | No new test logic added; only reference renames; spec semantics preserved |

---

### Step 7 (L3.1): Refactor `AuthRestModule.forRootAsync` (class-based DI) [DONE]

**Model:** opus
**Agent:** sdd:developer
**Depends on:** Step 3, Step 5
**Parallel with:** Step 6
**Note:** Steps 6 and 7 both depend on Step 5 (Step 7 also depends on Step 3, satisfied earlier) and MUST be launched in parallel by separate agents.

**Goal**: Replace the `authConfig: AuthConfig` factory pattern with class-based strategy DI: `forRootAsync` accepts a synchronous `authStrategy: Type<AuthStrategy>` token and an async `useFactory` for runtime data; the strategy class is registered via `useClass` self-binding.

#### Expected Output

- `src/auth/auth-rest.module.ts` updated:
  - Drop `AuthConfig` import.
  - Replace `AuthStrategyService` with `AuthProcessor` (import + provider).
  - New `AuthRestModuleOptions` shape (no `authConfig` field):
    ```ts
    interface AuthRestModuleOptions {
      httpService: HttpService
      resilience?: ResilanceConfig<unknown>
    }
    ```
  - New `forRootAsync` signature accepting a top-level `authStrategy: Type<AuthStrategy>` (synchronous) AND `useFactory` (async runtime data):
    ```ts
    static forRootAsync(options: {
      authStrategy: Type<AuthStrategy>
      useFactory: (...args: unknown[]) => Promise<AuthRestModuleOptions> | AuthRestModuleOptions
      inject?: unknown[]
      imports?: unknown[]
    }): DynamicModule
    ```
  - Provider registration order:
    1. `AUTH_MODULE_OPTIONS` token (resolved from `useFactory`)
    2. Strategy self-binding: `{ provide: options.authStrategy, useClass: options.authStrategy }`
    3. `AuthProcessor`: `useFactory: (strategy: AuthStrategy, client: RestClient) => new AuthProcessor(strategy, client), inject: [options.authStrategy, RestClient]`
    4. `AuthRestClient`: `useFactory: (client, processor) => new AuthRestClient(client, processor), inject: [RestClient, AuthProcessor]`
  - `RestModule.forHttpService` import retained for `RestClient` construction.
  - Exports unchanged: `[AuthRestClient, RestModule]`.
  - Updated JSDoc with new options shape, provider order, and `@example` block.

#### Success Criteria

- [X] `AuthConfig` is not imported anywhere in `auth-rest.module.ts`.
- [X] `AuthRestModuleOptions` no longer has `authConfig`.
- [X] `forRootAsync` signature includes synchronous `authStrategy: Type<AuthStrategy>`.
- [X] Strategy class is registered via `useClass` self-binding.
- [X] `AuthProcessor` provider injects strategy via `options.authStrategy` token (NOT a hardcoded class).
- [X] `AuthRestClient` provider injects `AuthProcessor` (renamed from `AuthStrategyService`).
- [X] `npm run typecheck` passes (only `src/index.ts` errors remain — fixed in Step 9).

#### Subtasks

- [X] Drop `AuthConfig` import; remove from `AuthRestModuleOptions` interface
- [X] Update `AuthRestModuleOptions` JSDoc
- [X] Add `Type<AuthStrategy>` import from `@nestjs/common`
- [X] Update `forRootAsync` signature with synchronous `authStrategy: Type<AuthStrategy>`
- [X] Add strategy self-binding provider entry
- [X] Update `AuthProcessor` provider entry (replaces `AuthStrategyService`); inject token is `options.authStrategy`
- [X] Update `AuthRestClient` provider entry to inject `AuthProcessor`
- [X] Update class JSDoc with new wiring story and add `@example` block

#### Blockers

- L1.1 must complete (AuthProcessor class exists).
- L2.1 must complete (AuthRestClient consumes AuthProcessor).

#### Risks

- Risk: `useClass: options.authStrategy` self-binding pattern may not resolve correctly if NestJS has trouble with `Type<T>` tokens that are neither imported decorators (`@Injectable()`) nor explicitly registered. Mitigation: NestJS DI accepts `useClass` self-binding when the class is `@Injectable()` (or when its constructor has no parameters); document in JSDoc that strategy classes MUST carry `@Injectable()` if they have constructor dependencies. Validated by L3.2 sentinel-provider test.
- Risk: `Type<AuthStrategy>` type import path. Mitigation: NestJS exports `Type` from `@nestjs/common`; verify import resolves.
- Risk: `RestModule.forHttpService` factory signature unchanged — but its `useFactory` returns `{ httpService, resilience }` derived from the user's `options.useFactory`; this branch is unchanged from current code.

#### Complexity

Medium

#### Uncertainty Rating

Medium

#### Dependencies

- L1.1 (AuthProcessor class)
- L2.1 (AuthRestClient field/type renames)

#### Integration Points

- Consumed by L3.2 (module unit tests)
- Consumed by L3.3 (index.ts exports verify the module compiles)

#### Definition of Done

- [X] All subtasks completed
- [X] Module compiles against the new options shape
- [ ] Provider chain resolves (verified by L3.2)
- [X] JSDoc updated with `@example` block

#### Verification

**Level:** ✅ CRITICAL - Panel of 2 Judges with Aggregated Voting
**Artifact:** `src/auth/auth-rest.module.ts`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| DI Wiring Correctness | 0.30 | Strategy registered via self-binding `{ provide: options.authStrategy, useClass: options.authStrategy }`; `AuthProcessor` provider resolves strategy via `options.authStrategy` token (NOT a hardcoded class); `AuthRestClient` provider injects `AuthProcessor` and `RestClient` |
| Options Shape | 0.20 | `AuthRestModuleOptions` no longer has `authConfig`; carries `httpService` + optional `resilience`; `forRootAsync` signature has top-level synchronous `authStrategy: Type<AuthStrategy>` plus async `useFactory`/`inject`/`imports` |
| Provider Order | 0.15 | Provider registration order is: 1) `AUTH_MODULE_OPTIONS`, 2) strategy self-bind, 3) `AuthProcessor` (factory injecting strategy + RestClient), 4) `AuthRestClient` (factory injecting RestClient + AuthProcessor); `RestModule.forHttpService` import retained for RestClient construction |
| Type Safety | 0.15 | `Type<AuthStrategy>` imported from `@nestjs/common`; `npm run typecheck` passes; no `any` casts on the wiring path |
| Cleanup | 0.10 | `AuthConfig` import dropped; all `AuthStrategyService` references replaced with `AuthProcessor`; exports remain `[AuthRestClient, RestModule]` |
| JSDoc & @example | 0.10 | New options shape documented; `@example` block illustrates class-based registration with `@Injectable()` strategy and `useFactory` for runtime data |

**Reference Pattern:** `src/client/rest.module.ts` (`forRootAsync` and `forHttpService` wiring patterns)

---

### Step 8 (L3.2): Rewrite `AuthRestModule` unit tests for class-based DI [DONE]

**Model:** opus
**Agent:** sdd:qa-engineer
**Depends on:** Step 7
**Parallel with:** Step 9, Step 12
**Note:** Steps 8, 9, and 12 all depend on Step 7 and MUST be launched in parallel by separate agents.

**Goal**: Verify the refactored `forRootAsync` correctly instantiates the strategy class via DI with full constructor injection access, and that the wired `AuthProcessor` and `AuthRestClient` resolve to the expected instances.

#### Expected Output

- `src/auth/__tests__/auth-rest.module.spec.ts` updated:
  - Remove `createAuthConfigStub()`.
  - Add a class-based `StubAuthStrategy implements AuthStrategy` with simple defaults (returns `true` for `isAuthenticated`, identity for `extendRequest`, no-op for `authenticate` and `invalidate`).
  - Rewrite `bootstrap()` to use new options shape:
    ```ts
    AuthRestModule.forRootAsync({
      authStrategy: StubAuthStrategy,
      useFactory: () => ({ httpService, ...(resilience !== undefined ? { resilience } : {}) }),
    })
    ```
  - NEW test: "instantiates the strategy class via the DI container with access to other providers". Add a sentinel provider (e.g. `{ provide: 'SENTINEL', useValue: 'sentinel-value' }`) and a strategy class that `@Inject('SENTINEL')` reads it; assert `moduleRef.get(StrategyWithDeps).sentinel === 'sentinel-value'`.
  - Update single-source-of-truth invariant: `expect((authRestClient as unknown as { authProcessor: AuthProcessor }).authProcessor).toBeInstanceOf(AuthProcessor)` and assert `restClient` identity.
  - Default-preset and override behavioural tests retained (RestClient wiring path unchanged).

#### Success Criteria

- [X] `bootstrap()` uses new `forRootAsync` shape with `authStrategy: StubAuthStrategy`.
- [X] DI-instantiation invariant verified: `moduleRef.get(StubAuthStrategy)` returns an instance and constructor-injected dependencies resolve.
- [X] Renamed-field invariant verified: `authRestClient.authProcessor instanceof AuthProcessor`.
- [X] All previous behavioural assertions (default-preset wrapped policy shape, override) still pass.
- [X] `npm run test:unit` exits 0 for `auth-rest.module.spec.ts` (10/10 tests pass; unrelated pre-existing failures in `index.spec.ts` and `rest.module.spec.ts` are out of Step 8 scope).

#### Subtasks

- [X] Remove `createAuthConfigStub()` and `AuthConfig` import
- [X] Add `StubAuthStrategy implements AuthStrategy` class
- [X] Rewrite `bootstrap()` factory with new options shape
- [X] Add new test: "instantiates strategy class via DI with sentinel injection"
- [X] Update `single-source-of-truth` field reference (`authStrategy` → `authProcessor`)
- [X] Confirm default-preset/override tests still pass
- [X] Run `npm run test:unit` to verify

#### Blockers

- L3.1 must complete (module refactor in place).

#### Risks

- Risk: `useClass` self-binding may not invoke constructor with deps if `StubAuthStrategy` lacks `@Injectable()`. Mitigation: decorate `StubAuthStrategy` and the sentinel-strategy with `@Injectable()`; NestJS docs require it for constructor injection.
- Risk: jest-it-up coverage floor regression. Mitigation: run `npm run test:cov` after edits; the new sentinel test increases coverage on the wiring path.

#### Complexity

Medium

#### Uncertainty Rating

Medium

#### Dependencies

- L3.1 (module refactor)

#### Integration Points

- Tests gate against the refactored `AuthRestModule.forRootAsync`.

#### Definition of Done

- [X] All subtasks completed
- [X] All tests pass (existing + new sentinel test) — 10/10 tests in `auth-rest.module.spec.ts`
- [X] Coverage floor not regressed (`src/auth/auth-rest.module.ts` at 100% statements/branches/functions/lines)
- [X] `AuthConfig` references removed from spec

#### Verification

**Level:** ✅ Single Judge
**Artifact:** `src/auth/__tests__/auth-rest.module.spec.ts`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| DI Invariant Test | 0.30 | New sentinel-injection test exists: a strategy class with `@Inject('SENTINEL')` constructor parameter receives the registered sentinel value through DI, proving `useClass` self-binding instantiates the strategy with full constructor injection |
| Bootstrap Update | 0.20 | `bootstrap()` uses new options shape with `authStrategy: StubAuthStrategy` and `useFactory` for runtime data; `createAuthConfigStub()` and `AuthConfig` import removed; `StubAuthStrategy` is `@Injectable()` and implements all 4 `AuthStrategy` methods |
| Renamed Field Assertion | 0.20 | Single-source-of-truth invariant verified via `(authRestClient as unknown as { authProcessor: AuthProcessor }).authProcessor instanceof AuthProcessor`; RestClient identity assertion preserved |
| Behavioural Preservation | 0.20 | Default-preset behavioural test (wrapped policy shape) and override test still pass against the refactored module |
| Coverage Floor | 0.10 | jest-it-up coverage floor not regressed; the sentinel test increases wiring-path coverage |

---

### Step 9 (L3.3): Update `src/index.ts` public exports [DONE]

**Model:** haiku
**Agent:** haiku
**Depends on:** Step 3, Step 7
**Parallel with:** Step 8, Step 12
**Note:** Steps 8, 9, and 12 all depend on Step 7 (Step 9 also requires the AuthProcessor file from Step 3, already satisfied) and MUST be launched in parallel by separate agents.

**Goal**: Reflect the public-API shape changes in the package barrel: rename `AuthStrategyService` → `AuthProcessor`; remove `AuthConfig` from the type re-exports.

#### Expected Output

- `src/index.ts` updated:
  - `export { AuthStrategyService } from './auth/auth-strategy.service'` → `export { AuthProcessor } from './auth/auth-processor'`
  - `export type { AuthConfig, AuthStrategy } from './auth/auth.config'` → `export type { AuthStrategy } from './auth/auth.config'`

#### Success Criteria

- [X] `AuthProcessor` is exported from the package barrel.
- [X] `AuthStrategyService` is not exported.
- [X] `AuthConfig` is not exported.
- [X] `AuthStrategy` type is still exported.
- [X] `npm run typecheck` and `npm run build` pass with the new exports.

#### Subtasks

- [X] Update value export line for `AuthProcessor`
- [X] Update type-only export line to remove `AuthConfig`
- [X] Run `npm run typecheck` and `npm run build` to verify

#### Blockers

- L1.1 (AuthProcessor file exists)
- L3.1 (module compiles end-to-end)

#### Risks

- Risk: Downstream consumers importing `AuthConfig` or `AuthStrategyService` fail. Mitigation: pre-1.0 breaking change in scope; e2e and module specs are updated in parallel steps.

#### Complexity

Small

#### Uncertainty Rating

Low

#### Dependencies

- L1.1 (AuthProcessor file exists)
- L3.1 (module refactor)

#### Integration Points

- Public API surface for consumers and e2e tests.

#### Definition of Done

- [X] Subtasks completed
- [X] `npm run typecheck` and `npm run build` pass
- [X] No remaining `AuthConfig` or `AuthStrategyService` exports

#### Verification

**Level:** ❌ NOT NEEDED
**Rationale:** Simple barrel export rename. Success is binary and validated by `npm run typecheck` and `npm run build`. The TypeScript compiler is the schema validator: any export that does not resolve fails the build, and any leftover `AuthConfig`/`AuthStrategyService` import in dependents fails typecheck. No subjective judgement required.

---

### Step 10 (L4.1): Refactor auth e2e test to class-based strategy [DONE]

**Model:** opus
**Agent:** sdd:qa-engineer
**Depends on:** Step 9
**Parallel with:** Step 13 (Step 13 needs Step 7 + Step 11; Step 10 needs Step 9 — both can run after Step 9)

**Goal**: Update the auth e2e suite to use the new `AuthProcessor` + class-based `CountingAuthStrategy` instead of `AuthStrategyService` + `CountingAuthConfig`. Existing test scenarios (success GET, 401 → re-auth retry once) must continue to pass.

#### Expected Output

- `tests/auth-rest-client.e2e.spec.ts` updated:
  - Replace `CountingAuthConfig implements AuthConfig` with `CountingAuthStrategy implements AuthStrategy`. The class holds `callCount`, an internal `authenticated: boolean` flag, and a `bearerToken` constant. `authenticate(client)` increments `callCount` and sets `authenticated = true`; `isAuthenticated()` returns the flag; `extendRequest(c)` merges `Authorization: Bearer test-token-X`; `invalidate()` sets `authenticated = false`.
  - Drop `createBearerStrategy()` helper.
  - Update `buildSut()`:
    ```ts
    const strategy = new CountingAuthStrategy()
    const processor = new AuthProcessor(strategy, restClient)
    const client = new AuthRestClient(restClient, processor)
    return { client, strategy }
    ```
  - Replace `authConfig.callCount` assertions with `strategy.callCount`.
  - Drop imports for `AuthConfig`, `AuthStrategyService`. Add import for `AuthProcessor`.

#### Success Criteria

- [X] `tests/auth-rest-client.e2e.spec.ts` no longer imports `AuthConfig` or `AuthStrategyService`.
- [X] `CountingAuthStrategy` implements the new `AuthStrategy` interface.
- [X] `buildSut()` constructs `AuthProcessor` rather than `AuthStrategyService`.
- [X] Test "successful authenticated GET" passes with `strategy.callCount === 1`.
- [X] Test "HTTP 401 → re-auth → retry once" passes with `strategy.callCount === 2`.
- [X] `npm run test:e2e` exits 0.

#### Subtasks

- [X] Replace `CountingAuthConfig` class with `CountingAuthStrategy implements AuthStrategy`
- [X] Drop `createBearerStrategy()` helper
- [X] Update `buildSut()` to construct `AuthProcessor`
- [X] Update test assertions to reference `strategy.callCount`
- [X] Update imports
- [X] Run `npm run test:e2e` to verify

#### Blockers

- L1.1 (AuthProcessor exists)
- L2.1 (AuthRestClient updated)
- L3.3 (index.ts export)

#### Risks

- Risk: `isAuthenticated()` flag-based logic must correctly transition false → true after `authenticate` and true → false after `invalidate`, so single-flight + 401 retry logic works end-to-end. Mitigation: explicit flag manipulation in the strategy class; covered by both test cases.

#### Complexity

Small

#### Uncertainty Rating

Low

#### Dependencies

- L1.1 (AuthProcessor)
- L2.1 (AuthRestClient)
- L3.3 (public exports)

#### Integration Points

- Validates dynamic-auth flow end-to-end through real HTTP (httpbin).

#### Definition of Done

- [X] All subtasks completed
- [X] Both e2e test cases pass
- [X] `npm run test:e2e` exits 0
- [X] No `AuthConfig` or `AuthStrategyService` references remain

#### Verification

**Level:** ✅ Single Judge
**Artifact:** `tests/auth-rest-client.e2e.spec.ts`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Strategy Refactor Correctness | 0.30 | `CountingAuthStrategy implements AuthStrategy` exposes all 4 methods; flag-based `authenticated: boolean` transitions correctly across `authenticate` (sets true) and `invalidate` (sets false); `callCount` increments on each `authenticate` |
| Test Scenarios Preserved | 0.25 | "successful authenticated GET" passes with `strategy.callCount === 1`; "HTTP 401 → re-auth → retry once" passes with `strategy.callCount === 2`; both scenarios run against the httpbin testcontainer |
| buildSut() Update | 0.20 | `buildSut()` constructs `new AuthProcessor(strategy, restClient)` and `new AuthRestClient(restClient, processor)` explicitly; no `AuthStrategyService` usage |
| Import Cleanup | 0.15 | No `AuthConfig` or `AuthStrategyService` imports; `AuthProcessor` imported from public API; `createBearerStrategy()` helper dropped |
| E2E Health | 0.10 | `npm run test:e2e` exits 0 against the testcontainer; no flakiness introduced |

**Reference Pattern:** Existing `tests/auth-rest-client.e2e.spec.ts` (httpbin GET + 401 retry pattern)

---

### Step 11 (L4.2): Add static-token e2e test (NEW) [DONE]

**Model:** opus
**Agent:** sdd:qa-engineer
**Depends on:** None
**Parallel with:** All other steps except Step 13 and Step 14
**Note:** This step is fully orthogonal to the auth refactor (RestModule is unchanged) and MUST be launched in parallel from the very start of execution.

**Goal**: Verify the README's static-token example works end-to-end: `RestModule.forRootAsync` with `axios.headers.Authorization` produces a `RestClient` that forwards the configured Authorization header on every request.

#### Expected Output

- New file `tests/static-token.e2e.spec.ts`:
  - Bootstraps a `Test.createTestingModule` that imports `RestModule.forRootAsync({ useFactory: () => ({ axios: { baseURL: process.env.TEST_HTTP_BASE_URL, headers: { Authorization: 'Bearer static-token-X' } } }) })`.
  - Calls `restClient.get<{ headers: Record<string, string> }>('/anything')` against httpbin.
  - Asserts `response.status === 200` and `response.data.headers.Authorization === 'Bearer static-token-X'`.

#### Success Criteria

- [ ] `tests/static-token.e2e.spec.ts` exists and runs in the e2e suite.
- [ ] httpbin echoes the `Authorization` header verbatim.
- [ ] Test passes against the running httpbin testcontainer.
- [ ] No imports of `AuthRestModule`, `AuthRestClient`, or `AuthProcessor` (only `RestModule`/`RestClient`).
- [ ] `npm run test:e2e` exits 0.

#### Subtasks

- [ ] Create test file with `Test.createTestingModule` bootstrap
- [ ] Use `RestModule.forRootAsync` with axios headers `Authorization`
- [ ] Inject `RestClient` and call `/anything`
- [ ] Assert echoed Authorization header
- [ ] Run `npm run test:e2e` to verify

#### Blockers

- None (RestModule is unchanged).

#### Risks

- Risk: httpbin response shape for `/anything` may not include the Authorization header under `.headers`. Mitigation: existing `auth-rest-client.e2e.spec.ts` already verifies this contract — it works.
- Risk: `axios.headers` may default to lowercase header names; httpbin may echo with a different casing. Mitigation: assert case-insensitively if needed (e.g. `expect(Object.keys(headers).find(k => k.toLowerCase() === 'authorization'))`).

#### Complexity

Small

#### Uncertainty Rating

Low

#### Dependencies

- None on auth refactor

#### Integration Points

- Validates the static-token user-facing example from the README.

#### Definition of Done

- [ ] All subtasks completed
- [ ] Test passes
- [ ] `npm run test:e2e` exits 0
- [ ] No auth-module imports

#### Verification

**Level:** ✅ Single Judge
**Artifact:** `tests/static-token.e2e.spec.ts`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Bootstrap Correctness | 0.30 | `Test.createTestingModule` imports `RestModule.forRootAsync` with `useFactory: () => ({ axios: { baseURL: process.env.TEST_HTTP_BASE_URL, headers: { Authorization: 'Bearer static-token-X' } } })`; `RestClient` resolved from the resulting module |
| Header Verification | 0.30 | Asserts httpbin echoes the configured `Authorization` header verbatim (`Bearer static-token-X`); response status is 200; case-insensitive comparison if needed for header keys |
| No Auth Module Imports | 0.20 | Test imports only `RestModule`/`RestClient` (and optionally `Test` from `@nestjs/testing`); no imports of `AuthRestModule`, `AuthRestClient`, `AuthProcessor`, or `AuthStrategy` |
| Test Robustness | 0.15 | Uses `process.env.TEST_HTTP_BASE_URL` (or equivalent testcontainer env var); cleans up the testing module; no hard-coded ports |
| E2E Health | 0.05 | `npm run test:e2e` exits 0; test runs in the existing e2e suite without infrastructure changes |

**Reference Pattern:** Existing `tests/auth-rest-client.e2e.spec.ts` (httpbin testcontainer + Test.createTestingModule pattern)

---

### Step 12 (L4.3): Auth-layer JSDoc audit [DONE]

**Model:** sonnet
**Agent:** sdd:tech-writer
**Depends on:** Step 7
**Parallel with:** Step 8, Step 9
**Note:** Steps 8, 9, and 12 all depend on Step 7 and MUST be launched in parallel by separate agents.

**Goal**: Ensure every exported class and public method in `src/auth/` carries at least one JSDoc `@example` block matching the new API.

#### Expected Output

- `src/auth/auth.config.ts` — `AuthStrategy` interface JSDoc has `@example` showing a class implementation.
- `src/auth/auth-processor.ts` — `AuthProcessor` class + every public method (`isAuthenticated`, `authenticateIfNeeded`, `extendRequest`, `clearAuth`) carry `@example` blocks.
- `src/auth/auth-rest.client.ts` — `AuthRestClient` class + `restClient` getter + every inherited verb method documented at class level via `@example`.
- `src/auth/auth-rest.module.ts` — `AuthRestModule` class + `forRootAsync` static method + `AuthRestModuleOptions` interface + `AUTH_MODULE_OPTIONS` symbol carry `@example` blocks.

#### Success Criteria

- [X] Every exported class in `src/auth/` has a JSDoc with `@example`.
- [X] Every public method on those classes has a JSDoc with `@example`.
- [X] Every exported interface/type/symbol in `src/auth/` has a JSDoc with `@example`.
- [X] `npm run lint`, `npm run typecheck`, `npm run build` pass.

#### Subtasks

- [X] Add `@example` to `AuthStrategy` interface JSDoc
- [X] Add `@example` to `AuthProcessor` class + 4 public methods (the 5th, `performAuthenticate`, is private)
- [X] Add `@example` to `AuthRestClient` class + `restClient` getter
- [X] Add `@example` to `AuthRestModule` class + `forRootAsync` static method
- [X] Add `@example` to `AuthRestModuleOptions` interface
- [X] Add `@example` to `AUTH_MODULE_OPTIONS` symbol export
- [X] Run `npm run lint` and `npm run build` to verify

#### Blockers

- L1.1, L2.1, L3.1 must complete (the new shapes must be in place to write accurate `@example` snippets).

#### Risks

- Risk: `@example` snippets drift from real API. Mitigation: copy from the e2e test (L4.1) and module spec (L3.2) which exercise the real shapes.

#### Complexity

Medium

#### Uncertainty Rating

Low

#### Dependencies

- L1.1 (AuthProcessor)
- L2.1 (AuthRestClient)
- L3.1 (AuthRestModule)

#### Integration Points

- IDE hover, generated docs.

#### Definition of Done

- [X] All subtasks completed
- [X] All targeted public surfaces carry `@example`
- [X] `npm run lint`, `npm run typecheck`, `npm run build` pass

#### Verification

**Level:** ✅ Per-File Judges (4 separate evaluations in parallel)
**Artifacts:** `src/auth/auth.config.ts`, `src/auth/auth-processor.ts`, `src/auth/auth-rest.client.ts`, `src/auth/auth-rest.module.ts`
**Threshold:** 4.0/5.0

**Rubric (per file):**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Coverage Completeness | 0.30 | Every exported class, public method, exported interface/type/symbol in this auth file has a JSDoc block containing at least one `@example` |
| Example Accuracy | 0.25 | `@example` snippets reference the new API (`AuthProcessor` not `AuthStrategyService`; `forRootAsync` new shape with `authStrategy: Type<AuthStrategy>`; `AuthStrategy` interface with all 4 methods); no stale `AuthConfig` references |
| Snippet Quality | 0.20 | Examples illustrate typical usage patterns (cross-referenced with the e2e tests in L4.1 and module spec in L3.2); minimal but illustrative |
| No Behavioural Changes | 0.15 | Pure documentation additions; no runtime code modified in this file |
| Lint/Build Health | 0.10 | `npm run lint` and `npm run build` pass after edits to this file |

**Reference Pattern:** Cross-reference with `tests/auth-rest-client.e2e.spec.ts` (post-L4.1) and `src/auth/__tests__/auth-rest.module.spec.ts` (post-L3.2) for accurate snippets

---

### Step 13 (L5.1): Rewrite README for new API + static-token example + guidance note [DONE]

**Model:** opus
**Agent:** sdd:tech-writer
**Depends on:** Step 7, Step 11
**Parallel with:** Step 10 (Step 10 depends on Step 9; Step 13 depends on Step 7 + Step 11 — both can run in parallel after their respective deps complete)

**Goal**: Update the README to document the new class-based `AuthStrategy` API; add a runnable static-token example using `RestModule.forRootAsync`; add the module-choice guidance note in the "Authenticated client" section.

#### Expected Output

- `README.md` updated:
  - "Authenticated client — Bearer token" — example rewritten as a class implementing the new `AuthStrategy` interface, registered via `AuthRestModule.forRootAsync({ authStrategy: BearerStrategy, useFactory })`. Example uses `@Injectable()` + constructor injection.
  - "Authenticated client — Basic auth" — example rewritten as a class implementing `AuthStrategy`.
  - NEW "Static API token via RestModule" subsection (or note in "Authenticated client") with the runnable example matching the task user prompt:
    ```ts
    @Module({
      imports: [
        RestModule.forRootAsync({
          useFactory: (config: ConfigService) => ({
            axios: { baseURL: 'https://api.example.com', headers: { Authorization: `Bearer ${config.get('API_TOKEN')}` } },
          }),
        }),
      ],
      exports: [RestClient],
    })
    ```
  - Guidance note: "For static API tokens, use `RestModule` directly with `axios.headers.Authorization`. For dynamic credentials (token refresh, OAuth flows), use `AuthRestModule`."
  - "API Reference" updates:
    - `AuthStrategyService` → `AuthProcessor` (class + constructor signature + methods).
    - `AuthRestModule.forRootAsync` signature updated to new shape with `authStrategy: Type<AuthStrategy>`.
    - `AuthRestModuleOptions` interface updated (no `authConfig`).
    - `AuthStrategy` interface updated with `authenticate` and `invalidate` methods.
    - Remove `AuthConfig` from API Reference entirely.

#### Success Criteria

- [X] All `AuthConfig` references removed from README.
- [X] All `AuthStrategyService` references replaced with `AuthProcessor`.
- [X] Static-token example present and matches the task user-prompt snippet shape.
- [X] Guidance note present in the "Authenticated client" section.
- [X] `AuthStrategy` interface section documents all four methods.
- [X] No code blocks reference removed APIs.

#### Subtasks

- [X] Rewrite "Authenticated client — Bearer token" example as a class
- [X] Rewrite "Authenticated client — Basic auth" example as a class
- [X] Add "Static API token via RestModule" subsection / note
- [X] Add guidance note in "Authenticated client" section
- [X] Update "API Reference" `AuthProcessor` section
- [X] Update "API Reference" `AuthRestModule.forRootAsync` signature + options interface
- [X] Update "API Reference" `AuthStrategy` interface
- [X] Remove `AuthConfig` section entirely
- [X] Verify all examples typecheck visually against the new API (cross-reference with e2e tests)

#### Blockers

- L1.1, L3.1 must complete (new API shapes must be final).

#### Risks

- Risk: Static-token example diverges from the actual e2e test; readers copy stale code. Mitigation: keep the README example and the e2e test (L4.2) structurally identical; cross-link.

#### Complexity

Medium

#### Uncertainty Rating

Low

#### Dependencies

- L1.1, L3.1, L4.2

#### Integration Points

- User-facing documentation; first impression for adopters.

#### Definition of Done

- [X] All subtasks completed
- [X] No removed-API references remain in README
- [X] All code blocks reference the new API
- [X] Static-token example present and runnable

#### Verification

**Level:** ✅ CRITICAL - Panel of 2 Judges with Aggregated Voting
**Artifact:** `README.md`
**Threshold:** 4.0/5.0

**Rubric:**

| Criterion | Weight | Description |
|-----------|--------|-------------|
| API Accuracy | 0.25 | Bearer-token and Basic-auth examples rewritten as classes implementing the new `AuthStrategy` interface (with `@Injectable()` and constructor injection); `AuthRestModule.forRootAsync` shown with new shape `{ authStrategy: BearerStrategy, useFactory }`; `AuthStrategy` interface section enumerates all 4 methods |
| Static-Token Example | 0.20 | New "Static API token via RestModule" example matches the user-prompt snippet shape and is structurally identical to `tests/static-token.e2e.spec.ts` (L4.2); shows `axios.headers.Authorization` with `ConfigService` injection |
| Guidance Note | 0.15 | Note in the "Authenticated client" section clearly states: static credentials → use `RestModule` directly; dynamic credentials → use `AuthRestModule`; reads naturally and is discoverable on first read |
| Removed-API Cleanup | 0.20 | All `AuthConfig` references removed from README (interface section + code blocks); all `AuthStrategyService` references replaced with `AuthProcessor`; no stale code blocks reference removed APIs |
| API Reference Updates | 0.15 | `AuthProcessor` section documents the new constructor `(strategy: AuthStrategy, client: RestClient)` and methods; `AuthRestModuleOptions` interface updated (no `authConfig`); `forRootAsync` signature updated with `authStrategy: Type<AuthStrategy>` |
| Readability | 0.05 | Examples are clear and copy-pasteable; terminology consistent across README; markdown structure intact |

**Reference Pattern:** Existing README "Authenticated client — Bearer token" / "Authenticated client — Basic auth" sections (style + structure precedent)

---

### Step 14 (L5.2): Test integration verification (final gate) [DONE]

**Model:** opus
**Agent:** sdd:qa-engineer
**Depends on:** All previous steps (Step 1 through Step 13)
**Parallel with:** None — this is the final sequential gate

**Goal**: Confirm the entire refactored codebase passes lint, typecheck, unit tests, e2e tests, and the build, with coverage floor and mutation score not regressed.

#### Expected Output

- `npm run lint` exits 0
- `npm run typecheck` exits 0
- `npm run test:unit` exits 0; `posttest:unit` (jest-it-up) does not regress the existing coverage floor
- `npm run test:e2e` exits 0
- `npm run build` exits 0 with a clean dist
- (Optional documentation step) `npm run test:mutation` does not regress Stryker baseline

#### Success Criteria

- [X] All five mandatory commands exit 0.
- [X] No remaining references to `AuthConfig` or `AuthStrategyService` anywhere in `src/`, `tests/`, or `README.md`.
- [X] Public API exports match the new shape: `AuthProcessor`, `AuthStrategy` (with 4 methods), `AuthRestClient`, `AuthRestModule`, `RestClient`, `RestModule`, `HookableHttpService`, `ResilencePresets`, and the `ResilanceConfig`/`HttpVerb`/`InvokeArgs`/etc. types.
- [X] All public classes and methods carry JSDoc `@example` blocks.

#### Subtasks

- [X] Run `npm run lint`; fix any new lint errors via code restructure (per `.claude/rules/fix-lint-not-suppress.md`)
- [X] Run `npm run typecheck`; fix residual type errors
- [X] Run `npm run test:unit`; fix any failing unit tests
- [X] Run `npm run posttest:unit` to verify jest-it-up does not regress
- [X] Run `npm run test:e2e`; fix any failing e2e tests
- [X] Run `npm run build` to verify clean dist
- [X] Grep for residual `AuthConfig` and `AuthStrategyService` references; address any leftovers
- [ ] (Optional) Run `npm run test:mutation` to confirm Stryker baseline holds

#### Blockers

- All previous steps must complete.

#### Risks

- Risk: jest-it-up posttest fails because removing `authResult`-cache branch tests reduces total branch count; floor was ratcheted up under the old structure. Mitigation: add additional branch tests in L1.2 (e.g. exercising `authenticate` reject path) to compensate; or run `npx jest-it-up --reset` to recompute the floor on the new structure (only if the regression is structural rather than behavioural).
- Risk: Stryker baseline mismatch. Mitigation: documented as optional; if `test:mutation` regresses, file a follow-up rather than block merge.
- Risk: residual `AuthConfig` references in scratchpads/docs. Mitigation: only `src/`, `tests/`, and `README.md` are load-bearing; `.specs/` historical docs may retain them.

#### Complexity

Medium

#### Uncertainty Rating

Medium

#### Dependencies

- All previous steps (L0.1–L5.1)

#### Integration Points

- Final CI gate.

#### Definition of Done

- [X] All five mandatory commands exit 0
- [X] Coverage floor not regressed
- [X] No residual removed-API references in load-bearing paths
- [X] All acceptance criteria from the task spec verifiably pass

#### Verification

**Level:** ❌ NOT NEEDED
**Rationale:** This is a CI verification gate. Success is binary and objectively measured by exit codes from `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run test:e2e`, and `npm run build`. Coverage floor is enforced by `posttest:unit` (jest-it-up). No subjective LLM-as-Judge evaluation is appropriate — the commands themselves are the judges.

---

## Verification Summary

| Step | Verification Level | Judges | Threshold | Artifacts |
|------|-------------------|--------|-----------|-----------|
| 1 (L0.1) | ✅ Panel (2) | 2 | 4.0/5.0 | `src/auth/auth.config.ts` (interface contract) |
| 2 (L0.2) | ✅ Per-File (5) | 5 | 4.0/5.0 | Client-layer JSDoc across 5 files |
| 3 (L1.1) | ✅ Panel (2) | 2 | 4.0/5.0 | `src/auth/auth-processor.ts` (NEW class) |
| 4 (L1.2) | ✅ Single Judge | 1 | 4.0/5.0 | `src/auth/__tests__/auth-processor.spec.ts` |
| 5 (L2.1) | ✅ Single Judge | 1 | 4.0/5.0 | `src/auth/auth-rest.client.ts` (rename refactor) |
| 6 (L2.2) | ✅ Single Judge | 1 | 4.0/5.0 | `src/auth/__tests__/auth-rest.client.spec.ts` |
| 7 (L3.1) | ✅ Panel (2) | 2 | 4.0/5.0 | `src/auth/auth-rest.module.ts` (DI rewiring) |
| 8 (L3.2) | ✅ Single Judge | 1 | 4.0/5.0 | `src/auth/__tests__/auth-rest.module.spec.ts` |
| 9 (L3.3) | ❌ None | - | - | Barrel export rename (typecheck-validated) |
| 10 (L4.1) | ✅ Single Judge | 1 | 4.0/5.0 | `tests/auth-rest-client.e2e.spec.ts` |
| 11 (L4.2) | ✅ Single Judge | 1 | 4.0/5.0 | `tests/static-token.e2e.spec.ts` (NEW) |
| 12 (L4.3) | ✅ Per-File (4) | 4 | 4.0/5.0 | Auth-layer JSDoc across 4 files |
| 13 (L5.1) | ✅ Panel (2) | 2 | 4.0/5.0 | `README.md` |
| 14 (L5.2) | ❌ None | - | - | CI gate (lint/typecheck/test/build exit codes) |

**Total Evaluations:** 23
- Panel of 2 (4 steps × 2): 8 evaluations
- Per-File: Step 2 (5 files) + Step 12 (4 files) = 9 evaluations
- Single Judge (6 steps × 1): 6 evaluations
- No verification: 2 steps (9, 14)

**Implementation Command:** `/implement .specs/tasks/draft/improve-auth-rest-client.feature.md`

---

## Implementation Summary

| Step | L#   | Goal | Output | Est. Effort |
|------|------|------|--------|-------------|
| 1    | L0.1 | Redefine `AuthStrategy` interface; delete `AuthConfig` | `src/auth/auth.config.ts` | S |
| 2    | L0.2 | Client-layer JSDoc audit (`@example` on all public surfaces) | `src/client/*`, `src/resilence.policy.ts` | M |
| 3    | L1.1 | Implement `AuthProcessor` class | `src/auth/auth-processor.ts` (NEW) | S |
| 4    | L1.2 | Write `AuthProcessor` unit tests | `src/auth/__tests__/auth-processor.spec.ts` (NEW) | M |
| 5    | L2.1 | Refactor `AuthRestClient` (field/type rename) | `src/auth/auth-rest.client.ts` | S |
| 6    | L2.2 | Update `AuthRestClient` unit tests | `src/auth/__tests__/auth-rest.client.spec.ts` | S |
| 7    | L3.1 | Refactor `AuthRestModule.forRootAsync` (class-based DI) | `src/auth/auth-rest.module.ts` | M |
| 8    | L3.2 | Rewrite `AuthRestModule` unit tests | `src/auth/__tests__/auth-rest.module.spec.ts` | M |
| 9    | L3.3 | Update `src/index.ts` public exports | `src/index.ts` | S |
| 10   | L4.1 | Refactor auth e2e test (CountingAuthStrategy class) | `tests/auth-rest-client.e2e.spec.ts` | S |
| 11   | L4.2 | Add static-token e2e test (NEW) | `tests/static-token.e2e.spec.ts` (NEW) | S |
| 12   | L4.3 | Auth-layer JSDoc audit | `src/auth/*` | M |
| 13   | L5.1 | Rewrite README (auth + static-token + guidance note) | `README.md` | M |
| 14   | L5.2 | Test integration verification (final gate) | CI commands all pass | M |

**Total Steps**: 14
**Critical Path**: Step 1 (L0.1) → Step 3 (L1.1) → Step 5 (L2.1) → Step 7 (L3.1) → Step 9 (L3.3) → Step 14 (L5.2). Each step in this chain blocks downstream work.
**Parallel Opportunities**:
- Step 2 (L0.2 client JSDoc) can run in parallel with ANY phase (orthogonal to auth refactor).
- Step 11 (L4.2 static-token e2e) can run in parallel with Steps 3–9 (depends only on `RestModule`, which is unchanged).
- Within Phase 5: Steps 10, 11, 12 (L4.1, L4.2, L4.3) can run in parallel.
- Within paired steps: L1.2 must follow L1.1 sequentially (TDD pairing); same for L2.2/L2.1, L3.2/L3.1.

---

## Risks & Blockers Summary

### High Priority

| Risk/Blocker | Impact | Likelihood | Mitigation |
|--------------|--------|------------|------------|
| `useClass` self-binding does not invoke constructor injection on consumer strategy class | High | Medium | Decorate consumer strategy classes with `@Injectable()`; document in JSDoc; verify with sentinel-injection test in L3.2 |
| jest-it-up coverage floor regresses after removing `authResult`-cache branches | High | Medium | Add compensating branch tests in L1.2 (exercise `authenticate` reject path); run `npm run test:cov` after every spec edit |
| Single-flight semantics break after removing `authResult` cache | High | Low | `@DeduplicateInflight` continues to gate `performAuthenticate` regardless of guard logic; explicitly tested in L1.2 concurrent test |
| 401 retry semantics break after `clearAuth` delegates to `strategy.invalidate()` | High | Low | E2E test in L4.1 verifies real 401 → re-auth → retry flow against httpbin |
| Stryker mutation baseline regresses | Medium | Medium | Document as optional gate in L5.2; file follow-up rather than block merge |
| README static-token example diverges from e2e test | Medium | Low | Keep README and `tests/static-token.e2e.spec.ts` structurally identical; cross-reference |
| Pre-1.0 breaking change breaks downstream consumers | Medium | High (intentional) | Documented in task scope; pre-1.0 cleanup; no compatibility shims |
| `Type<AuthStrategy>` import path wrong | Low | Low | NestJS exports `Type` from `@nestjs/common`; verified at typecheck time |

---

## Definition of Done (Task Level)

- [X] All 14 implementation steps completed
- [X] All acceptance criteria from the task spec verified
- [X] `npm run lint` exits 0
- [X] `npm run typecheck` exits 0
- [X] `npm run test:unit` exits 0 with jest-it-up floor maintained
- [X] `npm run test:e2e` exits 0
- [X] `npm run build` exits 0 with clean dist
- [X] No remaining references to `AuthConfig` or `AuthStrategyService` in `src/`, `tests/`, or `README.md`
- [X] All public classes and methods carry JSDoc `@example` blocks
- [X] Documentation updated (README + JSDoc)
- [X] No high-priority risks unaddressed
