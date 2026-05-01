# NestJS HTTP Client

Zero-configuration resilience and transient-fault-handling HTTP client that wraps the official `@nestjs/axios` `HttpService` with a [cockatiel](https://github.com/connor4312/cockatiel)-based resilience policy stack. 

> The `cockatiel` library is great reimplementation of famous [Polly](https://github.com/App-vNext/Polly) library for JS/TS ecosystem, but unfortunatelly it is have overcomplicated API, and lacks default preset that can fullfill most of the services retry needs out of the box. This library doing exactly that. You can simply replace default `@nestjs/axios` `HttpService` with `RestClient` and you will get fully resilient HTTP client out of the box.

## Features

- **Zero-configuration resilience** — pragmatic default resilience preset, suitable for the majority of workloads.
- **Composable resilience pipeline** — retry, circuit breaker, bulkhead, and fallback policies can be enabled independently and are wrapped in a single deterministic order.
- **Pluggable authentication** — `AuthRestModule.forRootAsync` accepts a user-supplied class implementing `AuthStrategy` (Bearer, Basic, custom). The strategy is a full DI citizen registered via `useClass` self-binding, so it can constructor-inject `ConfigService` or any other provider. Single-flight authentication, lazy refresh, and one-shot 401 recovery are built in.
- **Idempotency-aware retries** — only safe HTTP methods (`GET`, `HEAD`, `OPTIONS` by default) are retried on 5xx / network errors. Cancellations and SSL/cert failures are excluded from retry.
- **Highly customizable** — fine-grained control over each resilience policy.
- **Promises-based API** — all methods return plain Promises, not Observables. Despite that RXJS is great, people and LLMs much better at writing and reading Promises, rather than Observables.
- **Easy to use** — All clients implement regular axios interface, so you can use them as a drop-in replacement for `@nestjs/axios` `HttpService`. With only difference, that you not need to add `.toPromise()` or `firstValueFrom()` to get the result.

### Resilience Patterns

The default configuration assumes the upstream API is healthy until it is not, and only retries genuinely idempotent requests on transient failures. By default enabled only reactive resilience patterns, with reasonable exceptions, for example Timeout policy. On top of that retry mechanism is work based on type and status of requests. It will try to retry only idempotent requests: GET, HEAD, OPTIONS. And only for 5xx status codes. While PUT, DELETE also considered idempotent in properly implemented RESTfull API, in reality they usualy not. This default strategy is called "Conservative".

Other presets "RESTFULL" and "LOW_QUALITY" trade off retry aggressiveness against the trust you place in the upstream API.

> Presets is based on years of development experience of the authors, rather than theoretical best practices. As a result, they are pragmatic and should work as you need, without need to tweak them for "bad" upstream APIs.

#### Reactive Resilience Patterns

Reactive policies engage *after* a failure response has been received.

- **Retry** — Retry request on failures. Supports: fine-grained control over retry conditions, static and exponential backoff retries on failures.
- **Circuit Breaker** — Stop execution for a period of time after a failure threshold has been reached. Supports: conditional, sampling, count, or consecutive breakers. Configurable half-open recovery window. Allow to configure Stop/Wait strategies.

#### Proactive Resilience Patterns

Proactive policies engage *before* a failure to manage load.

- **Bulkhead** — Limits the number of concurrent calls to the service. Supports semaphore-based concurrency cap with optional queue.
- **Fallback** — Return predefined response on failures. Supports: graceful-degradation value or factory invoked on policy-handled failures fallback.
- **Timeout** — Cancel request after a certain amount of time. Supports: cooperative and aggressive strategies.

## Quick Start


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

> **Note on timeouts.** Temouts is set at policy level, rather at axios level. As a result, axios timeout can override the policy timeout,  but cannot exceed it. If you want to fully override them, change the policy timeout.

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

### Authenticated client

> **Module choice.** For static API tokens, use `RestModule` directly with `axios.headers.Authorization` (see below) — no strategy class, no auth module. For dynamic credentials (token refresh, OAuth flows, anything where `isAuthenticated()` can become `false`), use `AuthRestModule` with a class implementing `AuthStrategy`.

#### Static API token via `RestModule`

When the credential is a long-lived API token (or any value the application never has to refresh), the simplest path is to set `axios.headers.Authorization` on the axios config that `RestModule` forwards to the internally-registered `HttpModule`. Every outbound request inherits the header automatically — no auth module, no strategy class, no 401 retry path.

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

End-to-end coverage for this exact wiring lives in `tests/static-token.e2e.spec.ts`.

#### Authenticated client — Bearer token

`AuthRestModule.forRootAsync` takes a synchronous `authStrategy` class token plus an async `useFactory` that returns the runtime collaborators (`httpService`, optional `resilience`). The class implementing `AuthStrategy` is registered via `useClass` self-binding, so it is a full DI citizen and can constructor-inject any provider available in the surrounding module scope (e.g. `ConfigService`).

The `AuthStrategy` interface declares four methods that together own the full session lifecycle:

- `authenticate(client: RestClient): Promise<void>` — performs the handshake; the `client` argument is a fully resilient `RestClient`, so auth requests reuse the same resilience policy stack as application calls.
- `isAuthenticated(): boolean` — gates whether the next request needs to re-authenticate.
- `extendRequest(config: AxiosRequestConfig): AxiosRequestConfig` — applies the credentials to a request config (must not mutate the input).
- `invalidate(): void` — drops the current session so the next request triggers a fresh handshake; called by `AuthRestClient` after a 401.

```ts
import { Inject, Injectable, Module } from '@nestjs/common'
import { HttpService } from '@nestjs/axios'
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
      // Async: runtime data only — httpService and optional resilience.
      imports: [ConfigModule],
      inject: [HttpService],
      useFactory: (httpService: HttpService) => ({ httpService }),
    }),
  ],
})
export class AppModule {}
```

#### Authenticated client — Basic auth

Basic authentication is just a different `extendRequest` strategy. Because the credentials never expire on a per-session basis, `authenticate` is a no-op and `isAuthenticated` always returns `true` — the strategy class still satisfies all four methods of the `AuthStrategy` interface.

```ts
import { Inject, Injectable } from '@nestjs/common'
import { HttpService } from '@nestjs/axios'
import { ConfigModule, ConfigService } from '@nestjs/config'
import {
  AuthRestModule,
  type AuthStrategy,
  type RestClient,
} from 'nestjs-http-client'
import type { AxiosRequestConfig } from 'axios'

@Injectable()
class BasicAuthStrategy implements AuthStrategy {
  private readonly credentials: string

  constructor(@Inject(ConfigService) config: ConfigService) {
    const user = config.getOrThrow<string>('BASIC_AUTH_USER')
    const pass = config.getOrThrow<string>('BASIC_AUTH_PASS')
    this.credentials = Buffer.from(`${user}:${pass}`).toString('base64')
  }

  // No handshake: the credentials are derived once in the constructor.
  async authenticate(_client: RestClient): Promise<void> {}

  // Static credentials never expire; always authenticated.
  isAuthenticated(): boolean {
    return true
  }

  extendRequest(config: AxiosRequestConfig): AxiosRequestConfig {
    return {
      ...config,
      headers: { ...(config.headers ?? {}), Authorization: `Basic ${this.credentials}` },
    }
  }

  // No cached session to drop, but the contract still requires the method.
  invalidate(): void {}
}

AuthRestModule.forRootAsync({
  authStrategy: BasicAuthStrategy,
  imports: [ConfigModule],
  inject: [HttpService],
  useFactory: (httpService: HttpService) => ({ httpService }),
})
```

Inject `AuthRestClient` into any service. Each request method automatically:

1. Calls `authProcessor.authenticateIfNeeded()` (single-flight; concurrent callers share one handshake).
2. Augments the request via `authProcessor.extendRequest(config)` (which delegates to `strategy.extendRequest`).
3. On a single HTTP 401 response, calls `authProcessor.clearAuth()` (which delegates to `strategy.invalidate()`), re-authenticates, and retries the underlying request once.

```ts
import { Injectable } from '@nestjs/common'
import { AuthRestClient } from 'nestjs-http-client'

@Injectable()
export class OrdersService {
  constructor(private readonly client: AuthRestClient) {}

  async listOrders() {
    const response = await this.client.get<Order[]>('https://api.example.com/orders')
    return response.data
  }
}
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
new RestClient(httpService: HttpService, config?: ResilanceConfig<unknown>)
```

- `httpService` — the upstream `@nestjs/axios` `HttpService`.
- `config` — optional resilience configuration; defaults to `ResilencePresets.CONSERVATIVE`.

Public methods mirror `HttpService`:
`request`, `get`, `delete`, `head`, `post`, `put`, `patch`, `postForm`, `putForm`, `patchForm`. Each returns a `Promise<AxiosResponse<...>>`. The `axiosRef` getter exposes the underlying `AxiosInstance` for adapter-level interop.

#### `AuthRestClient`

Authenticated facade over `RestClient`. Composes a `RestClient` (which owns the resilience policy stack) with an `AuthProcessor` (which orchestrates the authentication lifecycle by delegating to a user-supplied `AuthStrategy`).

```ts
new AuthRestClient(restClient: RestClient, authProcessor: AuthProcessor)
```

Same public method surface as `RestClient`. Each call authenticates first, augments the request via `extendRequest`, and recovers from a single 401.

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

NestJS dynamic module that wires `AUTH_MODULE_OPTIONS`, the user's `AuthStrategy` class (registered via `useClass` self-binding), `RestClient`, `AuthProcessor`, and `AuthRestClient`. Exports `AuthRestClient` and `RestClient`.

```ts
AuthRestModule.forRootAsync(options: {
  authStrategy: Type<AuthStrategy>
  useFactory: (...args: unknown[]) => Promise<AuthRestModuleOptions> | AuthRestModuleOptions
  inject?: unknown[]
  imports?: unknown[]
}): DynamicModule
```

- `authStrategy` — class implementing `AuthStrategy`; used as both the DI token and the `useClass` value (self-binding). Must carry `@Injectable()` if it has constructor dependencies, otherwise NestJS cannot resolve constructor parameter metadata and will throw at module bootstrap.
- `useFactory` — async factory returning `AuthRestModuleOptions` (runtime data only: `httpService`, optional `resilience`).
- `inject` / `imports` — forwarded to the internal `HttpModule.registerAsync` and `RestModule.forHttpService` calls so the factory can depend on any provider exported from `imports` (e.g. `ConfigService`).

`HttpModule` is always imported alongside the caller's `imports`, so factories may `inject: [HttpService]` directly.

#### `RestModule`

NestJS dynamic module that wires `REST_MODULE_OPTIONS`, an internally-managed `HttpModule` (registered with the consumer-supplied axios config), and `RestClient`. Exports `RestClient`.

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
}
```

`AuthRestModule.forRootAsync` accepts a parallel `AuthRestModuleOptions` shape. Note that the strategy *class token* is no longer carried inside this options object — it is passed synchronously as the top-level `authStrategy` field on `forRootAsync`'s argument so the DI container can register it before the async factory resolves.

```ts
interface AuthRestModuleOptions {
  /** Upstream `@nestjs/axios` HTTP transport used by the constructed `RestClient`. */
  httpService: HttpService
  /** Optional resilience policy stack; defaults to the CONSERVATIVE preset when absent. */
  resilience?: ResilanceConfig<unknown>
}
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
}
```

Unlike `forRootAsync`, `forHttpService` does **not** register an internal `HttpModule` — the caller supplies a pre-resolved `HttpService` directly. Use it when a sibling module already constructs and exports the transport (for example `AuthRestModule` itself delegates `RestClient` construction to this method) and you want the canonical `new RestClient(httpService, resilience)` wiring without spinning up a second axios instance. Prefer `forRootAsync` for the typical case where the module should own the `HttpModule` registration.

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

#### `ResilanceConfig<T, S = void, R = unknown>`

Composable resilience configuration. Each field is optional; an empty config produces a `NoopPolicy`.

```ts
interface ResilanceConfig<T, S = void, R = unknown> {
  retry?: RetryConfig<T, S>
  circuitBreaker?: CircuitBreakerConfig
  bulkhead?: BulkheadConfig
  fallback?: FallbackConfig<R>
  timeout?: number | TimeoutConfig
}
```

Sub-types `RetryConfig`, `CircuitBreakerConfig`, `BulkheadConfig`, `FallbackConfig`, and `TimeoutConfig` are exported as type-only aliases; see `src/client/resilance.config.ts` for the full field-level documentation. The `timeout` field accepts either a bare millisecond duration (cooperative cancellation) or a full `TimeoutConfig` for finer-grained control.

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

**Example — all five policies:**

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
}
```

### HookableHttpService

`RestClient` and `AuthRestClient` extend a shared `HookableHttpService` base class that owns the verb surface (`request`, `get`, `delete`, `head`, `post`, `put`, `patch`, `postForm`, `putForm`, `patchForm`). 

```ts

/**
 * Logging facade that records every verb invocation and the resulting status.
 * Wraps a fully resilient `RestClient`, so all calls still go through the
 * underlying retry / circuit-breaker / bulkhead pipeline.
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
      // Forward to the wrapped transport. `super.dispatch` runs the default
      // `callUnderlying` path; calling `this.callUnderlying` directly would
      // bypass any further "around" logic a deeper subclass might add.
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
