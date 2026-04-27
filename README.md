# NestJS HTTP Client

Zero-configuration resilience and transient-fault-handling HTTP client that wraps the official `@nestjs/axios` `HttpService` with a [cockatiel](https://github.com/connor4312/cockatiel)-based resilience policy stack.

## Features

- **Zero-configuration resilience** — sensible `CONSERVATIVE` preset enabled by default; suitable for the majority of workloads.
- **Composable resilience pipeline** — retry, circuit breaker, bulkhead, and fallback policies can be enabled independently and are wrapped in a single deterministic order.
- **Pluggable authentication** — `AuthRestModule.forRootAsync` accepts a user-supplied `authenticate` callback that returns an `AuthStrategy` (Bearer, Basic, custom). Single-flight authentication, lazy refresh, and one-shot 401 recovery are built in.
- **Idempotency-aware retries** — only safe HTTP methods (`GET`, `HEAD`, `OPTIONS` by default) are retried on 5xx / network errors. Cancellations and SSL/cert failures are excluded from retry.
- **Cockatiel signal forwarding** — the cockatiel policy `signal` is forwarded into axios on the generic `request()` path so retries and circuit breakers can cancel in-flight requests.

### Resilience Patterns


The default configuration assumes the upstream API is healthy until it is not, and only retries genuinely idempotent requests on transient failures. By default enabled only reactive resilience patterns, with reasonable exceptions, for example Timeout policy. On top of that retry mechanism is work based on type and status of requests. It will try to retry only idempotent requests: GET, HEAD, OPTIONS. And only for 5xx status codes. While PUT, DELETE also considered idempotent in properly implemented RESTfull API, in reality they usualy not. This default strategy is called "Conservative".

Other presets "RESTFULL" and "LOW_QUALITY" trade off retry aggressiveness against the trust you place in the upstream API.

#### Reactive Resilience Patterns

Reactive policies engage *after* a failure response has been received.

- **Retry** — exponential backoff with cockatiel's decorrelated jitter; `shouldRetry` is method- and status-aware via `isRetryableError`.
- **Circuit Breaker** — sampling, count, or consecutive breakers; configurable half-open recovery window.

#### Proactive Resilience Patterns

Proactive policies engage *before* a failure to manage load.

- **Bulkhead** — semaphore-based concurrency cap with optional queue.
- **Fallback** — graceful-degradation value or factory invoked on policy-handled failures.

## Quick Start

### Bare `RestClient` (no auth)

For requests that do not require authentication, construct `RestClient` directly. It accepts a `HttpService` (from `@nestjs/axios`) and an optional `ResilanceConfig`. When the config is omitted, `RestClient` falls back to the `CONSERVATIVE` preset.

```ts
import { HttpModule, HttpService } from '@nestjs/axios'
import { Module } from '@nestjs/common'
import {
  RestClient,
  ResilencePresets,
  resiliencePolicyPresets,
} from 'nestjs-http-client'

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

// TODO: add example where base domain is set in httpService, and then used in client.
// TODO: add example where reslience config is set from RESTFUL preset. And example where config build from scratch.

### Authenticated client — Bearer token

`AuthRestModule.forRootAsync` accepts a factory that returns the runtime collaborators (`httpService`, `authConfig`, optional `resilanceConfig`). The `authConfig.authenticate(client)` callback receives a fully resilient `RestClient` and must resolve to an `AuthStrategy`.

```ts
import { HttpModule, HttpService } from '@nestjs/axios'
import { Module } from '@nestjs/common'
import { AuthRestModule, type AuthStrategy } from 'nestjs-http-client'

@Module({
  imports: [
    HttpModule,
    AuthRestModule.forRootAsync({
      imports: [HttpModule],
      inject: [HttpService],
      useFactory: (httpService: HttpService) => ({
        httpService,
        authConfig: {
          // TODO: example is incorrect, it should recive RestClient, instead of HttpService. Add test for this case, fix it if it not works.
          authenticate: async (client): Promise<AuthStrategy> => {
            const tokenResponse = await client.post<{ access_token: string, expires_in: number }>(
              'https://auth.example.com/oauth/token',
              { grant_type: 'client_credentials', client_id: '...', client_secret: '...' },
            )

            const { access_token, expires_in } = tokenResponse.data
            const expiresAt = Date.now() + expires_in * 1000

            return {
              isAuthenticated: () => Date.now() < expiresAt - 60_000,
              extendRequest: (config) => ({
                ...config,
                headers: { ...(config.headers ?? {}), Authorization: `Bearer ${access_token}` },
              }),
            }
          },
        },
      }),
    }),
  ],
})
export class AppModule {}
```

### Authenticated client — Basic auth

Basic authentication is just a different `extendRequest` strategy. Because the credentials never expire on a per-session basis, `isAuthenticated` returns `true` once a strategy has been produced.

```ts
import { AuthRestModule, type AuthStrategy } from 'nestjs-http-client'

AuthRestModule.forRootAsync({
  inject: [HttpService],
  useFactory: (httpService: HttpService) => ({
    httpService,
    authConfig: {
      authenticate: async (): Promise<AuthStrategy> => {
        const credentials = Buffer.from('user:pass').toString('base64')
        return {
          isAuthenticated: () => true,
          extendRequest: (config) => ({
            ...config,
            headers: { ...(config.headers ?? {}), Authorization: `Basic ${credentials}` },
          }),
        }
      },
    },
  }),
})
```

Inject `AuthRestClient` into any service. Each request method automatically:

1. Calls `authStrategy.authenticateIfNeeded()` (single-flight; concurrent callers share one handshake).
2. Augments the request via `authStrategy.extendRequest(config)`.
3. On a single HTTP 401 response, drops the cached strategy, re-authenticates, and retries the underlying request once.

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

## Configuration Strategies

The `CONSERVATIVE` preset is the default. Switch presets by passing
`resiliencePolicyPresets[ResilencePresets.<NAME>]` as `resilanceConfig` to
`AuthRestModule.forRootAsync` or as the second `RestClient` constructor argument.

### Conservative (default)

Reasonable assumptions about an API that mostly follows REST but makes common mistakes.

- Timeout is 60 seconds.
- `GET`, `HEAD`, `OPTIONS` are retried up to 3 times on 5xx and network errors with exponential backoff.
- `PUT`, `DELETE`, `PATCH`, `POST` are NOT retried.
- Sampling circuit breaker with 60 s half-open recovery.

### Restfull

Trust the upstream API to honour REST idempotency on `PUT` and `DELETE`.

- Timeout is 10 seconds.
- `GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE` are retried up to 3 times on 5xx and network errors with exponential backoff.
- `PATCH`, `POST` are NOT retried.
- Sampling circuit breaker with 60 s half-open recovery.

### Low Quality

Same retry surface as `CONSERVATIVE`; named separately so consumers can extend it with longer timeouts at the axios layer.

- Timeout is 180 seconds (3 minutes).
- `GET`, `HEAD`, `OPTIONS` are retried up to 3 times on 5xx and network errors with exponential backoff.
- `PUT`, `DELETE`, `PATCH`, `POST` are NOT retried.
- Sampling circuit breaker with 60 s half-open recovery.

> **Note on timeouts.** Per-preset request timeouts are not yet implemented in the policy presets. Configure `timeout` on the underlying axios instance through `HttpModule.register({ timeout: ... })` or by passing `config.timeout` per request.

## Behaviour notes

- **401 retry** — `AuthRestClient` retries (amount depends on resilience configuration) after a 401: drops the cached strategy, re-authenticates, re-extends the *original* args (so a stale `Authorization` header from the failed attempt is replaced), then re-invokes the wrapped `RestClient` method. Non-401 errors are rethrown without touching the cached strategy.
- **Concurrent authentication** — any number of concurrent authentication attempts result in single real request to authentication service.
- **Cancellation** — the cockatiel `signal` is forwarded into axios on the generic `request()` path. The per-method helpers (`get`, `post`, ...) currently do not forward the signal. // TODO: make them forward the signal.

## API Reference

### Classes

#### `RestClient`

Resilient HTTP client. Wraps `@nestjs/axios`'s `HttpService` and runs every request through a composed cockatiel `IPolicy`.

```ts
new RestClient(httpService: HttpService, config?: ResilanceConfig<unknown>)
```

- `httpService` — the upstream `@nestjs/axios` `HttpService`.
- `config` — optional resilience configuration; defaults to `resiliencePolicyPresets[ResilencePresets.CONSERVATIVE]`.

Public methods mirror `HttpService`:
`request`, `get`, `delete`, `head`, `post`, `put`, `patch`, `postForm`, `putForm`, `patchForm`. Each returns a `Promise<AxiosResponse<...>>`. The `axiosRef` getter exposes the underlying `AxiosInstance` for adapter-level interop.

#### `AuthRestClient`

Authenticated facade over `RestClient`. Composes a `RestClient` (which owns the resilience policy stack) with an `AuthStrategyService` (which owns the authentication lifecycle) and decorates every request method with `@Authenticate`.

```ts
new AuthRestClient(restClient: RestClient, authStrategy: AuthStrategyService)
```

Same public method surface as `RestClient`. Each call authenticates first, augments the request via `extendRequest`, and recovers from a single 401.

#### `AuthStrategyService`

Owns the authentication lifecycle for an `AuthRestClient`.

```ts
new AuthStrategyService(authConfig: AuthConfig, client: RestClient)
```

Public methods:

- `authenticateIfNeeded(): Promise<void>` — re-authenticates only when the cached strategy is missing or has reported `isAuthenticated() === false`. Concurrent callers share a single in-flight handshake.
- `extendRequest(config: AxiosRequestConfig): AxiosRequestConfig` — delegates to the cached strategy. Returns the input untouched when no strategy is cached.
- `clearAuth(): void` — invalidates the cached strategy.
- `isAuthenticated(): boolean` — `true` only when a cached strategy exists *and* its own `isAuthenticated()` reports valid.

#### `AuthRestModule`

NestJS dynamic module that wires `AUTH_MODULE_OPTIONS`, `RestClient`, `AuthStrategyService`, and `AuthRestClient`. Exports `AuthRestClient` and `RestClient`.

```ts
AuthRestModule.forRootAsync(options: {
  useFactory: (...args: unknown[]) => Promise<AuthRestModuleOptions> | AuthRestModuleOptions
  inject?: unknown[]
  imports?: unknown[]
}): DynamicModule
```

`HttpModule` is always imported alongside the caller's `imports`, so factories may `inject: [HttpService]` directly.

### Configuration types

#### `AuthConfig`

User-supplied authentication factory.

```ts
interface AuthConfig {
  authenticate(client: RestClient): Promise<AuthStrategy>
}
```

The `client` argument is a fully resilient `RestClient`, so auth requests reuse the same resilience policy stack as application requests.

#### `AuthStrategy`

Strategy returned by `AuthConfig.authenticate`. Represents an active authentication session.

```ts
interface AuthStrategy {
  isAuthenticated(): boolean
  extendRequest(config: AxiosRequestConfig): AxiosRequestConfig
}
```

`extendRequest` MUST NOT mutate its input — callers may reuse the original config.

#### `ResilanceConfig<T, S = void, R = unknown>`

Composable resilience configuration. Each field is optional; an empty config produces a `NoopPolicy`.

```ts
interface ResilanceConfig<T, S = void, R = unknown> {
  retry?: RetryConfig<T, S>
  circuitBreaker?: CircuitBreakerConfig
  bulkhead?: BulkheadConfig
  fallback?: FallbackConfig<R>
}
```

Sub-types `RetryConfig`, `CircuitBreakerConfig`, `BulkheadConfig`, and `FallbackConfig` are exported as type-only aliases; see `src/client/resilance.config.ts` for the full field-level documentation.

// TODO: add examples building resilience configs from scratch.

#### `ResilencePresets`

Enum of supplied preset names: `CONSERVATIVE`, `RESTFULL`, `LOW_QUALITY`.

```ts
enum ResilencePresets {
  CONSERVATIVE = 'conservative',
  RESTFULL = 'restfull',
  LOW_QUALITY = 'low-quality',
}
```

#### `resiliencePolicyPresets`

Lookup table from `ResilencePresets` value to a ready-made `ResilanceConfig`.

```ts
const resiliencePolicyPresets: Record<ResilencePresets, ResilanceConfig<number, void, number>>
```

Use as `resiliencePolicyPresets[ResilencePresets.CONSERVATIVE]`.

### Decorators

#### `@ExecuteWithPolicy()`

Method decorator. Runs the decorated request method through `this.policy.execute(...)` and unwraps the resulting Observable to a Promise via `firstValueFrom`. Reads `this.policy` at call time. When `propertyKey === 'request'`, forwards the cockatiel `signal` into the first argument.

Used internally on every `RestClient` verb method; consumers extending `RestClient` may apply it to their own methods.

#### `@Authenticate()`

Method decorator. Wraps a request method with the auth lifecycle:

1. `await this.authStrategy.authenticateIfNeeded()`
2. Replace the config arg (index 1 for `get`/`delete`/`head`/`options`/`request`; index 2 for `post`/`put`/`patch` and `*Form` variants) with `this.authStrategy.extendRequest(args[idx] ?? {})`.
3. On a single HTTP 401, drop cached auth, re-authenticate, re-extend the *original* args, and retry once.

Used internally on every `AuthRestClient` verb method.

#### `@DeduplicateInflight(keyBuilder)`

Method decorator. Coalesces concurrent calls that derive the same key into one underlying invocation. Stores in-flight promises in `this.inflightMap: Map<string, Promise<unknown>>` and removes the entry in a `finally` block.

Used internally on `AuthStrategyService.performAuthenticate` with a constant key for single-flight authentication. Available for consumer use anywhere a host class exposes an `inflightMap`.

```ts
@DeduplicateInflight((id: string) => `user:${id}`)
async fetchUser(id: string): Promise<User> { /* ... */ }
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
