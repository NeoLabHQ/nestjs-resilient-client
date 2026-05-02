import { HttpService } from '@nestjs/axios'
import { Inject, Injectable, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { TestingModule } from '@nestjs/testing'
import type { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios'
import { CircuitBreakerPolicy, RetryPolicy, TimeoutPolicy } from 'cockatiel'
import { of, throwError } from 'rxjs'

import type { HooksConfig } from '../../client/hookable-http.service'
import { RestClient } from '../../client/rest.client'
import type { ResilanceConfig } from '../../client/resilance.config'
import { AuthProcessor } from '../auth-processor'
import { AuthRestClient } from '../auth-rest.client'
import { AuthRestModule } from '../auth-rest.module'
import type { AuthStrategy } from '../auth.config'

/**
 * Minimal `HttpService`-shaped stub. Mirrors the shape used by
 * `rest.client.spec.ts` and `rest.module.spec.ts` — every verb returns an
 * `Observable<AxiosResponse>` so {@link BaseHttpService.callUnderlying} can
 * unwrap it via `firstValueFrom` exactly the same way as the real
 * `HttpService`. Injected via `.overrideProvider(HttpService).useValue(stub)`
 * on the compiled `TestingModule`; we never call `jest.mock('@nestjs/axios')`.
 */
type HttpServiceStub = {
  request: jest.Mock
  get: jest.Mock
  delete: jest.Mock
  head: jest.Mock
  post: jest.Mock
  put: jest.Mock
  patch: jest.Mock
  postForm: jest.Mock
  putForm: jest.Mock
  patchForm: jest.Mock
  axiosRef: unknown
}

/**
 * Builds a fresh `HttpService`-shaped stub where every verb returns
 * `Observable.of(response)` by default. Tests that need 5xx behaviour
 * override individual verbs with `mockReturnValue(throwError(...))`.
 */
function buildHttpServiceStub(response: AxiosResponse): HttpServiceStub {
  return {
    request: jest.fn(() => of(response)),
    get: jest.fn(() => of(response)),
    delete: jest.fn(() => of(response)),
    head: jest.fn(() => of(response)),
    post: jest.fn(() => of(response)),
    put: jest.fn(() => of(response)),
    patch: jest.fn(() => of(response)),
    postForm: jest.fn(() => of(response)),
    putForm: jest.fn(() => of(response)),
    patchForm: jest.fn(() => of(response)),
    axiosRef: { defaults: {} },
  }
}

// ── Sentinel DI infrastructure ────────────────────────────────────────────────

const SENTINEL_TOKEN = 'SENTINEL'
const SENTINEL_VALUE = 'sentinel-value'

// Strategy class that receives a dependency via NestJS constructor injection.
@Injectable()
class StrategyWithDeps implements AuthStrategy {
  constructor(@Inject(SENTINEL_TOKEN) public readonly sentinel: string) {}

  async authenticate(_client: RestClient): Promise<void> {}
  isAuthenticated(): boolean { return true }
  extendRequest(config: AxiosRequestConfig): AxiosRequestConfig { return config }
  invalidate(): void {}
}

// Wraps the sentinel in its own NestJS module so it can be imported into
// `AuthRestModule`'s DI scope via `forRootAsync({ imports: [SentinelModule] })`.
@Module({
  providers: [{ provide: SENTINEL_TOKEN, useValue: SENTINEL_VALUE }],
  exports: [SENTINEL_TOKEN],
})
class SentinelModule {}

// ──────────────────────────────────────────────────────────────────────────────

/**
 * Builds an axios-shaped error fixture matching the structure
 * `isAxiosError(err)` expects. The CONSERVATIVE preset's `shouldRetry`
 * delegates to `isRetryableError(error, SAFE_HTTP_METHODS)`, which
 * inspects `error.config.method` + `error.response.status`.
 */
function makeAxiosError(method: string, status: number): AxiosError {
  const error = new Error(`HTTP ${status}`) as Error & {
    isAxiosError: boolean
    response?: { status: number }
    config?: { method: string }
  }

  error.isAxiosError = true
  error.config = { method }
  error.response = { status }

  return error as unknown as AxiosError
}

/**
 * Class-based {@link AuthStrategy} stub. Under the module wiring,
 * `AuthRestModule.forRootAsync({ authStrategy })` registers the strategy
 * via `useClass` self-binding, so the test must hand it a *class token*
 * rather than a pre-built instance.
 *
 * The module spec only needs the strategy to satisfy the contract surface
 * so the wiring chain compiles — actual auth flows are covered by
 * `auth-rest.client.spec.ts` and `auth-processor.spec.ts`. The
 * `@Injectable()` decorator is mandatory: NestJS requires constructor
 * parameter metadata for `useClass` self-binding to work, even on a
 * parameterless constructor (defensive — guarantees the registration
 * pattern works the same when consumers add deps later).
 */
@Injectable()
class StubAuthStrategy implements AuthStrategy {
  async authenticate(_client: RestClient): Promise<void> {
    // no-op; the module spec does not exercise auth flows
  }

  isAuthenticated(): boolean {
    return true
  }

  extendRequest(config: AxiosRequestConfig): AxiosRequestConfig {
    return config
  }

  invalidate(): void {
    // no-op; the module spec does not exercise invalidation
  }
}

/**
 * AC-14 strategy fixture. Stamps a sentinel `Authorization` header on
 * every outgoing request so the test can assert that the auth-strategy
 * header was attached on top of the new `axios` + `hooks` factory shape.
 * Distinct class identity from {@link StubAuthStrategy} so the AC-14 test's
 * intent is self-evident from the registered class.
 */
@Injectable()
class StampingAuthStrategy implements AuthStrategy {
  async authenticate(_client: RestClient): Promise<void> {}

  isAuthenticated(): boolean {
    return true
  }

  extendRequest(config: AxiosRequestConfig): AxiosRequestConfig {
    return {
      ...config,
      headers: { ...(config.headers ?? {}), Authorization: 'Bearer ac14-token' },
    }
  }

  invalidate(): void {}
}

const successResponse: AxiosResponse = {
  data: { ok: true },
  status: 200,
  statusText: 'OK',
  headers: {},
  config: {} as AxiosResponse['config'],
}

/**
 * Bootstrap helper. Compiles a {@link TestingModule} for
 * `AuthRestModule.forRootAsync` with the new `{ axios?, resilience?, hooks? }`
 * options shape (post-Step-12; the `httpService` field has been removed). The
 * `HttpService` provider is registered transitively by the internal
 * `HttpModule.registerAsync(opts.axios ?? {})` and overridden with a per-test
 * stub so we never make real network calls and can assert on the verb
 * invocations directly.
 *
 * The `authStrategy` class token defaults to {@link StubAuthStrategy} (a
 * no-op strategy) so the bulk of the wiring/resilience tests stay focused on
 * the module wiring rather than auth specifics.
 *
 * Spreading `axios`/`resilience`/`hooks` only when defined preserves the
 * "factory omits the field" branches in {@link AuthRestModule.forRootAsync}
 * — spreading `undefined` would still set the property and mask the omission.
 */
async function bootstrap(opts: {
  httpServiceStub: HttpServiceStub
  axios?: { baseURL?: string }
  resilience?: ResilanceConfig<unknown>
  hooks?: HooksConfig
  authStrategy?: AuthStrategy extends never ? never : typeof StubAuthStrategy | typeof StampingAuthStrategy
}): Promise<{
  moduleRef: TestingModule
  authRestClient: AuthRestClient
  restClient: RestClient
  resolvedHttpService: HttpService
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AuthRestModule.registerAsync({
        strategy: opts.authStrategy ?? StubAuthStrategy,
        useFactory: () => ({
          ...(opts.axios === undefined ? {} : { axios: opts.axios }),
          ...(opts.resilience === undefined ? {} : { resilience: opts.resilience }),
          ...(opts.hooks === undefined ? {} : { hooks: opts.hooks }),
        }),
      }),
    ],
  })
    // The HttpService is registered transitively by HttpModule.registerAsync
    // inside AuthRestModule. We override it with a stub so AuthRestClient
    // verb calls resolve to deterministic Observables instead of hitting the
    // network. Same pattern used by `rest.module.spec.ts`.
    .overrideProvider(HttpService)
    .useValue(opts.httpServiceStub)
    .compile()

  return {
    moduleRef,
    authRestClient: moduleRef.get(AuthRestClient),
    restClient: moduleRef.get(RestClient),
    resolvedHttpService: moduleRef.get(HttpService),
  }
}

describe('AuthRestModule.registerAsync', () => {
  describe('bootstrap and resolution', () => {
    it('compiles a TestingModule with a factory returning empty options without throwing', async () => {
      const httpServiceStub = buildHttpServiceStub(successResponse)

      // Bootstrap is the assertion target — `compile()` would throw if any
      // provider in the wiring chain (HttpModule -> HttpService ->
      // AUTH_MODULE_OPTIONS -> RestClient -> StubAuthStrategy ->
      // AuthProcessor -> AuthRestClient) failed to resolve.
      await expect(bootstrap({ httpServiceStub })).resolves.toBeDefined()
    })

    it('module.get(AuthRestClient) returns an AuthRestClient instance', async () => {
      const httpServiceStub = buildHttpServiceStub(successResponse)

      const { authRestClient } = await bootstrap({ httpServiceStub })

      expect(authRestClient).toBeInstanceOf(AuthRestClient)
    })

    it('module.get(RestClient) returns a RestClient instance', async () => {
      const httpServiceStub = buildHttpServiceStub(successResponse)

      const { restClient } = await bootstrap({ httpServiceStub })

      expect(restClient).toBeInstanceOf(RestClient)
    })

    it('AuthRestClient is composed from the same RestClient instance the module provides (single-source-of-truth invariant)', async () => {
      const httpServiceStub = buildHttpServiceStub(successResponse)

      const { authRestClient, restClient } = await bootstrap({ httpServiceStub })

      // The module JSDoc documents this explicitly: "Re-registering RestClient
      // elsewhere will produce a second, unrelated instance and break shared
      // circuit-breaker / bulkhead state." Verifying object identity here
      // guards that invariant against silent regressions — particularly
      // important after Step 12, which moved RestClient construction into
      // RestModule.forHttpService delegation.
      expect(authRestClient.restClient).toBe(restClient)
    })

    it('AuthRestClient is composed with an AuthProcessor instance (post-rename invariant)', async () => {
      const httpServiceStub = buildHttpServiceStub(successResponse)

      const { authRestClient } = await bootstrap({ httpServiceStub })

      // Field invariant: the `processor` field is the `AuthProcessor` instance.
      // This assertion fixes the wiring contract so future refactors that drop
      // the field, rename it, or wire the wrong class are caught here.
      expect(authRestClient.processor).toBeInstanceOf(AuthProcessor)
    })
  })

  describe('strategy DI integration', () => {
    it('instantiates the strategy class via the DI container with access to other providers', async () => {
      // StrategyWithDeps / SentinelModule / SENTINEL_TOKEN are declared at
      // file scope above. The test imports them directly.
      const httpServiceStub = buildHttpServiceStub(successResponse)

      const moduleRef = await Test.createTestingModule({
        imports: [
          AuthRestModule.registerAsync({
            strategy: StrategyWithDeps,
            imports: [SentinelModule],
            useFactory: () => ({}),
          }),
        ],
      })
        .overrideProvider(HttpService)
        .useValue(httpServiceStub)
        .compile()

      // The crux of the assertion: resolving the strategy class returns an
      // instance whose constructor-injected `sentinel` carries the registered
      // SENTINEL_VALUE. If the module registered the strategy with a pattern
      // that bypassed DI (e.g. `useValue: new StrategyWithDeps()`, which
      // would explode with no constructor args), this would fail.
      const strategyInstance = moduleRef.get(StrategyWithDeps)
      expect(strategyInstance).toBeInstanceOf(StrategyWithDeps)
      expect(strategyInstance.sentinel).toBe(SENTINEL_VALUE)
    })
  })

  describe('default-preset fallback (factory omits `resilience`)', () => {
    it('resolved RestClient.policy is the CONSERVATIVE composition: RetryPolicy(maxAttempts=3) wrapping TimeoutPolicy(60s) wrapping CircuitBreakerPolicy', async () => {
      const httpServiceStub = buildHttpServiceStub(successResponse)

      const { restClient } = await bootstrap({ httpServiceStub })

      // CONSERVATIVE = retry + timeout + circuitBreaker. Retry sits OUTSIDE
      // timeout so each attempt receives its own independent 60 s deadline
      // (per-attempt semantics) — `wrap(...)` returns an object with a
      // `wrapped` field listing the composed sub-policies in outer-to-inner
      // order. Same structural inspection used by `rest.client.spec.ts` for
      // the same assertion against the no-config constructor path.
      const wrapped = (restClient.policy as unknown as { wrapped: unknown[] }).wrapped
      expect(wrapped).toHaveLength(3)
      expect(wrapped[0]).toBeInstanceOf(RetryPolicy)
      expect(wrapped[1]).toBeInstanceOf(TimeoutPolicy)
      expect(wrapped[2]).toBeInstanceOf(CircuitBreakerPolicy)

      // Pin the per-attempt 60 s deadline documented in the README.
      const timeoutDuration = (wrapped[1] as unknown as { duration: number }).duration
      expect(timeoutDuration).toBe(60_000)

      const retryOptions = (wrapped[0] as unknown as { options: { maxAttempts: number } }).options
      expect(retryOptions.maxAttempts).toBe(3)
    })

    it('behavioural: GET 5xx through the module-provided RestClient retries up to maxAttempts=3 (4 total axios calls)', async () => {
      // Fake timers so `ExponentialBackoff`'s setTimeout-based delays do not
      // block the test on real wall-clock time. Same pattern as
      // `rest.client.spec.ts` "retries safe-method 5xx errors" test.
      jest.useFakeTimers()

      try {
        const error = makeAxiosError('GET', 500)
        const httpServiceStub = buildHttpServiceStub(successResponse)
        // Always emit the 5xx error — the retry policy must give up only
        // after the configured `maxAttempts` retries.
        httpServiceStub.get.mockReturnValue(throwError(() => error))

        const { restClient } = await bootstrap({ httpServiceStub })

        // Drive the call to completion while flushing pending timers between
        // retries. Capture rejection via `.catch` so the await never throws.
        const promise = restClient.get('/x').catch((err: unknown) => err)
        // Default ExponentialBackoff caps at maxDelay=30s; advancing 60s twice
        // is enough headroom to flush all three retry delays.
        await jest.advanceTimersByTimeAsync(60_000)
        await jest.advanceTimersByTimeAsync(60_000)
        await promise

        // maxAttempts=3 => up to 3 retries => 4 total invocations. This is
        // the behavioural assertion the spec rubric calls out for the
        // default-preset criterion.
        expect(httpServiceStub.get).toHaveBeenCalledTimes(4)
      }
      finally {
        jest.useRealTimers()
      }
    })
  })

  describe('explicit `resilience` override', () => {
    it('factory-supplied resilience replaces the CONSERVATIVE default in the resolved RestClient.policy', async () => {
      const httpServiceStub = buildHttpServiceStub(successResponse)

      // Override with a resilience config that has only retry, no circuit
      // breaker, and a different `maxAttempts` so the override is detectable
      // both structurally (single wrapped policy) and behaviourally
      // (maxAttempts=1 => 2 total axios calls instead of 4).
      const override: ResilanceConfig<unknown> = {
        retry: {
          maxAttempts: 1,
          backoff: 0, // ConstantBackoff(0) keeps the test deterministic with no real delay
          shouldRetry: () => true,
        },
      }

      const { restClient } = await bootstrap({
        httpServiceStub,
        resilience: override,
      })

      // Override yields a single wrapped RetryPolicy — distinct from the
      // CONSERVATIVE preset's three-policy (retry + timeout + circuitBreaker)
      // shape.
      const wrapped = (restClient.policy as unknown as { wrapped: unknown[] }).wrapped
      expect(wrapped).toHaveLength(1)
      expect(wrapped[0]).toBeInstanceOf(RetryPolicy)

      const retryOptions = (wrapped[0] as unknown as { options: { maxAttempts: number } }).options
      expect(retryOptions.maxAttempts).toBe(1)
    })

    it('behavioural: with maxAttempts=1 override, GET 5xx exhausts at exactly 2 total axios calls (vs 4 under the default)', async () => {
      const error = makeAxiosError('GET', 500)
      const httpServiceStub = buildHttpServiceStub(successResponse)
      httpServiceStub.get.mockReturnValue(throwError(() => error))

      const override: ResilanceConfig<unknown> = {
        retry: {
          maxAttempts: 1,
          backoff: 0,
          shouldRetry: () => true,
        },
      }

      const { restClient } = await bootstrap({
        httpServiceStub,
        resilience: override,
      })

      await expect(restClient.get('/x')).rejects.toBe(error)

      // maxAttempts=1 => 1 retry => 2 total invocations. If the override were
      // ignored, the CONSERVATIVE default would produce 4 calls instead.
      expect(httpServiceStub.get).toHaveBeenCalledTimes(2)
    })
  })

  describe('AC-14: AuthRestModuleOptions extends RestModuleOptions and accepts `axios` + `hooks`', () => {
    it('useFactory `() => ({ axios: { baseURL }, hooks: { onInvoke: spy } })` — DI-resolved AuthRestClient.get(\'/x\') invokes spy AND attaches the auth-strategy header', async () => {
      // Pins AC-14: post-Step-12, `AuthRestModuleOptions` no longer carries
      // a `httpService` field. The factory shape now matches `RestModuleOptions`
      // exactly (`{ axios?, resilience?, hooks? }`) plus the synchronous
      // `authStrategy` class token at the top level. This single test asserts
      // all three convergent contracts:
      //   (a) `axios` config flows through to the internally-registered
      //       `HttpModule.registerAsync(opts.axios ?? {})` so the verb call
      //       carries the resolved URL;
      //   (b) `hooks.onInvoke` is forwarded into `new AuthRestClient(...)` so
      //       the HookableHttpService lifecycle observes every dispatched verb;
      //   (c) `extendRequest` (from the user-supplied AuthStrategy) still
      //       stamps the auth header on the outgoing request — proving the
      //       auth lifecycle composes cleanly with the new options shape.
      const onInvoke: jest.Mock = jest.fn()
      const httpServiceStub = buildHttpServiceStub(successResponse)

      const { authRestClient } = await bootstrap({
        httpServiceStub,
        axios: { baseURL: 'http://stub' },
        hooks: { onInvoke },
        authStrategy: StampingAuthStrategy,
      })

      const response = await authRestClient.get('/x')

      // (a) The verb call was dispatched to the underlying HttpService stub.
      // The bootstrap stub records calls regardless of `baseURL`; we still
      // verify the dispatch reached the stub so the AC-14 chain is complete
      // end-to-end. (E2E coverage for the resolved URL lives in Step 17.)
      expect(httpServiceStub.get).toHaveBeenCalledTimes(1)
      expect(response.status).toBe(200)

      // (b) The hooks.onInvoke spy fired with the verb + carrier. Step 12
      // forwards `opts.hooks` into BOTH `RestModule.forHttpService` (inner
      // RestClient) AND the `AuthRestClient` provider, so onInvoke fires
      // twice per call — once in the AuthRestClient HookableHttpService layer
      // (around the auth lifecycle) and once in the inner RestClient
      // HookableHttpService layer (inside the resilience pipeline). The
      // success criterion (AC-14) only requires "spy invoked"; we assert
      // the looser invariant via `toHaveBeenCalled()` and pin the call
      // signature so wiring regressions surface here. If Step 12's wiring
      // dropped `opts.hooks` from either provider factory, this would never
      // fire.
      expect(onInvoke).toHaveBeenCalled()
      expect(onInvoke).toHaveBeenCalledWith(
        'get',
        expect.objectContaining({ url: '/x', config: expect.any(Object) }),
      )

      // (c) The auth-strategy header was attached to the outgoing request.
      // `StampingAuthStrategy.extendRequest` stamps `Authorization: Bearer
      // ac14-token` on the carrier config, which BaseHttpService.callUnderlying
      // forwards to the upstream HttpService.get(url, config) call. The third
      // positional arg to `httpService.get` is the AxiosRequestConfig.
      const [, callConfig] = httpServiceStub.get.mock.calls[0] as [
        string,
        AxiosRequestConfig,
      ]
      expect(callConfig.headers).toMatchObject({ Authorization: 'Bearer ac14-token' })
    })
  })
})
