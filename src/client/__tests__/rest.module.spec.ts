import { HttpService } from '@nestjs/axios'
import { Injectable, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { TestingModule } from '@nestjs/testing'
import type { AxiosError, AxiosResponse } from 'axios'
import { CircuitBreakerPolicy, RetryPolicy, TimeoutPolicy } from 'cockatiel'
import { of, throwError } from 'rxjs'

import { ResiliencePresets } from '../../resilience.policy'
import type { HooksConfig } from '../hookable-http.service'
import type { ResilanceConfig } from '../resilance.config'
import { RestClient } from '../rest.client'
import {
  REST_MODULE_OPTIONS,
  RestModule,
  resolveResilience,
} from '../rest.module'
import type {
  ResolveInjectedDeps,
  RestFromHttpServiceOptions,
} from '../rest.module'

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
 * Spreading `axios`/`resilience` only when defined preserves the
 * "factory omits the field" branch in {@link RestModule.registerAsync} —
 * spreading `undefined` would still set the property and mask the omission.
 */
async function bootstrap(opts: {
  httpServiceStub: Partial<HttpService>
  axios?: { baseURL?: string }
  resilience?: ResilanceConfig<unknown>
}): Promise<{
  moduleRef: TestingModule
  restClient: RestClient
  resolvedHttpService: HttpService
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      RestModule.registerAsync({
        useFactory: () => ({
          ...(opts.axios === undefined ? {} : { axios: opts.axios }),
          ...(opts.resilience === undefined ? {} : { resilience: opts.resilience }),
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

describe('RestModule.registerAsync', () => {
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

  describe('default-preset fallback (factory omits `resilience`)', () => {
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

  describe('explicit `resilience` override', () => {
    it('factory-supplied resilience replaces the CONSERVATIVE default in the resolved RestClient.policy', async () => {
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
        resilience: override,
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
        resilience: override,
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
          RestModule.registerAsync({
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
          RestModule.registerAsync({
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
          RestModule.registerAsync({
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

describe('RestModule.fromHttpService', () => {
  /**
   * Builds a minimal stub for the pre-resolved {@link HttpService}. The stub
   * mirrors the shape {@link RestClient} needs: a `get` mock so the
   * {@link BaseHttpService} dispatch path can delegate through it.
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
        RestModule.fromHttpService({
          // No `inject` and no `imports` — both default to `[]` inside the method.
          useFactory: (): RestFromHttpServiceOptions => ({
            httpService: httpStub as unknown as HttpService,
          }),
        }),
      ],
    }).compile()

    expect(moduleRef.get(RestClient)).toBeInstanceOf(RestClient)
  })

  it('applies the CONSERVATIVE default when resilience is omitted from the factory result', async () => {
    const httpStub = buildHttpServiceStub(successResponse)

    const moduleRef = await Test.createTestingModule({
      imports: [
        RestModule.fromHttpService({
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

  it('applies a supplied resilience override instead of the CONSERVATIVE default', async () => {
    const httpStub = buildHttpServiceStub(successResponse)
    const override: ResilanceConfig<unknown> = {
      retry: { maxAttempts: 1, backoff: 0, shouldRetry: () => true },
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        RestModule.fromHttpService({
          useFactory: (): RestFromHttpServiceOptions => ({
            httpService: httpStub as unknown as HttpService,
            resilience: override,
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

describe('RestModule zero-config import (AC-15)', () => {
  it('AC-15: `Test.createTestingModule({ imports: [RestModule] })` resolves a usable RestClient with the CONSERVATIVE default', async () => {
    // Pins the class-level `@Module({...})` contract: `imports: [RestModule]`
    // (NO factory call, NO forRootAsync) MUST yield a RestClient instance with
    // the documented CONSERVATIVE-preset defaults. Regression guard against
    // the previous `@Module({})` (empty providers) shape that required every
    // consumer to call `forRootAsync` to receive a usable client.
    const moduleRef = await Test.createTestingModule({
      imports: [RestModule],
    }).compile()

    const restClient = moduleRef.get(RestClient)
    expect(restClient).toBeInstanceOf(RestClient)

    // CONSERVATIVE preset = retry → timeout(60 s) → circuitBreaker.
    // The same structural shape the `forRootAsync` default-fallback path
    // produces, asserted here so consumers cannot end up with an
    // accidentally-different default surface depending on import style.
    const wrapped = (restClient.policy as unknown as { wrapped: unknown[] }).wrapped
    expect(wrapped).toHaveLength(3)
    expect(wrapped[0]).toBeInstanceOf(RetryPolicy)
    expect(wrapped[1]).toBeInstanceOf(TimeoutPolicy)
    expect(wrapped[2]).toBeInstanceOf(CircuitBreakerPolicy)
  })

  it('AC-15: `client.get(...)` on the zero-config RestClient does not throw — DI resolution is end-to-end functional', async () => {
    // Beyond `instanceof RestClient`, this test exercises the full call path:
    // verb dispatch → resilience policy → underlying HttpService stub. If the
    // class-level @Module wired the wrong HttpService (or none at all), the
    // call would throw on resolution rather than return a response.
    const moduleRef = await Test.createTestingModule({
      imports: [RestModule],
    })
      .overrideProvider(HttpService)
      .useValue({ get: jest.fn(() => of(successResponse)) })
      .compile()

    const restClient = moduleRef.get(RestClient)

    await expect(restClient.get('/x')).resolves.toBe(successResponse)
  })
})

describe('resolveResilience truth table', () => {
  // The four-case truth table is documented on `resolveResilience` itself.
  // Each test pins ONE row so a regression in any branch is attributable to
  // a specific cell rather than a generic helper failure.

  it('AC-1: axios.timeout > 0 AND resilience absent → strips CONSERVATIVE preset timeout', () => {
    // The axios-wins case: when the consumer set `axios.timeout` and did NOT
    // express their own resilience opinion, the helper applies the CONSERVATIVE
    // preset but strips the per-attempt timeout so the cockatiel pipeline does
    // not impose a SECOND deadline shadowing the axios one.
    const result = resolveResilience({ axios: { timeout: 5_000 } })

    // The returned value must be the CONSERVATIVE preset shape with the
    // timeout slot zeroed — `timeout: undefined` is what
    // `resiliencePolicyBuilder` checks for to skip the TimeoutPolicy attach.
    expect(result).toBeDefined()
    expect(result?.timeout).toBeUndefined()

    // Other CONSERVATIVE fields MUST still be present (retry + circuitBreaker)
    // — the helper only tweaks `timeout`. If a future refactor accidentally
    // dropped the rest of the preset, this assertion catches it.
    expect(result?.retry).toBe(ResiliencePresets.CONSERVATIVE.retry)
    expect(result?.circuitBreaker).toBe(ResiliencePresets.CONSERVATIVE.circuitBreaker)
  })

  it('AC-2: axios.timeout > 0 AND resilience present → user resilience preserved unchanged', () => {
    // The user-wins case: when the consumer supplies their own `resilience`,
    // it MUST be returned verbatim. The helper does not second-guess the user
    // (e.g. by merging in the CONSERVATIVE preset) — `===` equality with the
    // input proves the absence of any defensive cloning.
    const userResilience: ResilanceConfig<unknown> = { timeout: 1_000 }

    const result = resolveResilience({
      axios: { timeout: 5_000 },
      resilience: userResilience,
    })

    expect(result).toBe(userResilience)
    expect(result?.timeout).toBe(1_000)
  })

  it('AC-22: axios.timeout === 0 AND resilience absent → returns undefined (no stripping)', () => {
    // axios `timeout: 0` is the documented "disabled" sentinel. It does NOT
    // mean "I want axios to drive the deadline" — it means "no axios-driven
    // timeout at all". The helper therefore does not strip the preset
    // timeout; the call site falls back to CONSERVATIVE via `?? CONSERVATIVE`.
    const result = resolveResilience({ axios: { timeout: 0 } })

    expect(result).toBeUndefined()
  })

  it('axios undefined AND resilience absent → returns undefined (caller had no opinion)', () => {
    // The "no opinion at all" case: both axios and resilience are absent, so
    // the helper has nothing to reconcile. The call site applies the
    // CONSERVATIVE default via `?? CONSERVATIVE` exactly as it would for
    // a factory that omits both fields.
    const result = resolveResilience({})

    expect(result).toBeUndefined()
  })

  it('axios undefined AND resilience present → returns the user resilience unchanged', () => {
    // Without an axios.timeout to reconcile against, the user's resilience
    // is the unambiguous answer. Same `===` identity guarantee as the
    // axios.timeout > 0 case to prove no cloning.
    const userResilience: ResilanceConfig<unknown> = {
      retry: { maxAttempts: 7, backoff: 0, shouldRetry: () => true },
    }

    const result = resolveResilience({ resilience: userResilience })

    expect(result).toBe(userResilience)
  })

  it('axios.timeout === 0 AND resilience present → user resilience preserved unchanged', () => {
    // Combines AC-22 (axios=0 is "disabled") with AC-2 (user wins). The
    // user's resilience is returned regardless of whether axios.timeout was
    // explicitly disabled or simply absent.
    const userResilience: ResilanceConfig<unknown> = { timeout: 2_500 }

    const result = resolveResilience({
      axios: { timeout: 0 },
      resilience: userResilience,
    })

    expect(result).toBe(userResilience)
  })
})

describe('RestModule.registerAsync hooks wiring (AC-13)', () => {
  it('AC-13: factory-supplied `hooks.onInvoke` runs when the DI-resolved RestClient invokes `get(...)`', async () => {
    // Pins the contract that `RestModuleOptions.hooks` is forwarded as the
    // third positional arg to `new RestClient(...)` so the HookableHttpService
    // lifecycle observes every dispatched verb. If the factory wiring dropped
    // the hooks (e.g. by reading `opts.resilience` only), the spy would never
    // fire and this assertion would catch the regression.
    const onInvoke: jest.Mock = jest.fn()
    const httpServiceStub = { get: jest.fn(() => of(successResponse)) }

    const moduleRef = await Test.createTestingModule({
      imports: [
        RestModule.registerAsync({
          useFactory: (): { hooks: HooksConfig } => ({
            hooks: { onInvoke },
          }),
        }),
      ],
    })
      .overrideProvider(HttpService)
      .useValue(httpServiceStub)
      .compile()

    const restClient = moduleRef.get(RestClient)
    await restClient.get('/x')

    // Exactly one onInvoke per single-attempt success — same contract pinned
    // by `rest.client.spec.ts` AC-11 but exercised here at the DI-resolution
    // layer rather than via direct constructor instantiation.
    expect(onInvoke).toHaveBeenCalledTimes(1)
    expect(onInvoke).toHaveBeenCalledWith(
      'get',
      expect.objectContaining({ url: '/x', config: expect.any(Object) }),
    )
  })
})

/**
 * Compile-time assertions that the `useFactory` parameter list is inferred
 * from the `inject` tuple. These tests intentionally do NOT compile any
 * `expect(...)` calls — their value lies in the `tsc --noEmit` pass. If a
 * future refactor regresses the inference (e.g. the generic is dropped or
 * the `inject` tuple loses its `const` modifier), TypeScript will fail to
 * compile this file and the regression surfaces at build time.
 */
describe('RestModule type inference', () => {
  // Sentinel injectable used as a class token whose resolved type is
  // exactly the class instance type. Constructor is parameter-less so we
  // do not need to wire a sentinel provider to make these snippets compile.
  @Injectable()
  class TypedConfigService {
    getBaseUrl(): string {
      return 'https://api.example.com'
    }
  }

  // A bare module that provides `TypedConfigService` so the snippets below
  // could be compiled against a real DI graph if executed. The snippets in
  // the assertions below are not executed — they are only type-checked.
  @Module({
    providers: [TypedConfigService],
    exports: [TypedConfigService],
  })
  class TypedConfigModule {}

  it('infers useFactory parameter types from inject in registerAsync (compile-time only)', () => {
    // The factory parameter `config` is intentionally NOT annotated — the
    // generic on `registerAsync` resolves it to `TypedConfigService` from
    // the `inject: [TypedConfigService]` tuple. Calling
    // `config.getBaseUrl()` exercises that inference: without it, `config`
    // would be `unknown` and the property access would fail to compile.
    const dynamicModule = RestModule.registerAsync({
      imports: [TypedConfigModule],
      inject: [TypedConfigService],
      useFactory: config => ({
        axios: { baseURL: config.getBaseUrl() },
      }),
    })
    expect(dynamicModule.module).toBe(RestModule)
  })

  it('infers useFactory parameter types from inject in fromHttpService (compile-time only)', () => {
    // Symmetric assertion for `fromHttpService` — also generic-typed.
    const httpStub = {
      get: jest.fn(() => of(successResponse)),
      axiosRef: { defaults: {} } as HttpService['axiosRef'],
    } as unknown as HttpService

    const dynamicModule = RestModule.fromHttpService({
      imports: [TypedConfigModule],
      inject: [TypedConfigService],
      useFactory: config => ({
        httpService: httpStub,
        // Inference also flows into the body — `config.getBaseUrl()` is a
        // string, so the inferred return type matches RestFromHttpServiceOptions.
        // The `getBaseUrl()` call is the load-bearing inference probe.
        resilience: {
          retry: { maxAttempts: 1, backoff: 0, shouldRetry: () => true },
          fallback: { valueOrFactory: config.getBaseUrl() },
        },
      }),
    })
    expect(dynamicModule.module).toBe(RestModule)
  })

  it('supports the zero-arg form (no inject) for registerAsync', () => {
    // The `inject?` field defaults to `readonly []`, so an empty parameter
    // list on `useFactory` must still compile. Inference for the parameter
    // tuple defaults to an empty tuple here.
    const dynamicModule = RestModule.registerAsync({
      useFactory: () => ({
        axios: { baseURL: 'https://api.example.com' },
      }),
    })
    expect(dynamicModule.module).toBe(RestModule)
  })

  it('keeps explicit parameter annotations backward-compatible', () => {
    // Explicit `(config: TypedConfigService)` annotation still compiles.
    // The generic widens to accept either the inferred or the annotated
    // shape — the assertion proves the existing call sites (which use
    // explicit annotations) continue to work unchanged.
    const dynamicModule = RestModule.registerAsync({
      imports: [TypedConfigModule],
      inject: [TypedConfigService],
      useFactory: (config: TypedConfigService) => ({
        axios: { baseURL: config.getBaseUrl() },
      }),
    })
    expect(dynamicModule.module).toBe(RestModule)
  })

  it('ResolveInjectedDeps maps a class-token tuple to the resolved instance tuple', () => {
    // Inline compile-time proof — `Resolved` is the tuple TS resolves for
    // an `inject: [TypedConfigService]` argument. The assignment below
    // would fail to compile if `ResolveInjectedDeps` widened the element to
    // anything other than `TypedConfigService`.
    type Resolved = ResolveInjectedDeps<readonly [typeof TypedConfigService]>
    const probe: Resolved = [new TypedConfigService()]
    expect(probe[0]).toBeInstanceOf(TypedConfigService)
  })
})
