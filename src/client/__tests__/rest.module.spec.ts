import { HttpService } from '@nestjs/axios'
import { Test } from '@nestjs/testing'
import type { TestingModule } from '@nestjs/testing'
import type { AxiosError, AxiosResponse } from 'axios'
import { CircuitBreakerPolicy, RetryPolicy, TimeoutPolicy } from 'cockatiel'
import { of, throwError } from 'rxjs'

import type { ResilanceConfig } from '../resilance.config'
import { RestClient } from '../rest.client'
import { REST_MODULE_OPTIONS, RestModule } from '../rest.module'
import type { RestFromHttpServiceOptions } from '../rest.module'

/**
 * Builds an axios-shaped error fixture matching the structure
 * `isAxiosError(err)` expects. The CONSERVATIVE preset's `shouldRetry`
 * delegates to `isRetryableError(error, SAFE_HTTP_METHODS)`, which inspects
 * `error.config.method` + `error.response.status`.
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

const successResponse: AxiosResponse = {
  data: { ok: true },
  status: 200,
  statusText: 'OK',
  headers: {},
  config: {} as AxiosResponse['config'],
}

/**
 * Bootstrap helper. Compiles a {@link TestingModule} with the supplied
 * factory output and returns the module + its resolved instances. The
 * `HttpService` provider is overridden with a per-test stub so we never make
 * real network calls and can assert on the verb invocations directly.
 *
 * Spreading `axios`/`resilanceConfig` only when defined preserves the
 * "factory omits the field" branch in {@link RestModule.forRootAsync} —
 * spreading `undefined` would still set the property and mask the omission.
 */
async function bootstrap(opts: {
  httpServiceStub: Partial<HttpService>
  axios?: { baseURL?: string }
  resilanceConfig?: ResilanceConfig<unknown>
}): Promise<{
  moduleRef: TestingModule
  restClient: RestClient
  resolvedHttpService: HttpService
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      RestModule.forRootAsync({
        useFactory: () => ({
          ...(opts.axios === undefined ? {} : { axios: opts.axios }),
          ...(opts.resilanceConfig === undefined ? {} : { resilanceConfig: opts.resilanceConfig }),
        }),
      }),
    ],
  })
    // The HttpService is registered transitively by HttpModule.registerAsync
    // inside RestModule. We override it with a stub so RestClient verb calls
    // resolve to deterministic Observables instead of hitting the network.
    .overrideProvider(HttpService)
    .useValue(opts.httpServiceStub)
    .compile()

  return {
    moduleRef,
    restClient: moduleRef.get(RestClient),
    resolvedHttpService: moduleRef.get(HttpService),
  }
}

describe('RestModule.forRootAsync', () => {
  describe('bootstrap and resolution', () => {
    it('compiles a TestingModule with a factory returning empty options without throwing', async () => {
      // Empty-options bootstrap is the smallest viable wiring — exercises the
      // `axiosConfig ?? {}` and CONSERVATIVE-preset fallbacks together. If any
      // provider in the chain (REST_MODULE_OPTIONS -> HttpModule -> HttpService
      // -> RestClient) failed to resolve, `compile()` would throw.
      const httpServiceStub = { get: jest.fn(() => of(successResponse)) }

      await expect(
        bootstrap({ httpServiceStub }),
      ).resolves.toBeDefined()
    })

    it('module.get(RestClient) returns a RestClient instance', async () => {
      const httpServiceStub = { get: jest.fn(() => of(successResponse)) }

      const { restClient } = await bootstrap({ httpServiceStub })

      expect(restClient).toBeInstanceOf(RestClient)
    })

    it('REST_MODULE_OPTIONS token is registered with the resolved factory output', async () => {
      // Pinning the options-token contract guards consumers that legitimately
      // inject the raw options for diagnostics or test fixtures (the JSDoc on
      // REST_MODULE_OPTIONS documents this as supported usage).
      const httpServiceStub = { get: jest.fn(() => of(successResponse)) }

      const { moduleRef } = await bootstrap({
        httpServiceStub,
        axios: { baseURL: 'https://api.example.com' },
      })

      const opts = moduleRef.get<{ axios?: { baseURL?: string } }>(
        REST_MODULE_OPTIONS,
      )
      expect(opts.axios).toEqual({ baseURL: 'https://api.example.com' })
    })

    it('the RestClient is composed from the HttpService provided by the internally-registered HttpModule', async () => {
      // The single-source-of-truth invariant documented on the module: the
      // RestClient must use the SAME HttpService Nest resolves at the
      // module boundary. Verifying object identity guards against silent
      // re-registration regressions.
      const httpServiceStub = { get: jest.fn(() => of(successResponse)) }

      const { restClient, resolvedHttpService } = await bootstrap({ httpServiceStub })

      expect(
        (restClient as unknown as { httpService: HttpService }).httpService,
      ).toBe(resolvedHttpService)
    })
  })

  describe('default-preset fallback (factory omits `resilanceConfig`)', () => {
    it('resolved RestClient.policy is the CONSERVATIVE composition: RetryPolicy(maxAttempts=3) wrapping TimeoutPolicy(60s) wrapping CircuitBreakerPolicy', async () => {
      const httpServiceStub = { get: jest.fn(() => of(successResponse)) }

      const { restClient } = await bootstrap({ httpServiceStub })

      // CONSERVATIVE = retry + timeout + circuitBreaker. Retry sits OUTSIDE
      // timeout so each attempt receives its own independent 60 s deadline
      // (per-attempt semantics) — `wrap(...)` returns an object with a
      // `wrapped` field listing the composed sub-policies in outer-to-inner
      // order. Same structural inspection used by `rest.client.spec.ts` for
      // the no-config constructor path.
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
      // Fake timers so `ExponentialBackoff`'s setTimeout delays do not block
      // the test on real wall-clock time. Same pattern as the matching test
      // in `auth-rest.module.spec.ts` and `rest.client.spec.ts`.
      jest.useFakeTimers()

      try {
        const error = makeAxiosError('GET', 500)
        const httpServiceStub = { get: jest.fn(() => throwError(() => error)) }

        const { restClient } = await bootstrap({ httpServiceStub })

        // Capture rejection via `.catch` so the await never throws and timer
        // advancement can run between retry attempts.
        const promise = restClient.get('/x').catch((err: unknown) => err)
        // Default ExponentialBackoff caps at maxDelay=30s; advancing 60s twice
        // is enough headroom to flush all three retry delays.
        await jest.advanceTimersByTimeAsync(60_000)
        await jest.advanceTimersByTimeAsync(60_000)
        await promise

        // maxAttempts=3 => up to 3 retries => 4 total invocations.
        expect(httpServiceStub.get).toHaveBeenCalledTimes(4)
      }
      finally {
        jest.useRealTimers()
      }
    })
  })

  describe('explicit `resilanceConfig` override', () => {
    it('factory-supplied resilanceConfig replaces the CONSERVATIVE default in the resolved RestClient.policy', async () => {
      const httpServiceStub = { get: jest.fn(() => of(successResponse)) }

      // Override with a single-policy retry config so the override is
      // detectable both structurally (single wrapped policy) and behaviourally
      // (maxAttempts=1 => 2 total axios calls instead of 4).
      const override: ResilanceConfig<unknown> = {
        retry: {
          maxAttempts: 1,
          backoff: 0,
          shouldRetry: () => true,
        },
      }

      const { restClient } = await bootstrap({
        httpServiceStub,
        resilanceConfig: override,
      })

      const wrapped = (restClient.policy as unknown as { wrapped: unknown[] }).wrapped
      expect(wrapped).toHaveLength(1)
      expect(wrapped[0]).toBeInstanceOf(RetryPolicy)

      const retryOptions = (wrapped[0] as unknown as { options: { maxAttempts: number } }).options
      expect(retryOptions.maxAttempts).toBe(1)
    })

    it('behavioural: with maxAttempts=1 override, GET 5xx exhausts at exactly 2 total axios calls (vs 4 under the default)', async () => {
      const error = makeAxiosError('GET', 500)
      const httpServiceStub = { get: jest.fn(() => throwError(() => error)) }

      const override: ResilanceConfig<unknown> = {
        retry: {
          maxAttempts: 1,
          backoff: 0,
          shouldRetry: () => true,
        },
      }

      const { restClient } = await bootstrap({
        httpServiceStub,
        resilanceConfig: override,
      })

      await expect(restClient.get('/x')).rejects.toBe(error)

      // maxAttempts=1 => 1 retry => 2 total invocations. If the override were
      // ignored, the CONSERVATIVE default would produce 4 calls instead.
      expect(httpServiceStub.get).toHaveBeenCalledTimes(2)
    })
  })

  describe('axios forwarding', () => {
    it('forwards `axios` (e.g. baseURL) to the internally-registered HttpModule so the underlying axios instance carries it', async () => {
      // We do NOT override HttpService here — we want to inspect the real
      // axios instance HttpModule constructed from the factory output. The
      // axios instance carries the `baseURL` on its `defaults` after
      // `axios.create(config)` runs inside HttpModule.registerAsync.
      const moduleRef = await Test.createTestingModule({
        imports: [
          RestModule.forRootAsync({
            useFactory: () => ({
              axios: { baseURL: 'https://api.example.com' },
            }),
          }),
        ],
      }).compile()

      const httpService = moduleRef.get(HttpService)
      expect(httpService.axiosRef.defaults.baseURL).toBe('https://api.example.com')
    })

    it('omitting `axios` falls back to axios defaults (no baseURL set)', async () => {
      // The `axios ?? {}` fallback is the load-bearing branch when the
      // consumer doesn't supply axios options. axios.create({}) leaves the
      // defaults.baseURL undefined.
      const moduleRef = await Test.createTestingModule({
        imports: [
          RestModule.forRootAsync({
            useFactory: () => ({}),
          }),
        ],
      }).compile()

      const httpService = moduleRef.get(HttpService)
      expect(httpService.axiosRef.defaults.baseURL).toBeUndefined()
    })
  })

  describe('inject + imports passthrough', () => {
    it('threads `inject` dependencies (via `imports`) into the consumer factory', async () => {
      // Sentinel token consumed by the user factory — proves that `inject`
      // wiring reaches the factory through both REST_MODULE_OPTIONS and the
      // internally-registered HttpModule. Provided via a dedicated module so
      // both inner factory contexts can resolve it.
      const SENTINEL = Symbol('sentinel')

      const sentinelModule = {
        module: class SentinelModule {},
        providers: [{ provide: SENTINEL, useValue: 'injected-value' }],
        exports: [SENTINEL],
      }

      const factory = jest.fn((value: unknown) => {
        expect(value).toBe('injected-value')
        return {}
      })

      const moduleRef = await Test.createTestingModule({
        imports: [
          RestModule.forRootAsync({
            imports: [sentinelModule],
            inject: [SENTINEL],
            useFactory: factory,
          }),
        ],
      }).compile()

      expect(moduleRef.get(RestClient)).toBeInstanceOf(RestClient)
      expect(factory).toHaveBeenCalled()
    })
  })
})

describe('RestModule.forHttpService', () => {
  /**
   * Builds a minimal stub for the pre-resolved {@link HttpService}. The stub
   * mirrors the shape {@link RestClient} needs: a `get` mock so the
   * {@link HookableHttpService} dispatch path can delegate through it.
   */
  function buildHttpServiceStub(response: AxiosResponse): Partial<HttpService> {
    return {
      get: jest.fn(() => of(response)),
      axiosRef: { defaults: {} } as HttpService['axiosRef'],
    }
  }

  it('provides a RestClient when inject and imports are omitted (fallback to empty arrays)', async () => {
    // This exercises the `options.inject ?? []` and `options.imports ?? []`
    // fallback branches in `forHttpService` — the only uncovered paths when
    // the method is called exclusively from AuthRestModule (which always
    // supplies both fields).
    const httpStub = buildHttpServiceStub(successResponse)

    const moduleRef = await Test.createTestingModule({
      imports: [
        RestModule.forHttpService({
          // No `inject` and no `imports` — both default to `[]` inside the method.
          useFactory: (): RestFromHttpServiceOptions => ({
            httpService: httpStub as unknown as HttpService,
          }),
        }),
      ],
    }).compile()

    expect(moduleRef.get(RestClient)).toBeInstanceOf(RestClient)
  })

  it('applies the CONSERVATIVE default when resilanceConfig is omitted from the factory result', async () => {
    const httpStub = buildHttpServiceStub(successResponse)

    const moduleRef = await Test.createTestingModule({
      imports: [
        RestModule.forHttpService({
          useFactory: (): RestFromHttpServiceOptions => ({
            httpService: httpStub as unknown as HttpService,
          }),
        }),
      ],
    }).compile()

    const restClient = moduleRef.get(RestClient)

    // CONSERVATIVE preset: retry → timeout(60 s) → circuitBreaker.
    const wrapped = (restClient.policy as unknown as { wrapped: unknown[] }).wrapped
    expect(wrapped).toHaveLength(3)
    expect(wrapped[0]).toBeInstanceOf(RetryPolicy)
    expect(wrapped[1]).toBeInstanceOf(TimeoutPolicy)
    expect(wrapped[2]).toBeInstanceOf(CircuitBreakerPolicy)
  })

  it('applies a supplied resilanceConfig override instead of the CONSERVATIVE default', async () => {
    const httpStub = buildHttpServiceStub(successResponse)
    const override: ResilanceConfig<unknown> = {
      retry: { maxAttempts: 1, backoff: 0, shouldRetry: () => true },
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        RestModule.forHttpService({
          useFactory: (): RestFromHttpServiceOptions => ({
            httpService: httpStub as unknown as HttpService,
            resilanceConfig: override,
          }),
        }),
      ],
    }).compile()

    const restClient = moduleRef.get(RestClient)

    const wrapped = (restClient.policy as unknown as { wrapped: unknown[] }).wrapped
    expect(wrapped).toHaveLength(1)
    expect(wrapped[0]).toBeInstanceOf(RetryPolicy)
    const retryOptions = (wrapped[0] as unknown as { options: { maxAttempts: number } }).options
    expect(retryOptions.maxAttempts).toBe(1)
  })
})
