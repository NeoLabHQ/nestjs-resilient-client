# NestJS HTTP Client

Zero-configuration resilience and transient-fault-handling HTTP client that wraps the official `@nestjs/axios` `HttpService` with a [cockatiel](https://github.com/connor4312/cockatiel)-based resilience policy stack. 

> The `cockatiel` library is great reimplementation of famous [Polly](https://github.com/App-vNext/Polly) library for JS/TS ecosystem, but unfortunatelly it is have overcomplicated API, and lacks default preset that can fullfill most of the services retry needs out of the box. This library doing exactly that. You can simply replace default `@nestjs/axios` `HttpService` with `RestClient` and you will get fully resilient HTTP client out of the box.

## Features

- **Zero-configuration resilience** — pragmatic default resilience preset, suitable for the majority of workloads.
- **Composable resilience pipeline** — retry, circuit breaker, bulkhead, and fallback policies can be enabled independently and are wrapped in a single deterministic order.
- **RxJS-based traffic shaping** — opt-in `deduplication`, `rateLimiter`, and `throttling` policies implemented as pure RxJS operators on the underlying `HttpService` Observable.
- **Pluggable authentication** — AuthModule accepts custom `AuthStrategy` (Bearer, Basic, etc.), allowing you to define custom authentication approaches for APIs that not support regular auth tokens.
- **Hookable lifecycle** — every client extends `HookableHttpService`, so `onInvoke` / `onReturn` / `onError` callbacks let you transform requests, integrate observability or other custom logic without boilerplate for each method type.
- **Idempotency-aware retries** — only safe HTTP methods (`GET`, `HEAD`, `OPTIONS` by default) are retried on 5xx / network errors. Cancellations and SSL/cert failures are excluded from retry.
- **Highly customizable** — fine-grained control over each resilience policy.
- **Promises-based API** — all methods return plain Promises, not Observables. Despite that RXJS is great, people and LLMs much better at writing and reading Promises, rather than Observables.
- **Easy to use** — All clients implement regular axios interface, so you can use them as a drop-in replacement for `@nestjs/axios` `HttpService`. With only difference, that you no longer need to add `.toPromise()` or `firstValueFrom()` to get the result.

## Quick Start

Install library:

```sh
npm i nestjs-http-client
```

Add module:

```ts
import { Module } from '@nestjs/common'
import { RestModule } from 'nestjs-http-client'

@Module({
  imports: [
    RestModule,
  ],
  exports: [RestModule],
})
export class CatalogModule {}
```

Use client in service:

```ts
import { Injectable } from '@nestjs/common'
import { RestClient } from 'nestjs-http-client'

@Injectable()
export class CatalogService {
  constructor(private readonly client: RestClient) {}

  async getProduct(id: string) {
    // exposes regular axios interface
    // retried up to three times on 5xx / network errors
    const response = await this.client.get<Product>(`https://api.example.com/products/${id}`)
    return response.data
  }

  async createProduct(product: Product) {
    // do not retried by default, because it can be no idempotent, and not safe to retry.
    const response = await this.client.post<Product>(`https://api.example.com/products`, product)
    return response.data
  }
}
```

## Resilience Patterns

The default configuration assumes the upstream API is healthy until it is not, and only retries genuinely idempotent requests on transient failures. By default enabled only reactive resilience patterns, with reasonable exceptions, for example timeout on obviusly too long request. On top of that retry mechanism is work based on type and status of requests. It will try to retry only idempotent requests: GET, HEAD, OPTIONS. And only for 5xx status codes. While PUT, DELETE also considered idempotent in properly implemented RESTfull API, in reality they usualy not. This default strategy is called "Conservative".

Other presets "RESTfull" and "Low Quality" trade off retry aggressiveness against the trust you place in the upstream API.

> Presets is based on years of development experience of the authors, rather than theoretical best practices. As a result, they are pragmatic and should work as you expect, without need to tweak them for "bad" upstream APIs.

### Reactive Resilience Patterns

Reactive policies engage *after* a failure response has been received.

- **Retry** — Retry request on failures. Supports: fine-grained control over retry conditions, static and exponential backoff retries on failures.
- **Circuit Breaker** — Stop execution for a period of time after a failure threshold has been reached. Supports: conditional, sampling, count, or consecutive breakers. Configurable half-open recovery window. Allow to configure Stop/Wait strategies.

### Proactive Resilience Patterns

Proactive policies engage *before* a failure to manage load.

- **Bulkhead** — Limits the number of concurrent calls to the service. Supports semaphore-based concurrency cap with optional queue.
- **Fallback** — Return predefined response on failures. Supports: graceful-degradation value or factory invoked on policy-handled failures fallback.
- **Timeout** — Cancel request after a certain amount of time. Supports: cooperative and aggressive strategies.
- **Deduplication** — Reuse existing request if it is already in flight. As soon as the request completes or errors, the promise is resolved, so sequential calls always trigger a fresh request.
- **Rate Limiter** — Decrease the rate of requests to the upstream using either a token-bucket (burstable) or leaky-bucket (constant rate) strategy.
- **Throttling** — Limit the number of requests to the upstream to a fixed sliding window (e.g. "no more than N per minute"). Excess requests wait in queue and are emitted in the next window.


## Usage

For requests that do not require authentication, `RestModule.forRootAsync` is the shortest path to a fully resilient `RestClient`. It internally registers `HttpModule` with the supplied axios configuration (`baseURL`, `timeout`, default headers, …) and wires the `RestClient` provider for you. When `resilience` is omitted, the `CONSERVATIVE` preset is applied.

```ts
import { Module } from '@nestjs/common'
import { RestModule, ResilencePresets } from 'nestjs-http-client'

@Module({
  imports: [
    RestModule.forRootAsync({
      useFactory: () => ({
        // Forwarded verbatim to the internally-registered HttpModule.
        axios: {
          baseURL: 'https://api.example.com',
        },
        // Optional. Default is CONSERVATIVE preset.
        resilience: ResilencePresets.RESTFULL,
      }),
    }),
  ],
  exports: [RestModule],
})
export class CatalogModule {}
```

`RestModule` exports `RestClient`, so any provider in `CatalogModule` (or modules that import it) can inject `RestClient` directly:

```ts
import { Injectable } from '@nestjs/common'
import { RestClient } from 'nestjs-http-client'

@Injectable()
export class CatalogService {
  constructor(private readonly client: RestClient) {}

  // Resolves to https://api.example.com/products/42
  async getProduct(id: string) {
    const response = await this.client.get<Product>(`/products/${id}`)
    return response.data
  }
}
```

The factory accepts the same `inject`/`imports` keys as any NestJS dynamic module, so axios and resilience configuration can be sourced from `ConfigService` or any other DI provider:

```ts
RestModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    axios: { baseURL: config.get('API_BASE_URL') },
  }),
})
```

## Configuration Strategies

The `CONSERVATIVE` preset is the default. If it is not suitable for you, you can configure resilience pipeline manually, or use one of the following presets:

### Conservative (default)

Reasonable assumptions about an API that mostly follows REST but makes common mistakes.

- Timeout is 60 seconds.
- `GET`, `HEAD`, `OPTIONS` are retried up to 3 times on 5xx and network errors with exponential backoff.
- `PUT`, `DELETE`, `PATCH`, `POST` are NOT retried.
- Sampling circuit breaker with 60 seconds half-open recovery. Enabled only if during 1 minute all requests to service failed with 5xx status code.

### Restfull

Trust the upstream API to honour REST idempotency on `PUT` and `DELETE`.

- Timeout is 10 seconds.
- `GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE` are retried up to 3 times on 5xx and network errors with exponential backoff.
- `PATCH`, `POST` are NOT retried.
- Sampling circuit breaker with 60 seconds half-open recovery. Enabled only if during 1 minute all requests to service failed with 5xx status code.

### Low Quality

Almost identical to `CONSERVATIVE` preset, but with longer timeout.

- Timeout is 180 seconds (3 minutes).
- `GET`, `HEAD`, `OPTIONS` are retried up to 3 times on 5xx and network errors with exponential backoff.
- `PUT`, `DELETE`, `PATCH`, `POST` are NOT retried.
- Sampling circuit breaker with 60 seconds half-open recovery. Enabled only if during 1 minute all requests to service failed with 5xx status code.

### Timeout Precedence

Two timeout channels coexist in the stack: the axios-level `timeout` (applied to every individual HTTP call by axios itself) and the resilience-level `timeout` field on `ResilanceConfig` (applied per attempt by cockatiel's `TimeoutPolicy`, wrapped INSIDE retry). `RestModule.forRootAsync` (and `AuthRestModule.forRootAsync`) reconcile the two channels at module-construction time using the following rule:

| `axios.timeout` | `opts.resilience` | Resulting resilience timeout |
| --------------- | ----------------- | ---------------------------- |
| `undefined`     | any               | `opts.resilience` unchanged (caller had no opinion) |
| `0`             | any               | `opts.resilience` unchanged (axios `0` means "disabled") |
| `> 0`           | `undefined`       | preset `timeout` stripped — axios drives the deadline |
| `> 0`           | defined           | `opts.resilience` unchanged (explicit user override preserved) |

Concretely:

```ts
import { Module } from '@nestjs/common'
import { RestModule } from 'nestjs-http-client'


@Module({
  imports: [
    RestModule.forRootAsync({
      useFactory: () => ({
        axios: {
          baseURL: 'https://api.example.com', 
          // axios.timeout WINS: the CONSERVATIVE preset's 60 s per-attempt timeout is
          // stripped before RestClient is constructed, so the only deadline in effect
          // is axios's 5 s. A request to a 6 s upstream fails after ~5 s with
          // `ECONNABORTED` — no library-level timeout fires earlier or later.
          timeout: 5_000 
          // resilience omitted — axios timeout will be used instead
        },
      }),
    }),
  ],
})
export class FastAxiosTimeoutModule {}

RestModule.forRootAsync({
  useFactory: () => ({
    axios: { timeout: 5_000 },
    // Explicit user resilience.timeout WINS even when axios.timeout is also set:
    // the request fails after ~1 s (the resilience timeout fires first).
    resilience: { timeout: 1_000 },
  }),
})


RestModule.forRootAsync({
  useFactory: () => ({
    axios: { timeout: 0 },
    // axios.timeout: 0 is the documented "disabled" sentinel — it does NOT
    // trigger the strip rule, so the explicit resilience.timeout: 1_500 is
    // honoured. A 3 s upstream request fails after ~1 500 ms.
    resilience: { timeout: 1_500 },
  }),
})
```

| The `forHttpService` delegation hook does NOT run this reconciliation — there is no `axios.timeout` to reconcile against in that path, so the caller's `resilience` is honoured verbatim.

### Bare `RestClient` (no auth, manual wiring)

If you already have an `HttpService` provider (for example shared across multiple modules), construct `RestClient` directly. It accepts a `HttpService` (from `@nestjs/axios`) and an optional `ResilanceConfig`. When the config is omitted, `RestClient` falls back to the `CONSERVATIVE` preset.

```ts
import { HttpModule, HttpService } from '@nestjs/axios'
import { Module } from '@nestjs/common'
import { RestClient } from 'nestjs-http-client'

@Module({
  imports: [HttpModule],
  providers: [
    {
      provide: RestClient,
      useFactory: (http: HttpService) =>
        new RestClient(http),
      inject: [HttpService],
    },
  ],
  exports: [RestClient],
})
export class CatalogModule {}
```

Inject `RestClient` anywhere and call any axios verb. Each call goes through the composed resilience policy:

```ts
import { Injectable } from '@nestjs/common'
import { RestClient } from 'nestjs-http-client'

@Injectable()
export class CatalogService {
  constructor(private readonly client: RestClient) {}

  async getProduct(id: string) {
    const response = await this.client.get<Product>(`/products/${id}`)
    return response.data
  }
}
```

### Building a resilience config from scratch

Compose only the policies you need. Unspecified fields are omitted from the pipeline entirely:

```ts
import { HttpModule, HttpService } from '@nestjs/axios'
import { Module } from '@nestjs/common'
import { RestClient, type ResilanceConfig } from 'nestjs-http-client'
import { isAxiosError } from 'axios'

const customConfig: ResilanceConfig<unknown> = {
  retry: {
    maxAttempts: 5,
    // Constant 200 ms delay between every attempt
    backoff: 200,
    // Only retry on 5xx or network errors (no response at all)
    shouldRetry: (error) =>
      isAxiosError(error) && (!error.response || error.response.status >= 500),
  },
  circuitBreaker: {
    // Open the breaker after 3 consecutive failures
    breaker: 3,
    // Allow one probe request after 30 s
    halfOpenAfter: 30_000,
  },
  bulkhead: {
    // At most 10 concurrent requests; queue up to 20 more
    limit: 10,
    queue: 20,
  },
  // Opt-in RxJS traffic shaping (composed deduplication → rateLimiter → throttling).
  deduplication: {},
  rateLimiter: {
    strategy: 'token-bucket',
    capacity: 10,
    refillRatePerSec: 5,
  },
  throttling: {
    requestsPerInterval: 100,
    intervalMs: 60_000,
  },
}

@Module({
  imports: [
    RestModule.forRootAsync({
      useFactory: () => ({
        axios: {
          baseURL: 'https://api.example.com',
        },
        resilience: customConfig,
      }),
    }),
  ],
  exports: [RestClient],
})
export class DataModule {}
```


#### Deduplication

When several callers issue the same logical request concurrently, `deduplication` shares a single in-flight `Observable` subscription so the upstream sees exactly one network call. The cache entry is evicted as soon as the source completes or errors, so sequential calls always trigger a fresh request. The default cache key is `${verb}:${args.url ?? args.config.url ?? ''}`; supply `keyBuilder` to customise (e.g. include a tenant header).

```ts
import type { ResilanceConfig } from 'nestjs-http-client'

const dedupeConfig: ResilanceConfig<unknown> = {
  deduplication: {
    // Optional: include a tenant header in the cache key so requests for
    // different tenants do not collide.
    keyBuilder: (verb, args) => {
      const tenant = (args.config.headers as Record<string, string> | undefined)?.['X-Tenant'] ?? ''
      return `${tenant}:${verb}:${args.url ?? args.config.url ?? ''}`
    },
  },
}
```

#### Rate Limiter

Smooths the outbound emission rate using either a token-bucket (burstable) or leaky-bucket (constant rate) strategy. `'token-bucket'` allows bursts up to `capacity`, then sustains `refillRatePerSec` requests per second. `'leaky-bucket'` emits at exactly `refillRatePerSec` regardless of arrival pattern.

```ts
import type { ResilanceConfig } from 'nestjs-http-client'

// Allow short bursts of up to 10 requests, then sustain 5 requests/sec.
const tokenBucketConfig: ResilanceConfig<unknown> = {
  rateLimiter: {
    strategy: 'token-bucket',
    capacity: 10,
    refillRatePerSec: 5,
  },
}

// Strict 2 requests/sec regardless of arrival pattern.
const leakyBucketConfig: ResilanceConfig<unknown> = {
  rateLimiter: {
    strategy: 'leaky-bucket',
    capacity: 1,
    refillRatePerSec: 2,
  },
}
```

#### Throttling

Caps the number of emissions allowed within a fixed sliding window (e.g. "no more than 100 requests per minute"). Excess emissions wait for a slot in the next window. Throttling differs from rate-limiting in that it enforces a hard ceiling over a fixed-duration window rather than smoothing cadence over time.

```ts
import type { ResilanceConfig } from 'nestjs-http-client'

// No more than 100 requests per minute.
const throttlingConfig: ResilanceConfig<unknown> = {
  throttling: {
    requestsPerInterval: 100,
    intervalMs: 60_000,
  },
}
```

### Authenticated client

> For static API tokens, use `RestModule` directly with `axios.headers.Authorization`. For dynamic credentials (token refresh, OAuth flows, anything where `isAuthenticated()` can become `false`), use `AuthRestModule` with a class implementing `AuthStrategy`.

#### Static API token via `RestModule`

When the credential is a long-lived API token (or any value the application never has to refresh), the simplest path is to set `axios.headers.Authorization` on the axios config that `RestModule` forwards to the internally-registered `HttpModule`. Every outbound request inherits the header automatically.

```ts
import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { RestModule, RestClient } from 'nestjs-http-client'

@Module({
  imports: [
    RestModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        axios: {
          baseURL: 'https://api.example.com',
          // Forwarded verbatim to the internally-registered HttpModule;
          // every RestClient request inherits this header by default.
          headers: { Authorization: `Bearer ${config.get('API_TOKEN')}` },
        },
      }),
    }),
  ],
  exports: [RestClient],
})
export class CatalogModule {}
```

#### Authenticated client — Bearer token

The `AuthStrategy` interface declares four methods that together own the full session lifecycle:

- `authenticate(client: RestClient): Promise<void>` — performs the handshake; the `client` argument is a fully resilient `RestClient`, so auth requests reuse the same resilience policy stack as application calls.
- `isAuthenticated(): boolean` — gates whether the next request needs to re-authenticate.
- `extendRequest(config: AxiosRequestConfig): AxiosRequestConfig` — applies the credentials to a request config (must not mutate the input).
- `invalidate(): void` — drops the current session so the next request triggers a fresh handshake; called by `AuthRestClient` after a 401.

```ts
import { Inject, Injectable, Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import {
  AuthRestModule,
  RestClient,
  type AuthStrategy,
} from 'nestjs-http-client'
import type { AxiosRequestConfig } from 'axios'

// Strategy classes are full DI citizens — `@Injectable()` enables
// constructor injection of any provider in the module scope.
@Injectable()
class BearerTokenStrategy implements AuthStrategy {
  private token?: string
  private expiresAt = 0

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  async authenticate(client: RestClient): Promise<void> {
    // `client` is a fully resilient RestClient — auth requests reuse the
    // same resilience policy stack (retry, circuit breaker, …) as app calls.
    const response = await client.post<{ access_token: string, expires_in: number }>(
      this.config.getOrThrow('AUTH_TOKEN_URL'),
      {
        grant_type: 'client_credentials',
        client_id: this.config.getOrThrow('AUTH_CLIENT_ID'),
        client_secret: this.config.getOrThrow('AUTH_CLIENT_SECRET'),
      },
    )
    this.token = response.data.access_token
    // Subtract 60 s so the session is refreshed before it actually expires.
    this.expiresAt = Date.now() + response.data.expires_in * 1_000 - 60_000
  }

  isAuthenticated(): boolean {
    return this.token !== undefined && Date.now() < this.expiresAt
  }

  extendRequest(config: AxiosRequestConfig): AxiosRequestConfig {
    return {
      ...config,
      headers: { ...(config.headers ?? {}), Authorization: `Bearer ${this.token}` },
    }
  }

  invalidate(): void {
    this.token = undefined
    this.expiresAt = 0
  }
}

@Module({
  imports: [
    AuthRestModule.forRootAsync({
      // Synchronous: passed to NestJS DI as a class token, registered via
      // `useClass` self-binding so it can resolve its own constructor deps.
      authStrategy: BearerTokenStrategy,
      // Async: runtime data only — axios config, optional resilience, optional hooks.
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        axios: { baseURL: config.getOrThrow('API_BASE_URL') },
      }),
    }),
  ],
})
export class AppModule {}
```

`AuthRestModule` will inject `AuthRestClient` into any service. Each request method automatically:

1. Calls `BearerTokenStrategy.isAuthenticated()`, if it `false`, calls `BearerTokenStrategy.authenticate()` (single request, concurrent callers share same request).
2. Augments the request via `BearerTokenStrategy.extendRequest(config)` 
3. On a single HTTP 401 response, calls `BearerTokenStrategy.invalidate()`, then re-authenticates  `BearerTokenStrategy.authenticate()`, and retries the underlying request once.

```ts
import { Injectable } from '@nestjs/common'
import { AuthRestClient } from 'nestjs-http-client'

@Injectable()
export class OrdersService {
  constructor(private readonly client: AuthRestClient) {}

  async listOrders() {
    // automatically authenticate if needed
    const response = await this.client.get<Order[]>('/orders')
    return response.data
  }
}
```

## Hooks

Every client (`RestClient`, `AuthRestClient`, and the standalone `HookableHttpService`) accepts an optional `hooks?: HooksConfig` constructor argument. Hooks bracket every dispatched method invocation with three optional callbacks:

- `onInvoke(method, args)` — runs BEFORE the underlying transport call. Return a new `InvokeArgs` carrier to replace the args used for dispatch (e.g. attach a correlation header, rewrite the URL); return `undefined` (or `Promise<undefined>`) for passthrough. 
- `onReturn(verb, args, response)` — runs AFTER a successful response. Return a new `AxiosResponse` to replace the response handed to the caller (e.g. redact a sensitive field); return `undefined` for passthrough.
- `onError(verb, args, error)` — runs WHEN the transport (or any inner policy) throws. Return an `AxiosResponse` to suppress the error and resolve with the substituted response (graceful degradation); return `undefined` / `void` to rethrow the original error.

Every hook may be `async` — return values are awaited, so token lookups, instrumentation flushes, and async transformations integrate naturally. `undefined` is the universal "passthrough" sentinel; any other value (including `null`) is treated as a substitute.

**Hooks run INSIDE the resilience pipeline.** Every retry attempt re-invokes the hook lifecycle — a retried request observes hook-transformed args on every attempt rather than just the first. This invariant is what makes `onInvoke` usable for per-attempt concerns like generating a fresh correlation ID per retry.

The `HooksConfig` lives on `RestModuleOptions` (and `AuthRestModuleOptions`, which extends it) so hooks can be wired through the standard DI factory:

```ts
import { Module } from '@nestjs/common'
import { isAxiosError } from 'axios'
import { RestModule, type HooksConfig } from 'nestjs-http-client'

const hooks: HooksConfig = {
  // Attach a correlation ID to every outgoing request — re-invoked per retry
  // attempt because hooks run INSIDE the resilience pipeline.
  onInvoke(_verb, args) {
    return {
      ...args,
      config: {
        ...args.config,
        headers: {
          ...(args.config.headers ?? {}),
          'X-Correlation-Id': crypto.randomUUID(),
        },
      },
    }
  },

  // Redact a sensitive field before the response leaves the client.
  onReturn(_verb, _args, response) {
    if (typeof response.data === 'object' && response.data !== null && 'secret' in response.data) {
      return { ...response, data: { ...(response.data as object), secret: '[REDACTED]' } }
    }
    return undefined // passthrough — keep the original response
  },

  // Suppress 404 errors by substituting an empty payload.
  onError(_verb, _args, error) {
    if (isAxiosError(error) && error.response?.status === 404) {
      return { ...error.response, data: null }
    }
    return undefined // passthrough — rethrow the original error
  },
}

@Module({
  imports: [
    RestModule.forRootAsync({
      useFactory: () => ({
        axios: { baseURL: 'https://api.example.com' },
        hooks,
      }),
    }),
  ],
})
export class CatalogModule {}
```

## Behaviour notes

- **401 retry** — on a single HTTP 401, `AuthRestClient` calls `strategy.invalidate()` via the `AuthProcessor`, re-authenticates, re-extends the *original* args (so a stale `Authorization` header from the failed attempt is replaced), then replays the call exactly once against the underlying transport (which itself runs through the resilience pipeline). A second 401 — or any non-401 error — is rethrown without re-invalidating the strategy.
- **Concurrent authentication** — any number of concurrent authentication attempts result in a single real request to the authentication service. The `AuthProcessor` enforces single-flight semantics via `@DeduplicateInflight` on the underlying `strategy.authenticate(client)` call.
- **Cancellation** — the cockatiel and user `signal` is forwarded into axios. So retries, timeouts, and circuit-breakers can cancel in-flight axios calls cooperatively.

## API Reference

### Classes

#### `RestClient`

Resilient HTTP client. Wraps `@nestjs/axios`'s `HttpService` and runs every request through a composed cockatiel `IPolicy`.

```ts
new RestClient(httpService: HttpService, config?: ResilanceConfig<unknown>, hooks?: HooksConfig)
```

- `httpService` — the upstream `@nestjs/axios` `HttpService`.
- `config` — optional resilience configuration; defaults to `ResilencePresets.CONSERVATIVE`.
- `hooks` — optional `HooksConfig` lifecycle (`onInvoke` / `onReturn` / `onError`) forwarded to `HookableHttpService`.

Public methods mirror `HttpService`:
`request`, `get`, `delete`, `head`, `post`, `put`, `patch`, `postForm`, `putForm`, `patchForm`. Each returns a `Promise<AxiosResponse<...>>`. The `axiosRef` getter exposes the underlying `AxiosInstance` for adapter-level interop.

#### `AuthRestClient`

Authenticated facade over `RestClient`. Composes a `RestClient` (which owns the resilience policy stack) with an `AuthProcessor` (which orchestrates the authentication lifecycle by delegating to a user-supplied `AuthStrategy`).

```ts
new AuthRestClient(restClient: RestClient, authProcessor: AuthProcessor, hooks?: HooksConfig)
```

Same public method surface as `RestClient`. Each call authenticates first, augments the request via `extendRequest`, and recovers from a single 401. The optional `hooks` argument is forwarded to `HookableHttpService` exactly like on `RestClient`.

#### `AuthProcessor`

Orchestrates the per-request authentication lifecycle by delegating every session-state query to an injected `AuthStrategy` class instance. Holds **no** cached `authResult` — the strategy itself owns the session state, and the processor only enforces cross-cutting concerns (single-flight handshake via `@DeduplicateInflight`, pre-flight gating, 401 invalidation).

```ts
new AuthProcessor(strategy: AuthStrategy, client: RestClient)
```

Public methods:

- `isAuthenticated(): boolean` — pure delegation to `strategy.isAuthenticated()`. The processor caches nothing; the strategy is the single source of truth.
- `authenticateIfNeeded(): Promise<void>` — short-circuits when `isAuthenticated()` returns `true`; otherwise triggers a fresh `strategy.authenticate(client)` handshake. Concurrent callers share a single in-flight handshake (single-flight via `@DeduplicateInflight`).
- `extendRequest(config: AxiosRequestConfig): AxiosRequestConfig` — pure delegation to `strategy.extendRequest(config)`. The strategy contract forbids mutating the input.
- `clearAuth(): void` — pure delegation to `strategy.invalidate()`. After this call, `isAuthenticated()` returns `false` and the next `authenticateIfNeeded()` triggers a fresh handshake. Used by `AuthRestClient`'s 401 retry path.

#### `AuthRestModule`

NestJS dynamic module that wires `AUTH_MODULE_OPTIONS`, the user's `AuthStrategy` class (registered via `useClass` self-binding), `RestClient`, `AuthProcessor`, and `AuthRestClient`. Owns its own `HttpModule.registerAsync(...)` lifecycle so the consumer-supplied `axios` config flows through the same path as `RestModule.forRootAsync`. Exports `AuthRestClient` and `RestClient`.

```ts
AuthRestModule.forRootAsync(options: {
  authStrategy: Type<AuthStrategy>
  useFactory: (...args: unknown[]) => Promise<AuthRestModuleOptions> | AuthRestModuleOptions
  inject?: unknown[]
  imports?: unknown[]
}): DynamicModule
```

- `authStrategy` — class implementing `AuthStrategy`; used as both the DI token and the `useClass` value (self-binding). Must carry `@Injectable()` if it has constructor dependencies, otherwise NestJS cannot resolve constructor parameter metadata and will throw at module bootstrap.
- `useFactory` — async factory returning `AuthRestModuleOptions` (runtime data: optional `axios`, optional `resilience`, optional `hooks`).
- `inject` / `imports` — forwarded to the internal `HttpModule.registerAsync` and `RestModule.forHttpService` calls so the factory can depend on any provider exported from `imports` (e.g. `ConfigService`).

#### `RestModule`

NestJS dynamic module that wires `REST_MODULE_OPTIONS`, an internally-managed `HttpModule` (registered with the consumer-supplied axios config), and `RestClient`. Exports `RestClient`. Also valid as a static import (`imports: [RestModule]`) — the class-level `@Module({...})` populates default providers (`HttpService` + `RestClient` with the `CONSERVATIVE` preset) so the zero-config path requires no factory call.

```ts
RestModule.forRootAsync(options: {
  useFactory: (...args: unknown[]) => Promise<RestModuleOptions> | RestModuleOptions
  inject?: unknown[]
  imports?: unknown[]
}): DynamicModule
```

The factory returns a `RestModuleOptions` object:

```ts
interface RestModuleOptions {
  /** Axios configuration forwarded to the internally-registered `HttpModule`. */
  axios?: HttpModuleOptions
  /** Optional resilience policy stack; defaults to the CONSERVATIVE preset when absent. */
  resilience?: ResilanceConfig<unknown>
  /** Optional HooksConfig lifecycle forwarded to RestClient. */
  hooks?: HooksConfig
}
```

`AuthRestModule.forRootAsync` accepts a parallel `AuthRestModuleOptions` shape that extends `RestModuleOptions` directly — every option supported by the unauthenticated module (`axios`, `resilience`, `hooks`) is also available on the authenticated module. Note that the strategy *class token* is no longer carried inside this options object — it is passed synchronously as the top-level `authStrategy` field on `forRootAsync`'s argument so the DI container can register it before the async factory resolves.

```ts
interface AuthRestModuleOptions extends RestModuleOptions {}
```

`HttpModule` is registered asynchronously inside the module, so consumers do not need to import it themselves. The `inject` and `imports` keys are forwarded to the internal `HttpModule.registerAsync` call, so the factory can depend on any provider exported from `imports` (e.g. `ConfigService`).

`RestModule` also exposes a lower-level delegation hook for advanced consumers that already manage their own `HttpService` lifecycle:

```ts
RestModule.forHttpService(options: {
  useFactory: (...args: unknown[]) => Promise<RestFromHttpServiceOptions> | RestFromHttpServiceOptions
  inject?: unknown[]
  imports?: unknown[]
}): DynamicModule

interface RestFromHttpServiceOptions {
  /** Pre-resolved `@nestjs/axios` transport handed to the constructed `RestClient`. */
  httpService: HttpService
  /** Optional resilience policy stack; defaults to the CONSERVATIVE preset when absent. */
  resilience?: ResilanceConfig<unknown>
  /** Optional HooksConfig lifecycle forwarded to RestClient. */
  hooks?: HooksConfig
}
```

Unlike `forRootAsync`, `forHttpService` does **not** register an internal `HttpModule` — the caller supplies a pre-resolved `HttpService` directly. Use it when a sibling module already constructs and exports the transport (for example `AuthRestModule` itself delegates `RestClient` construction to this method) and you want the canonical `new RestClient(httpService, resilience, hooks)` wiring without spinning up a second axios instance. Prefer `forRootAsync` for the typical case where the module should own the `HttpModule` registration.

### Configuration types

#### `AuthStrategy`

Strategy that owns the full lifecycle of an authentication session: performing the initial handshake, reporting whether the cached credentials are still valid, attaching them to outgoing requests, and invalidating the session when it has been rejected by the upstream service. Implementations are user-supplied classes registered with `AuthRestModule` via `authStrategy: Type<AuthStrategy>`.

```ts
interface AuthStrategy {
  /**
   * Performs the authentication handshake and stores the resulting session
   * state on the implementation instance itself. Called inside a
   * single-flight wrapper, so concurrent callers share one in-flight
   * handshake. The `client` is a fully resilient `RestClient`, so auth
   * requests reuse the same resilience policy stack as application calls.
   */
  authenticate(client: RestClient): Promise<void>

  /**
   * Returns `true` while the current credentials are still considered valid.
   * Must return `false` when no session has been established yet or after
   * `invalidate()` has been called.
   */
  isAuthenticated(): boolean

  /**
   * Returns a NEW `AxiosRequestConfig` with authentication material applied.
   * MUST NOT mutate the input — callers may reuse the original config.
   */
  extendRequest(config: AxiosRequestConfig): AxiosRequestConfig

  /**
   * Drops the current session so the next request triggers a fresh
   * `authenticate()` call. Invoked by `AuthRestClient` after the upstream
   * service rejects a request with HTTP 401.
   */
  invalidate(): void
}
```

#### `HooksConfig`

Lifecycle hooks that wrap a single verb invocation. Every field is optional. `undefined` (or `Promise<undefined>`) is the universal passthrough sentinel; any other return value is treated as a substitute. See the [Hooks](#hooks) section above for usage examples.

```ts
interface HooksConfig {
  onInvoke?: (
    verb: HttpVerb,
    args: InvokeArgs,
  ) => InvokeArgs | Promise<InvokeArgs> | undefined | Promise<undefined>

  onReturn?: (
    verb: HttpVerb,
    args: InvokeArgs,
    response: AxiosResponse,
  ) => AxiosResponse | Promise<AxiosResponse> | undefined | Promise<undefined>

  onError?: (
    verb: HttpVerb,
    args: InvokeArgs,
    error: unknown,
  ) => AxiosResponse | Promise<AxiosResponse> | undefined | Promise<undefined> | void
}
```

#### `ResilanceConfig<T, S = void, R = unknown>`

Composable resilience configuration. Each field is optional; an empty config produces a `NoopPolicy`.

```ts
interface ResilanceConfig<T, S = void, R = unknown> {
  retry?: RetryConfig<T, S>
  circuitBreaker?: CircuitBreakerConfig
  bulkhead?: BulkheadConfig
  fallback?: FallbackConfig<R>
  timeout?: number | TimeoutConfig
  deduplication?: DeduplicationConfig
  rateLimiter?: RateLimiterConfig
  throttling?: ThrottlingConfig
}
```

Sub-types `RetryConfig`, `CircuitBreakerConfig`, `BulkheadConfig`, `FallbackConfig`, `TimeoutConfig`, `DeduplicationConfig`, `RateLimiterConfig`, and `ThrottlingConfig` are exported as type-only aliases; see `src/client/resilance.config.ts` for the full field-level documentation. The `timeout` field accepts either a bare millisecond duration (cooperative cancellation) or a full `TimeoutConfig` for finer-grained control.

**Example — retry only:**

```ts
import { ExponentialBackoff } from 'cockatiel'
import type { ResilanceConfig } from 'nestjs-http-client'

const retryOnlyConfig: ResilanceConfig<unknown> = {
  retry: {
    maxAttempts: 3,
    backoff: new ExponentialBackoff(),
  },
}
```

**Example — retry + circuit breaker:**

```ts
import { ExponentialBackoff } from 'cockatiel'
import type { ResilanceConfig } from 'nestjs-http-client'

const retryWithBreakerConfig: ResilanceConfig<unknown> = {
  retry: {
    maxAttempts: 3,
    backoff: new ExponentialBackoff(),
  },
  circuitBreaker: {
    // Open after 5 consecutive failures; probe again after 30 s.
    breaker: 5,
    halfOpenAfter: 30_000,
  },
}
```

**Example — full pipeline (cockatiel + RxJS):**

```ts
import type { ResilanceConfig } from 'nestjs-http-client'

const fullyConfigured: ResilanceConfig<unknown, void, string> = {
  retry: {
    maxAttempts: 3,
    // Array-based backoff: 100 ms, then 500 ms, then 500 ms for all further attempts.
    backoff: [100, 500],
  },
  circuitBreaker: {
    // SamplingBreaker: open when ≥ 50 % of requests over 30 s window fail.
    breaker: { threshold: 0.5, duration: 30_000, minimumRps: 10 },
    halfOpenAfter: 60_000,
  },
  bulkhead: {
    limit: 20,
    queue: 40,
  },
  fallback: {
    valueOrFactory: 'service-unavailable',
  },
  // Per-attempt deadline: every retry attempt is bounded by its own 30 s window.
  timeout: 30_000,
  // RxJS traffic shaping (composed deduplication → rateLimiter → throttling).
  deduplication: {},
  rateLimiter: {
    strategy: 'token-bucket',
    capacity: 10,
    refillRatePerSec: 5,
  },
  throttling: {
    requestsPerInterval: 100,
    intervalMs: 60_000,
  },
}
```

### HookableHttpService

`HookableHttpService` — accepts an optional `hooks?: HooksConfig` and overrides `dispatch` to bracket `super.dispatch(...)` with `onInvoke` / `onReturn` / `onError`. Constructor signature: `(httpService, hooks?, rxjsPipeline?)`.

Subclasses extend whichever layer matches the responsibility you need:

```ts
import type { AxiosResponse } from 'axios'
import type { HttpService } from '@nestjs/axios'
import { Injectable } from '@nestjs/common'
import {
  HookableHttpService,
  type HttpVerb,
  type InvokeArgs,
} from 'nestjs-http-client'

/**
 * Logging facade that records every verb invocation and the resulting status.
 * Wraps a fully resilient `RestClient`-compatible transport, so all calls still
 * go through the underlying retry / circuit-breaker / bulkhead pipeline.
 */
@Injectable()
export class LoggingRestClient extends HookableHttpService {
  constructor(client: HttpService) {
    super(client)
  }

  protected override async dispatch<T = unknown>(
    verb: HttpVerb,
    args: InvokeArgs,
  ): Promise<AxiosResponse<T>> {
    const startedAt = Date.now()
    try {
      // Forward to the wrapped transport. `super.dispatch` runs the hooks
      // lifecycle (onInvoke / onReturn / onError) and then the default
      // `callUnderlying` path.
      const response = await super.dispatch<T>(verb, args)
      const elapsedMs = Date.now() - startedAt
      console.log(
        `[http] ${verb.toUpperCase()} ${args.url ?? args.config.url} -> ${response.status} (${elapsedMs} ms)`,
      )
      return response
    }
    catch (error) {
      const elapsedMs = Date.now() - startedAt
      console.error(
        `[http] ${verb.toUpperCase()} ${args.url ?? args.config.url} failed after ${elapsedMs} ms`,
        error,
      )
      throw error
    }
  }
}
```

## Special Thanks

Library essentially is a re-implementation of the following libraries for NestJS:

- [Resilience4j](https://github.com/resilience4j/resilience4j)
- [Polly](https://github.com/App-vNext/Polly) — and the great article on [resilience patterns](https://github.com/App-vNext/Polly/wiki/Transient-fault-handling-and-proactive-resilience-engineering)
- [Failsafe](https://github.com/failsafe-lib/failsafe)
- [Tenacity](https://github.com/jd/tenacity)
- [Gobreaker](https://github.com/sony/gobreaker)

Patterns implementation is based on or uses the following libraries:

- [Cockatiel](https://github.com/connor4312/cockatiel)
- [Opossum](https://github.com/nodeshift/opossum)
- [Axios Retry](https://github.com/softonic/axios-retry)
- [Ofetch](https://github.com/unjs/ofetch)
- [Keyv](https://github.com/jaredwray/keyv)
- [P-Retry](https://github.com/sindresorhus/p-retry)
- [NestJS Resilience](https://github.com/SocketSomeone/nestjs-resilience)
- [NestJS OpenTelemetry](https://github.com/MetinSeylan/Nestjs-OpenTelemetry)
- [NestJS OTEL](https://github.com/pragmaticivan/nestjs-otel)
- [NestJS Omacache](https://github.com/BJS-kr/nestjs-omacache)
- [NestJS HTTP Promise](https://github.com/benhason1/nestjs-http-promise)
