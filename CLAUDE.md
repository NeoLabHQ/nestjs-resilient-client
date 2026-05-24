# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See @README.md for feature overview and resilience strategy descriptions, and @package.json for scripts and dependencies, and @CONTRIBUTING.md for contribution guidelines.

## Architecture

This library wraps `@nestjs/axios`'s `HttpService` with a [cockatiel](https://github.com/connor4312/cockatiel)-based resilience policy stack. Two HTTP client surfaces, both built on the shared `BaseHttpService` / `HookableHttpService` hierarchy described below:

- **`RestClient`** (`src/client/rest.client.ts`) — extends `HookableHttpService`. Wraps every request in a composed `IPolicy` from cockatiel and forwards the policy `signal` into the per-attempt `AxiosRequestConfig` (composed with any user-supplied `signal` via `AbortSignal.any` when available) so retries/timeouts/circuit-breakers can cancel in-flight axios requests cooperatively across every verb. Constructor signature is `(httpService, config?, hooks?)`; `config` defaults to the `CONSERVATIVE` preset. Also builds the RxJS pipeline once via `buildRxjsPipeline(config)` and forwards it to the base.
- **`AuthRestClient`** (`src/auth/auth-rest.client.ts`) — extends `HookableHttpService`. Composes a `RestClient` (the resilient transport) with an `AuthProcessor` (`src/auth/auth-processor.ts`) that owns the per-request authentication lifecycle: pre-flight `authenticateIfNeeded` (single-flight via `@DeduplicateInflight`), `extendRequest`, dispatch, one-shot 401 recovery (re-extend the *original* args, replay once). NEVER forwards an `rxjsPipeline` to `super(...)` because the underlying `RestClient` transport returns a `Promise`, so the reactive pipeline would silently no-op at this layer.

### Class hierarchy

The verb surface (`request`, `get`, `delete`, `head`, `post`, `put`, `patch`, `postForm`, `putForm`, `patchForm`) is shared via a three-tier inheritance chain rooted in `src/client/hookable-http.service.ts`:

- **`BaseHttpService`** (abstract) — owns the verb surface and routes every call through a protected `dispatch(verb, args)` template method. Splits the verb-specific positional shape (`request(config)` vs `get(url, config)` vs `post(url, data, config)`) inside `callUnderlying` and normalises the upstream return value via `firstValueFrom` (Observable transports) or `await` (Promise transports). Holds an optional `rxjsPipeline` slot consulted only on the reactive path.
- **`HookableHttpService`** (concrete) — accepts an optional `hooks?: HooksConfig` (`onInvoke` / `onReturn` / `onError`) and overrides `dispatch` to bracket `super.dispatch(...)` with that lifecycle. Hooks treat `undefined` as the passthrough sentinel; any other return is a substitute. Constructor signature is `(httpService, hooks?, rxjsPipeline?)`.
- **`RestClient`** (`src/client/rest.client.ts`) — extends `HookableHttpService`. Adds the cockatiel resilience pipeline plus the RxJS pipeline (built once in the constructor via `buildRxjsPipeline(config)` and forwarded to the base) and overrides `dispatch` to wrap `super.dispatch(...)` in `policy.execute(...)`.
- **`AuthRestClient`** (`src/auth/auth-rest.client.ts`) — extends `HookableHttpService`. Composes a `RestClient` (the underlying transport) with an `AuthProcessor` and overrides `dispatch` to run the auth handshake → `extendRequest` → `super.dispatch(...)` → 401-recovery flow. NEVER forwards an `rxjsPipeline` because the underlying transport returns a `Promise`.

### Hooks run INSIDE the resilience pipeline 

`RestClient.dispatch` calls `super.dispatch(verb, argsWithSignal)` from inside `policy.execute(...)`. Because `super.dispatch` is `HookableHttpService.dispatch` (which bracketed `super.dispatch` with `onInvoke` / `onReturn` / `onError`), every retry attempt re-invokes the hook lifecycle. Concretely: a retried request runs `onInvoke` again with the carrier args, observes the (possibly hook-transformed) args on the inner transport call, and routes the response through `onReturn` (or the error through `onError`). This is the AC-21 invariant — DO NOT move the hook layer outside `policy.execute(...)` or it will fire only once per logical request and retries will see stale args.

### RxJS pipeline composition order

`buildRxjsPipeline` (`src/client/rxjs-pipeline.ts`) composes any subset of `{ deduplication, rateLimiter, throttling }` from `ResilanceConfig` into a single `RxjsPipeline`. Composition order, declared OUTERMOST first: `deduplication → rateLimiter → throttling`. The reduction uses `reduceRight` so the first array entry lands as the outermost wrapper — `deduplication` therefore short-circuits BEFORE `rateLimiter` and `throttling` are entered, so cache hits bypass rate-limiting and throttling slots for subsequent callers. Returns `undefined` when none of the three fields is set so the dispatch fast-path stays branch-light. Applied at `BaseHttpService.callUnderlying` on the `Observable<AxiosResponse>` returned by `HttpService` BEFORE `firstValueFrom` — the Promise-returning path (e.g. `RestClient` wrapped by `AuthRestClient`) skips the pipeline entirely. Operator factories are exposed via `rxjsOperatorFactories` (property-access indirection) solely so jest spies can record invocation order.

### Timeout precedence rule

`resolveResilience()` (`src/client/rest.module.ts`) reconciles axios-level and resilience-level timeouts so the two channels never silently shadow each other:

| `axios.timeout` | `opts.resilience` | Returned `resilience`                                      |
| --------------- | ----------------- | ---------------------------------------------------------- |
| `undefined`     | any               | `opts.resilience` unchanged (caller had no opinion)        |
| `0`             | any               | `opts.resilience` unchanged (axios `0` means disabled)     |
| `> 0`           | `undefined`       | `{ ...CONSERVATIVE, timeout: undefined }` (preset stripped) |
| `> 0`           | defined           | `opts.resilience` unchanged (user override preserved)      |

The "axios wins" case strips the CONSERVATIVE preset's per-attempt timeout from the merged config so the cockatiel pipeline does not also enforce a deadline — otherwise an axios `timeout: 5000` would be silently overridden by the preset's `60_000`. `axios.timeout = 0` is the documented "disabled" sentinel and does NOT trigger stripping. When the consumer explicitly passes `resilience`, it is honoured verbatim. The fallback to CONSERVATIVE happens at the call site (`resolveResilience(opts) ?? ResiliencePresets.CONSERVATIVE`) so explicit-undefined and omitted both yield the documented zero-config default. `forHttpService` skips `resolveResilience` because there is no axios.timeout to reconcile against in that delegation path.

### Resilience pipeline

`resiliencePolicyBuilder` (`src/client/resailencePolicyBuilder.ts`) composes any subset of `{ retry, timeout, circuitBreaker, bulkhead, fallback }` from `ResilanceConfig` (`src/client/resilance.config.ts`) into a single policy via cockatiel's `wrap(...)`. Wrap order is significant — outer policies see inner policies' results; the builder applies them in declaration order: retry → timeout → circuitBreaker → bulkhead → fallback. Timeout sits INSIDE retry so each attempt receives its own independent deadline (per-attempt semantics) — a slow attempt is cancelled by the timeout, then retry can issue a fresh attempt with a new timeout window. Empty config returns `NoopPolicy`.

Each sub-builder accepts a polymorphic config field and resolves it to a cockatiel primitive:
- `retry.backoff`: `number` → `ConstantBackoff`, `Array<number>` → `IterableBackoff`, object with `.next()` → backoff factory, else `ExponentialBackoff`.
- `circuitBreaker.breaker`: `number` → `ConsecutiveBreaker`, object with `size` → `CountBreaker`, else `SamplingBreaker`.

### Presets and retry semantics

`resiliencePolicyPresets` (`src/resilience.policy.ts`) exposes `CONSERVATIVE` (default), `RESTFULL`, and `LOW_QUALITY`. Retry eligibility is delegated to `isRetryableError` (`src/shouldRetry.ts`):
- Non-axios errors → retry (treated as parsing/internal).
- Axios errors → retry only if the request method is in the configured allow-list (`SAFE_HTTP_METHODS = GET/HEAD/OPTIONS`; `RESTFULL` extends with PUT/DELETE) **and** the error is a network/internal/5xx error. A `CODE_EXCLUDE_LIST` blocks retry on cancellations and SSL/cert failures.

When adding a new preset, define the `RetryConfig.shouldRetry` against `isRetryableError(error, methods)` rather than re-implementing the method/status logic. Per-preset request timeouts are implemented via cockatiel's `TimeoutPolicy` wrapped INSIDE retry so each attempt is bounded independently — `CONSERVATIVE` 60 s, `RESTFULL` 10 s, `LOW_QUALITY` 180 s applied per attempt. Override or disable by composing a custom `ResilanceConfig` with a different `timeout` value (or omitting the field entirely).

