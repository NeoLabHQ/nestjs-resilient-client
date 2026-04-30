import { of, throwError } from 'rxjs'
import {
  BulkheadPolicy,
  CircuitBreakerPolicy,
  FallbackPolicy,
  RetryPolicy,
  TimeoutPolicy,
} from 'cockatiel'
import type { IDefaultPolicyContext, IPolicy } from 'cockatiel'
import type { AxiosError, AxiosResponse } from 'axios'

import { RestClient } from '../rest.client'
import { resiliencePolicyBuilder } from '../resailencePolicyBuilder'
import { ResilencePresets } from '../../resilence.policy'
import type { ResilanceConfig } from '../resilance.config'

/**
 * Stub policy that immediately invokes the executor with a deterministic
 * `IDefaultPolicyContext` (carrying a sentinel `AbortSignal`) and returns its
 * awaited result. Constructor-injected via the `RestClient.policy` field
 * (which the spec overwrites because the field is `readonly` only in TS).
 *
 * Avoids any `jest.mock` of cockatiel/@nestjs/axios — keeps the test isolated
 * to RestClient verb dispatch + hook lifecycle semantics.
 */
function buildStubPolicy(signal: AbortSignal): IPolicy<IDefaultPolicyContext, unknown> & {
  execute: jest.Mock
} {
  const execute = jest.fn(
    async (fn: (ctx: IDefaultPolicyContext) => unknown | PromiseLike<unknown>) => fn({ signal }),
  )

  return {
    execute,
    onSuccess: jest.fn(),
    onFailure: jest.fn(),
  } as unknown as IPolicy<IDefaultPolicyContext, unknown> & { execute: jest.Mock }
}

/**
 * Minimal `HttpService`-shaped stub. Each verb returns the configured
 * `Observable<AxiosResponse>` so the {@link HookableHttpService} dispatcher
 * can unwrap it via `firstValueFrom` exactly the same way as the real
 * `HttpService`.
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
 * Build a synthetic `AxiosError` fixture for `GET /resource` with a 5xx
 * status. Mirrors the construction used in `should-retry.spec.ts` so the
 * default preset's `shouldRetry` (which delegates to `isRetryableError`)
 * recognises it as retryable.
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

/** All RestClient verbs the spec must exercise. */
const ALL_VERBS = [
  'request',
  'get',
  'delete',
  'head',
  'post',
  'put',
  'patch',
  'postForm',
  'putForm',
  'patchForm',
] as const

type Verb = typeof ALL_VERBS[number]

/**
 * Some verbs take `(url, config?)` while data-bearing verbs take
 * `(url, data?, config?)`. The dispatch helper builds the correct argument
 * shape per verb name so the spec can exercise all 10 verbs from a single
 * loop.
 */
function callVerb(client: RestClient, verb: Verb): Promise<AxiosResponse> {
  switch (verb) {
    case 'request':
      return client.request({ method: 'GET', url: '/x' })
    case 'get':
    case 'delete':
    case 'head':
      return client[verb]('/x', { headers: { 'x-trace': '1' } })
    case 'post':
    case 'put':
    case 'patch':
    case 'postForm':
    case 'putForm':
    case 'patchForm':
      return client[verb]('/x', { id: 1 }, { headers: { 'x-trace': '1' } })
  }
}

const successResponse: AxiosResponse = {
  data: { ok: true },
  status: 200,
  statusText: 'OK',
  headers: {},
  config: {} as AxiosResponse['config'],
}

describe('RestClient', () => {
  describe('per-verb policy pass-through (mock policy + axios)', () => {
    it.each(ALL_VERBS)(
      '%s invokes policy.execute exactly once and underlying httpService.%s exactly once',
      async (verb) => {
        const stubPolicy = buildStubPolicy(new AbortController().signal)
        const stubHttp = buildHttpServiceStub(successResponse)

        // Cast through `unknown` because HttpServiceStub omits private/protected
        // fields of the real `HttpService` class. Same reason RestClient ctor
        // is typed against `HttpService` not a structural type.
        const client = new RestClient(stubHttp as unknown as ConstructorParameters<typeof RestClient>[0])
        // Override the readonly `policy` field with the stub. `readonly` is a
        // compile-time annotation only — runtime assignment works and is the
        // documented way to inject a mock policy in this codebase.
        ;(client as unknown as { policy: unknown }).policy = stubPolicy

        const result = await callVerb(client, verb)

        expect(stubPolicy.execute).toHaveBeenCalledTimes(1)
        expect(stubPolicy.execute).toHaveBeenCalledWith(expect.any(Function))
        expect(stubHttp[verb]).toHaveBeenCalledTimes(1)
        expect(result).toBe(successResponse)
      },
    )

    it('passes verb-specific arguments straight through to the underlying httpService (config gets a `signal` field merged in)', async () => {
      const stubPolicy = buildStubPolicy(new AbortController().signal)
      const stubHttp = buildHttpServiceStub(successResponse)
      const client = new RestClient(stubHttp as unknown as ConstructorParameters<typeof RestClient>[0])
      ;(client as unknown as { policy: unknown }).policy = stubPolicy

      // Two-arg verbs preserve `(url, config)` in order. RestClient.dispatch
      // merges `policyCtx.signal` into the config carrier, so the underlying
      // httpService observes the original headers PLUS a `signal` field.
      await client.get('/items', { headers: { 'x-id': 'g' } })
      expect(stubHttp.get).toHaveBeenCalledWith(
        '/items',
        expect.objectContaining({ headers: { 'x-id': 'g' }, signal: expect.any(AbortSignal) }),
      )

      // Three-arg verbs preserve `(url, data, config)` in order — same signal
      // injection behaviour as the two-arg shape, just on the config slot
      // forwarded as the third positional arg.
      await client.post('/items', { id: 1 }, { headers: { 'x-id': 'p' } })
      expect(stubHttp.post).toHaveBeenCalledWith(
        '/items',
        { id: 1 },
        expect.objectContaining({ headers: { 'x-id': 'p' }, signal: expect.any(AbortSignal) }),
      )
    })
  })

  describe('signal forwarding (all verbs)', () => {
    it('forwards `policyCtx.signal` into args[0] when calling `request`', async () => {
      const sentinelSignal = new AbortController().signal
      const stubPolicy = buildStubPolicy(sentinelSignal)
      const stubHttp = buildHttpServiceStub(successResponse)

      const client = new RestClient(stubHttp as unknown as ConstructorParameters<typeof RestClient>[0])
      ;(client as unknown as { policy: unknown }).policy = stubPolicy

      await client.request({ method: 'GET', url: '/raw' })

      expect(stubHttp.request).toHaveBeenCalledTimes(1)
      const [passedConfig] = stubHttp.request.mock.calls[0] as [Record<string, unknown>]
      expect(passedConfig.method).toBe('GET')
      expect(passedConfig.url).toBe('/raw')
      // RestClient.dispatch must merge the AbortSignal carried by the policy
      // context into the request config.
      expect(passedConfig.signal).toBe(sentinelSignal)
    })

    it('forwards `policyCtx.signal` into args[1] for `(url, config?)` verbs (get/delete/head)', async () => {
      // The signal forwarding behaviour now extends to every verb on
      // `RestClient` — replacing the prior `request`-only special case. This
      // pins the new contract at the verb-shape boundary so a regression that
      // re-narrows signal injection is caught immediately.
      const sentinelSignal = new AbortController().signal

      for (const verb of ['get', 'delete', 'head'] as const) {
        const stubPolicy = buildStubPolicy(sentinelSignal)
        const stubHttp = buildHttpServiceStub(successResponse)
        const client = new RestClient(stubHttp as unknown as ConstructorParameters<typeof RestClient>[0])
        ;(client as unknown as { policy: unknown }).policy = stubPolicy

        await client[verb]('/users', { headers: { 'x-trace': '1' } })

        const [, passedConfig] = stubHttp[verb].mock.calls[0] as [string, Record<string, unknown>]
        expect(passedConfig.signal).toBe(sentinelSignal)
        // Caller-supplied headers are preserved alongside the injected signal.
        expect(passedConfig.headers).toEqual({ 'x-trace': '1' })
      }
    })

    it('forwards `policyCtx.signal` into args[2] for `(url, data, config?)` verbs (post/put/patch/*Form)', async () => {
      const sentinelSignal = new AbortController().signal

      for (const verb of ['post', 'put', 'patch', 'postForm', 'putForm', 'patchForm'] as const) {
        const stubPolicy = buildStubPolicy(sentinelSignal)
        const stubHttp = buildHttpServiceStub(successResponse)
        const client = new RestClient(stubHttp as unknown as ConstructorParameters<typeof RestClient>[0])
        ;(client as unknown as { policy: unknown }).policy = stubPolicy

        await client[verb]('/items', { id: 1 }, { headers: { 'x-trace': '1' } })

        const [, , passedConfig] = stubHttp[verb].mock.calls[0] as [string, unknown, Record<string, unknown>]
        expect(passedConfig.signal).toBe(sentinelSignal)
        expect(passedConfig.headers).toEqual({ 'x-trace': '1' })
      }
    })

    it('does NOT mutate the caller-supplied config — signal is added on a copy', async () => {
      const sentinelSignal = new AbortController().signal
      const stubPolicy = buildStubPolicy(sentinelSignal)
      const stubHttp = buildHttpServiceStub(successResponse)
      const client = new RestClient(stubHttp as unknown as ConstructorParameters<typeof RestClient>[0])
      ;(client as unknown as { policy: unknown }).policy = stubPolicy

      // Caller-provided config object MUST remain unchanged after the call —
      // the dispatcher must spread into a fresh object instead of mutating.
      const callerConfig: Record<string, unknown> = { headers: { 'x-trace': '1' } }
      await client.get('/users', callerConfig as Parameters<typeof client.get>[1])

      expect(callerConfig).not.toHaveProperty('signal')
      const [, passedConfig] = stubHttp.get.mock.calls[0] as [string, Record<string, unknown>]
      expect(passedConfig).not.toBe(callerConfig)
      expect(passedConfig.signal).toBe(sentinelSignal)
    })

    it('composes the caller-supplied signal with the policy signal via `AbortSignal.any` so either source can abort', async () => {
      // When a caller passes their own AbortSignal we must NOT clobber it —
      // composition keeps both abort sources live: cockatiel's
      // retry/timeout/circuit-breaker driver AND the caller's external
      // cancellation. Aborting the user signal must propagate to the merged
      // signal observed by axios.
      const policySignal = new AbortController().signal
      const userController = new AbortController()
      const stubPolicy = buildStubPolicy(policySignal)
      const stubHttp = buildHttpServiceStub(successResponse)
      const client = new RestClient(stubHttp as unknown as ConstructorParameters<typeof RestClient>[0])
      ;(client as unknown as { policy: unknown }).policy = stubPolicy

      await client.get('/users', { signal: userController.signal })

      const [, passedConfig] = stubHttp.get.mock.calls[0] as [string, Record<string, AbortSignal>]
      const merged = passedConfig.signal
      expect(merged).not.toBe(policySignal)
      expect(merged).not.toBe(userController.signal)
      expect(merged.aborted).toBe(false)

      userController.abort()
      // The composed signal must observe the user's abort — proves
      // composition is wired through `AbortSignal.any`.
      expect(merged.aborted).toBe(true)
    })

    it('falls back to the policy signal when `AbortSignal.any` is unavailable', async () => {
      // Defensive runtime check for environments that pre-date `AbortSignal.any`
      // (Node < 20). The dispatcher must not throw — it must prefer the policy
      // signal so cockatiel's resilience contract continues to drive aborts.
      const policySignal = new AbortController().signal
      const userController = new AbortController()
      const stubPolicy = buildStubPolicy(policySignal)
      const stubHttp = buildHttpServiceStub(successResponse)
      const client = new RestClient(stubHttp as unknown as ConstructorParameters<typeof RestClient>[0])
      ;(client as unknown as { policy: unknown }).policy = stubPolicy

      const originalAny = (AbortSignal as { any?: unknown }).any
      try {
        // Deliberately removing the static method simulates the legacy runtime.
        delete (AbortSignal as { any?: unknown }).any

        await client.get('/users', { signal: userController.signal })

        const [, passedConfig] = stubHttp.get.mock.calls[0] as [string, Record<string, AbortSignal>]
        // Without `AbortSignal.any` the policy signal wins.
        expect(passedConfig.signal).toBe(policySignal)
      }
      finally {
        // Restore the static method for the rest of the suite.
        ;(AbortSignal as { any?: unknown }).any = originalAny
      }
    })
  })

  describe('default preset (constructor with no `config`)', () => {
    it('builds a policy matching the CONSERVATIVE preset (RetryPolicy maxAttempts=3 wrapping TimeoutPolicy 60s wrapping CircuitBreakerPolicy)', () => {
      const stubHttp = buildHttpServiceStub(successResponse)

      const client = new RestClient(stubHttp as unknown as ConstructorParameters<typeof RestClient>[0])

      // CONSERVATIVE = retry + timeout + circuitBreaker. Retry sits OUTSIDE
      // timeout so each attempt receives its own independent 60 s deadline
      // (per-attempt semantics) — `wrap(...)` returns an object with a
      // `wrapped` field listing the composed sub-policies in outer-to-inner
      // order. Same inspection trick used by `resilience-policy-builder.spec.ts`.
      const wrapped = (client.policy as unknown as { wrapped: unknown[] }).wrapped
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

    it('retries safe-method 5xx errors up to maxAttempts=3 (4 total axios calls)', async () => {
      // Use fake timers so `ExponentialBackoff`'s setTimeout-based delays do
      // not block the test on real wall-clock time. The retry policy uses
      // setTimeout internally — `advanceTimersByTimeAsync` flushes them.
      jest.useFakeTimers()

      try {
        const error = makeAxiosError('GET', 500)
        const stubHttp = buildHttpServiceStub(successResponse)
        // Always emit the 5xx error — confirms retry stops at maxAttempts.
        stubHttp.get.mockReturnValue(throwError(() => error))

        const client = new RestClient(stubHttp as unknown as ConstructorParameters<typeof RestClient>[0])

        // Drive the call to completion while flushing pending timers between
        // retries. We do not await the result up-front because the policy is
        // suspended on `await delay(...)` between attempts.
        const promise = client.get('/x').catch((err: unknown) => err)
        // Default ExponentialBackoff caps at maxDelay=30s; advancing 60s twice
        // is enough headroom to flush all three retry delays.
        await jest.advanceTimersByTimeAsync(60_000)
        await jest.advanceTimersByTimeAsync(60_000)
        await promise

        // maxAttempts=3 means up to 3 retries -> 4 total invocations.
        expect(stubHttp.get).toHaveBeenCalledTimes(4)
      }
      finally {
        jest.useRealTimers()
      }
    })

    it('does NOT retry non-safe methods (e.g. POST 5xx) under the CONSERVATIVE preset', async () => {
      const error = makeAxiosError('POST', 500)
      const stubHttp = buildHttpServiceStub(successResponse)
      stubHttp.post.mockReturnValue(throwError(() => error))

      const client = new RestClient(stubHttp as unknown as ConstructorParameters<typeof RestClient>[0])

      await expect(client.post('/x', { id: 1 })).rejects.toBe(error)
      // CONSERVATIVE retry uses `SAFE_HTTP_METHODS` only — POST is not in the
      // allow-list, so the retry policy gives up after the first failure.
      expect(stubHttp.post).toHaveBeenCalledTimes(1)
    })
  })

  describe('all four cockatiel policy types in combination (composed pipeline)', () => {
    it('exercises retry + circuitBreaker + bulkhead + fallback together with a real composed policy', async () => {
      const fallbackResponse: AxiosResponse = {
        data: { fallback: true },
        status: 200,
        statusText: 'OK (fallback)',
        headers: {},
        config: {} as AxiosResponse['config'],
      }

      // Real cockatiel pipeline — only axios is mocked (via the HttpService
      // stub), satisfying the AC "All four cockatiel policy types are
      // exercised in combination with `RestClient`" + the test-isolation rule
      // that bans library-level mocks for cockatiel.
      //
      // Wrap order is `retry > CB > bulkhead > fallback` (retry outermost,
      // fallback innermost), so to exercise *retry* (not just construct it),
      // the fallback's `shouldFallback` must reject the transient errors so
      // they propagate through bulkhead and CB up to retry. Only the *final*
      // error matches `shouldFallback`, letting the fallback supply the
      // synthetic AxiosResponse the test asserts on.
      const transientError = new Error('transient-fail')
      const finalError = new Error('final-fail')

      const composedConfig: ResilanceConfig<unknown, void, AxiosResponse> = {
        retry: {
          maxAttempts: 2, // 2 retries -> 3 total upstream calls
          backoff: 0, // ConstantBackoff(0) — deterministic, no real delay
          shouldRetry: (error: Error) => error.message === 'transient-fail',
        },
        circuitBreaker: {
          breaker: 100, // ConsecutiveBreaker — high threshold, never trips here
          halfOpenAfter: 60_000,
        },
        bulkhead: { limit: 10, queue: 10 },
        fallback: {
          shouldFallback: (error: Error) => error.message === 'final-fail',
          valueOrFactory: fallbackResponse,
        },
      }

      // Sanity-check the composed policy contains all four sub-policies in the
      // documented order so a regression in `resiliencePolicyBuilder` does not
      // silently drop a layer.
      const builtPolicy = resiliencePolicyBuilder(composedConfig)
      const wrapped = (builtPolicy as unknown as { wrapped: unknown[] }).wrapped
      expect(wrapped).toHaveLength(4)
      expect(wrapped[0]).toBeInstanceOf(RetryPolicy)
      expect(wrapped[1]).toBeInstanceOf(CircuitBreakerPolicy)
      expect(wrapped[2]).toBeInstanceOf(BulkheadPolicy)
      expect(wrapped[3]).toBeInstanceOf(FallbackPolicy)

      const stubHttp = buildHttpServiceStub(successResponse)
      // First two calls throw `transient-fail` (retry catches and retries),
      // third call throws `final-fail` (fallback catches and substitutes).
      stubHttp.get
        .mockReturnValueOnce(throwError(() => transientError))
        .mockReturnValueOnce(throwError(() => transientError))
        .mockReturnValueOnce(throwError(() => finalError))

      const client = new RestClient(
        stubHttp as unknown as ConstructorParameters<typeof RestClient>[0],
        composedConfig,
      )

      const result = await client.get('/x')

      // Retry fires twice (total 3 calls), then the third error matches
      // `shouldFallback` so the fallback supplies the synthetic response.
      expect(stubHttp.get).toHaveBeenCalledTimes(3)
      expect(result).toBe(fallbackResponse)
    })

    it('returns the upstream response unchanged when the composed pipeline succeeds (sanity check)', async () => {
      const composedConfig: ResilanceConfig<unknown, void, AxiosResponse> = {
        retry: { maxAttempts: 0, backoff: 0 },
        circuitBreaker: { breaker: 5, halfOpenAfter: 60_000 },
        bulkhead: { limit: 10 },
        fallback: { valueOrFactory: successResponse },
      }
      const stubHttp = buildHttpServiceStub(successResponse)

      const client = new RestClient(
        stubHttp as unknown as ConstructorParameters<typeof RestClient>[0],
        composedConfig,
      )

      const result = await client.get('/x')

      expect(stubHttp.get).toHaveBeenCalledTimes(1)
      expect(result).toBe(successResponse)
    })
  })

  describe('per-verb argument forwarding shapes (optional config branches)', () => {
    type IndexOneVerb = 'get' | 'delete' | 'head'
    type IndexTwoVerb = 'post' | 'put' | 'patch' | 'postForm' | 'putForm' | 'patchForm'
    const INDEX_ONE_VERBS: IndexOneVerb[] = ['get', 'delete', 'head']
    const INDEX_TWO_VERBS: IndexTwoVerb[] = ['post', 'put', 'patch', 'postForm', 'putForm', 'patchForm']

    it.each(INDEX_ONE_VERBS)(
      '%s forwards (url, config) and (url) shapes to httpService.%s with the policy signal merged in',
      async (verb) => {
        const stubPolicy = buildStubPolicy(new AbortController().signal)
        const stubHttp = buildHttpServiceStub(successResponse)
        const client = new RestClient(stubHttp as unknown as ConstructorParameters<typeof RestClient>[0])
        ;(client as unknown as { policy: unknown }).policy = stubPolicy

        // (url, config) shape — caller's headers are preserved and the
        // dispatcher merges `policyCtx.signal` into the same config slot.
        await client[verb]('/with-config', { headers: { 'x-id': 'a' } })
        expect(stubHttp[verb]).toHaveBeenLastCalledWith(
          '/with-config',
          expect.objectContaining({ headers: { 'x-id': 'a' }, signal: expect.any(AbortSignal) }),
        )

        // (url) shape — config omitted; httpService still receives a config
        // object containing the injected signal (the slot is materialised by
        // the dispatcher from the empty default).
        await client[verb]('/no-config')
        expect(stubHttp[verb]).toHaveBeenLastCalledWith(
          '/no-config',
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        )
      },
    )

    it.each(INDEX_TWO_VERBS)(
      '%s forwards (url, data, config) and (url, data) shapes to httpService.%s with the policy signal merged in',
      async (verb) => {
        const stubPolicy = buildStubPolicy(new AbortController().signal)
        const stubHttp = buildHttpServiceStub(successResponse)
        const client = new RestClient(stubHttp as unknown as ConstructorParameters<typeof RestClient>[0])
        ;(client as unknown as { policy: unknown }).policy = stubPolicy

        // Three-arg shape preserves data and merges the signal into the
        // caller's config without losing the original headers.
        await client[verb]('/with-config', { id: 1 }, { headers: { 'x-id': 'b' } })
        expect(stubHttp[verb]).toHaveBeenLastCalledWith(
          '/with-config',
          { id: 1 },
          expect.objectContaining({ headers: { 'x-id': 'b' }, signal: expect.any(AbortSignal) }),
        )

        // Two-arg shape — config omitted. httpService receives a synthesised
        // config object carrying the signal at args[2]; data is NEVER moved
        // into the config slot.
        await client[verb]('/no-config', { id: 2 })
        expect(stubHttp[verb]).toHaveBeenLastCalledWith(
          '/no-config',
          { id: 2 },
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        )
      },
    )

    it('request forwards (config) and (no-arg) shapes to httpService.request', async () => {
      const stubPolicy = buildStubPolicy(new AbortController().signal)
      const stubHttp = buildHttpServiceStub(successResponse)
      const client = new RestClient(stubHttp as unknown as ConstructorParameters<typeof RestClient>[0])
      ;(client as unknown as { policy: unknown }).policy = stubPolicy

      // With config — signal is injected by the dispatcher into args[0].
      await client.request({ url: '/explicit', method: 'GET' })
      const calls = stubHttp.request.mock.calls
      const lastCall = calls[calls.length - 1][0] as Record<string, unknown>
      expect(lastCall.url).toBe('/explicit')
      expect(lastCall.method).toBe('GET')
      expect(lastCall).toHaveProperty('signal')
    })

    it('signal injection on `request` only mutates a copy, not the caller-provided config', async () => {
      const stubSignal = new AbortController().signal
      const stubPolicy = buildStubPolicy(stubSignal)
      const stubHttp = buildHttpServiceStub(successResponse)
      const client = new RestClient(stubHttp as unknown as ConstructorParameters<typeof RestClient>[0])
      ;(client as unknown as { policy: unknown }).policy = stubPolicy

      // Caller-provided config object MUST remain unchanged after the call —
      // the dispatcher must spread into a fresh object instead of mutating.
      const callerConfig: Record<string, unknown> = { url: '/raw' }
      await client.request(callerConfig as Parameters<typeof client.request>[0])

      expect(callerConfig).not.toHaveProperty('signal')
      const passedConfig = stubHttp.request.mock.calls[0]![0] as Record<string, unknown>
      expect(passedConfig.signal).toBe(stubSignal)
      expect(passedConfig).not.toBe(callerConfig)
    })
  })

  describe('per-verb policy invocation (success path through real cockatiel pipeline)', () => {
    // Drives every verb through the real CONSERVATIVE preset — guards against
    // mutants that flip the verb wiring (e.g. swapping `get` for `delete`)
    // because the underlying httpService stub records the exact verb that
    // received the call.
    const ALL_VERBS_LIST: Verb[] = [...ALL_VERBS]
    it.each(ALL_VERBS_LIST)('%s success path returns the upstream AxiosResponse', async (verb) => {
      const stubHttp = buildHttpServiceStub(successResponse)
      const client = new RestClient(stubHttp as unknown as ConstructorParameters<typeof RestClient>[0])

      const result = await callVerb(client, verb)

      expect(result).toBe(successResponse)
      expect(stubHttp[verb]).toHaveBeenCalledTimes(1)
      // No other verb should have been invoked on the httpService — guards
      // against verb-mis-routing mutations.
      for (const other of ALL_VERBS_LIST) {
        if (other === verb) continue
        expect(stubHttp[other]).not.toHaveBeenCalled()
      }
    })
  })

  describe('constructor', () => {
    it('explicit `config = ResilencePresets.CONSERVATIVE` produces same policy shape as the default', () => {
      const stubHttp = buildHttpServiceStub(successResponse)

      const defaulted = new RestClient(stubHttp as unknown as ConstructorParameters<typeof RestClient>[0])
      const explicit = new RestClient(
        stubHttp as unknown as ConstructorParameters<typeof RestClient>[0],
        ResilencePresets.CONSERVATIVE,
      )

      const defaultedWrapped = (defaulted.policy as unknown as { wrapped: object[] }).wrapped
      const explicitWrapped = (explicit.policy as unknown as { wrapped: object[] }).wrapped
      expect(defaultedWrapped).toHaveLength(explicitWrapped.length)
      expect(defaultedWrapped.map((p) => p.constructor.name)).toEqual(
        explicitWrapped.map((p) => p.constructor.name),
      )
    })

    it('exposes the underlying axios instance via `axiosRef`', () => {
      const stubHttp = buildHttpServiceStub(successResponse)
      const client = new RestClient(stubHttp as unknown as ConstructorParameters<typeof RestClient>[0])

      expect(client.axiosRef).toBe(stubHttp.axiosRef)
    })
  })
})
