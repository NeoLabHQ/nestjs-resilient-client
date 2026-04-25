# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See @README.md for feature overview and resilience strategy descriptions, and @package.json for scripts and dependencies.

## Architecture

This library wraps `@nestjs/axios`'s `HttpService` with a [cockatiel](https://github.com/connor4312/cockatiel)-based resilience policy stack. Two HTTP client surfaces:

- **`HttpClient`** (`src/client/http.client.ts`) — thin wrapper around `HttpService` that runs every request through a composed `IPolicy` from cockatiel. Constructor takes a `ResilanceConfig`; defaults to the `CONSERVATIVE` preset. The Observable returned by `HttpService` is unwrapped via `firstValueFrom` inside `policy.execute`. The `signal` from cockatiel's policy context is forwarded to axios on the generic `request()` path so retries/circuit-breakers can cancel in-flight requests — the per-method helpers (`get`, `post`, …) currently do not forward the signal.
- **`AuthenticatedHttpService`** (`src/auth/authenticated-http.service.ts`) — separate, older client with token lifecycle (`OnModuleInit` → authenticate, refresh 60s before expiry, single-flight via `authenticationPromise`, 401 → re-auth retry). Uses `p-retry` directly rather than the cockatiel pipeline. Treat this as a parallel implementation, not part of the `HttpClient` resilience flow.

### Resilience pipeline

`resiliencePolicyBuilder` (`src/client/resailencePolicyBuilder.ts`) composes any subset of `{ retry, circuitBreaker, bulkhead, fallback }` from `ResilanceConfig` (`src/client/resilance.config.ts`) into a single policy via cockatiel's `wrap(...)`. Wrap order is significant — outer policies see inner policies' results; the builder applies them in declaration order: retry → circuitBreaker → bulkhead → fallback. Empty config returns `NoopPolicy`.

Each sub-builder accepts a polymorphic config field and resolves it to a cockatiel primitive:
- `retry.backoff`: `number` → `ConstantBackoff`, `Array<number>` → `IterableBackoff`, object with `.next()` → backoff factory, else `ExponentialBackoff`.
- `circuitBreaker.breaker`: `number` → `ConsecutiveBreaker`, object with `size` → `CountBreaker`, else `SamplingBreaker`.

### Presets and retry semantics

`resiliencePolicyPresets` (`src/resilence.policy.ts`) exposes `CONSERVATIVE` (default), `RESTFULL`, and `LOW_QUALITY`. Retry eligibility is delegated to `isRetryableError` (`src/shouldRetry.ts`):
- Non-axios errors → retry (treated as parsing/internal).
- Axios errors → retry only if the request method is in the configured allow-list (`SAFE_HTTP_METHODS = GET/HEAD/OPTIONS`; `RESTFULL` extends with PUT/DELETE) **and** the error is a network/internal/5xx error. A `CODE_EXCLUDE_LIST` blocks retry on cancellations and SSL/cert failures.

When adding a new preset, define the `RetryConfig.shouldRetry` against `isRetryableError(error, methods)` rather than re-implementing the method/status logic. The README's documented per-preset timeouts are not yet implemented in the policy presets — timeout is currently set on the underlying axios instance by the consumer.

