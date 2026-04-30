import type { HttpService } from '@nestjs/axios'
import { Test } from '@nestjs/testing'
import type { TestingModule } from '@nestjs/testing'
import type { AxiosError, AxiosResponse } from 'axios'
import { CircuitBreakerPolicy, RetryPolicy, TimeoutPolicy } from 'cockatiel'
import { of, throwError } from 'rxjs'

import { RestClient } from '../../client/rest.client'
import type { ResilanceConfig } from '../../client/resilance.config'
import { AuthRestClient } from '../auth-rest.client'
import { AuthRestModule } from '../auth-rest.module'
import type { AuthConfig, AuthStrategy } from '../auth.config'

/**
 * Minimal `HttpService`-shaped stub. Mirrors the shape used by
 * `rest.client.spec.ts` — every verb returns an `Observable<AxiosResponse>`
 * so {@link HookableHttpService.callUnderlying} can unwrap it via
 * `firstValueFrom` exactly the same way as the real `HttpService`.
 * Constructor-injected via the {@link AuthRestModule.forRootAsync} factory;
 * we never call `jest.mock('@nestjs/axios')`.
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
 * Builds a synchronous {@link AuthStrategy} stub. The module spec only
 * needs the strategy to satisfy the `AuthConfig.authenticate` contract;
 * it does not exercise auth flows (those are covered by
 * `auth-rest.client.spec.ts` and `auth-strategy.service.spec.ts`).
 */
function createAuthStrategyStub(): AuthStrategy {
  return {
    isAuthenticated: jest.fn().mockReturnValue(true),
    extendRequest: jest.fn((config) => config),
  }
}

/** Builds a fresh {@link AuthConfig} stub whose `authenticate` resolves to a stub strategy. */
function createAuthConfigStub(): AuthConfig {
  return {
    authenticate: jest.fn().mockResolvedValue(createAuthStrategyStub()),
  }
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
 * factory output and returns the module + its resolved instances. Centralised
 * so individual test cases stay focused on assertions rather than wiring.
 */
async function bootstrap(opts: {
  httpService: HttpServiceStub
  resilience?: ResilanceConfig<unknown>
}): Promise<{
  moduleRef: TestingModule
  authRestClient: AuthRestClient
  restClient: RestClient
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AuthRestModule.forRootAsync({
        useFactory: () => ({
          httpService: opts.httpService as unknown as HttpService,
          authConfig: createAuthConfigStub(),
          // Spreading `undefined` would still set the property; only attach
          // `resilience` when the caller explicitly supplied one so the
          // "factory omits resilience" branch in `AuthRestModule` is
          // exercised by the default-preset test.
          ...(opts.resilience === undefined ? {} : { resilience: opts.resilience }),
        }),
      }),
    ],
  }).compile()

  return {
    moduleRef,
    authRestClient: moduleRef.get(AuthRestClient),
    restClient: moduleRef.get(RestClient),
  }
}

describe('AuthRestModule.forRootAsync', () => {
  describe('bootstrap and resolution', () => {
    it('compiles a TestingModule with useFactory returning httpService + authConfig without throwing', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)

      // Bootstrap is the assertion target — `compile()` would throw if any
      // provider in the wiring chain (AUTH_MODULE_OPTIONS -> RestClient ->
      // AuthStrategyService -> AuthRestClient) failed to resolve.
      await expect(bootstrap({ httpService: stubHttp })).resolves.toBeDefined()
    })

    it('module.get(AuthRestClient) returns an AuthRestClient instance', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)

      const { authRestClient } = await bootstrap({ httpService: stubHttp })

      expect(authRestClient).toBeInstanceOf(AuthRestClient)
    })

    it('module.get(RestClient) returns a RestClient instance', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)

      const { restClient } = await bootstrap({ httpService: stubHttp })

      expect(restClient).toBeInstanceOf(RestClient)
    })

    it('AuthRestClient is composed from the same RestClient instance the module provides (single-source-of-truth invariant)', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)

      const { authRestClient, restClient } = await bootstrap({ httpService: stubHttp })

      // The module JSDoc documents this explicitly: "Re-registering RestClient
      // elsewhere will produce a second, unrelated instance and break shared
      // circuit-breaker / bulkhead state." Verifying object identity here
      // guards that invariant against silent regressions.
      expect((authRestClient as unknown as { restClient: RestClient }).restClient).toBe(restClient)
    })
  })

  describe('default-preset fallback (factory omits `resilience`)', () => {
    it('resolved RestClient.policy is the CONSERVATIVE composition: RetryPolicy(maxAttempts=3) wrapping TimeoutPolicy(60s) wrapping CircuitBreakerPolicy', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)

      const { restClient } = await bootstrap({ httpService: stubHttp })

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
        const stubHttp = buildHttpServiceStub(successResponse)
        // Always emit the 5xx error — the retry policy must give up only
        // after the configured `maxAttempts` retries.
        stubHttp.get.mockReturnValue(throwError(() => error))

        const { restClient } = await bootstrap({ httpService: stubHttp })

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
        expect(stubHttp.get).toHaveBeenCalledTimes(4)
      }
      finally {
        jest.useRealTimers()
      }
    })
  })

  describe('explicit `resilience` override', () => {
    it('factory-supplied resilience replaces the CONSERVATIVE default in the resolved RestClient.policy', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)

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
        httpService: stubHttp,
        resilience: override,
      })

      // Override yields a single wrapped RetryPolicy — distinct from the
      // CONSERVATIVE preset's two-policy (retry + circuitBreaker) shape.
      const wrapped = (restClient.policy as unknown as { wrapped: unknown[] }).wrapped
      expect(wrapped).toHaveLength(1)
      expect(wrapped[0]).toBeInstanceOf(RetryPolicy)

      const retryOptions = (wrapped[0] as unknown as { options: { maxAttempts: number } }).options
      expect(retryOptions.maxAttempts).toBe(1)
    })

    it('behavioural: with maxAttempts=1 override, GET 5xx exhausts at exactly 2 total axios calls (vs 4 under the default)', async () => {
      const error = makeAxiosError('GET', 500)
      const stubHttp = buildHttpServiceStub(successResponse)
      stubHttp.get.mockReturnValue(throwError(() => error))

      const override: ResilanceConfig<unknown> = {
        retry: {
          maxAttempts: 1,
          backoff: 0,
          shouldRetry: () => true,
        },
      }

      const { restClient } = await bootstrap({
        httpService: stubHttp,
        resilience: override,
      })

      await expect(restClient.get('/x')).rejects.toBe(error)

      // maxAttempts=1 => 1 retry => 2 total invocations. If the override were
      // ignored, the CONSERVATIVE default would produce 4 calls instead.
      expect(stubHttp.get).toHaveBeenCalledTimes(2)
    })
  })
})
