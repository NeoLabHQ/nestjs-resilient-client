import type { AxiosResponse } from 'axios'
import { type Observable, of } from 'rxjs'

import {
  BaseHttpService,
  type HttpServiceLike,
  type HttpVerb,
  type InvokeArgs,
} from '../base-http.service'
import {
  HookableHttpService,
  type HooksConfig,
} from '../hookable-http.service'
import type { RxjsPipeline } from '../rxjs-pipeline'

/**
 * Concrete subclass of the abstract {@link BaseHttpService} so the spec
 * can exercise the protected `dispatch` template method through the public
 * verb surface. The class adds no behaviour — every public verb defers to the
 * inherited template method.
 */
class ConcreteHookable extends BaseHttpService {}

/**
 * Subclass that exposes the protected {@link BaseHttpService.dispatch}
 * and {@link BaseHttpService.callUnderlying} methods so tests can assert
 * on the template-method override pattern (subclasses pre/post-process the
 * carrier and either delegate to `super.dispatch` or call `callUnderlying`
 * directly to bypass any sibling override).
 */
class DispatchOverrideHookable extends BaseHttpService {
  /** Captures the args the override observed before forwarding. */
  observedArgs: InvokeArgs | undefined

  /**
   * Mutates the carrier (replaces the config) and forwards via
   * {@link BaseHttpService.dispatch}. The base `dispatch` simply calls
   * {@link BaseHttpService.callUnderlying}, so this override proves a
   * subclass can rewrite the carrier and still reach the transport.
   */
  protected override async dispatch<T = unknown>(
    verb: HttpVerb,
    initialArgs: InvokeArgs,
  ): Promise<AxiosResponse<T>> {
    this.observedArgs = initialArgs
    const next: InvokeArgs = {
      ...initialArgs,
      config: { headers: { 'x-overridden': 'yes' } },
    }
    return super.dispatch<T>(verb, next)
  }

  /** Test-only escape hatch to invoke the protected callUnderlying directly. */
  invokeUnderlying<T = unknown>(verb: HttpVerb, args: InvokeArgs): Promise<AxiosResponse<T>> {
    return this.callUnderlying<T>(verb, args)
  }
}

/**
 * Minimal `HttpService`-shaped stub. Each verb returns the configured value
 * by default — tests override individual verbs to assert on argument
 * forwarding or to substitute different reactive/promise wrappers.
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
    request: jest.fn().mockResolvedValue(response),
    get: jest.fn().mockResolvedValue(response),
    delete: jest.fn().mockResolvedValue(response),
    head: jest.fn().mockResolvedValue(response),
    post: jest.fn().mockResolvedValue(response),
    put: jest.fn().mockResolvedValue(response),
    patch: jest.fn().mockResolvedValue(response),
    postForm: jest.fn().mockResolvedValue(response),
    putForm: jest.fn().mockResolvedValue(response),
    patchForm: jest.fn().mockResolvedValue(response),
    axiosRef: { defaults: {} },
  }
}

const successResponse: AxiosResponse = {
  data: { ok: true },
  status: 200,
  statusText: 'OK',
  headers: {},
  config: {} as AxiosResponse['config'],
}

describe('BaseHttpService', () => {
  describe('default dispatch lifecycle', () => {
    it('delegates straight to the underlying transport without modifying the carrier', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)
      const client = new ConcreteHookable(stubHttp as unknown as HttpServiceLike)

      const result = await client.get('/x', { headers: { 'x-original': 'caller' } })

      expect(result).toBe(successResponse)
      expect(stubHttp.get).toHaveBeenCalledWith('/x', { headers: { 'x-original': 'caller' } })
    })

    it('returns the response produced by the underlying transport unchanged', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)
      const client = new ConcreteHookable(stubHttp as unknown as HttpServiceLike)

      const result = await client.post('/items', { id: 1 })

      // The base dispatch is a pass-through, so the response identity from the
      // underlying transport must surface untouched at the public verb.
      expect(result).toBe(successResponse)
    })
  })

  describe('verb argument shapes', () => {
    it('request forwards `{ config }` to httpService.request without url/data slots', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)
      const client = new ConcreteHookable(stubHttp as unknown as HttpServiceLike)

      await client.request({ url: '/raw', method: 'GET' })

      expect(stubHttp.request).toHaveBeenCalledWith({ url: '/raw', method: 'GET' })
    })

    it('(url, config?) verbs (get/delete/head) carry `url` and a defaulted `config` of `{}` when omitted', async () => {
      for (const verb of ['get', 'delete', 'head'] as const) {
        const stubHttp = buildHttpServiceStub(successResponse)
        const client = new ConcreteHookable(stubHttp as unknown as HttpServiceLike)

        await client[verb]('/users')

        // Omitted config defaults to `{}` so the carrier always observes a
        // non-undefined slot — required by the 401 retry path on
        // AuthRestClient that re-extends `args.config`.
        expect(stubHttp[verb]).toHaveBeenCalledWith('/users', {})
      }
    })

    it('(url, data?, config?) verbs (post/put/patch/*Form) carry `url`, `data`, and a defaulted `config` of `{}`', async () => {
      for (const verb of ['post', 'put', 'patch', 'postForm', 'putForm', 'patchForm'] as const) {
        const stubHttp = buildHttpServiceStub(successResponse)
        const client = new ConcreteHookable(stubHttp as unknown as HttpServiceLike)

        await client[verb]('/items', { id: 7 })

        expect(stubHttp[verb]).toHaveBeenCalledWith('/items', { id: 7 }, {})
      }
    })

    it('forwards explicit url, data, and config slots to the underlying transport', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)
      const client = new ConcreteHookable(stubHttp as unknown as HttpServiceLike)

      await client.post('/items', { id: 1 }, { headers: { 'x-trace': 't' } })

      expect(stubHttp.post).toHaveBeenCalledWith(
        '/items',
        { id: 1 },
        { headers: { 'x-trace': 't' } },
      )
    })
  })

  describe('dispatch override (template-method extension point)', () => {
    it('lets a subclass observe the original carrier and rewrite it before reaching the transport', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)
      const client = new DispatchOverrideHookable(stubHttp as unknown as HttpServiceLike)

      await client.get('/x', { headers: { 'x-original': 'caller' } })

      // The override saw the verb's pristine carrier…
      expect(client.observedArgs).toEqual({
        url: '/x',
        config: { headers: { 'x-original': 'caller' } },
      })
      // …and the transport received the override's substitution.
      expect(stubHttp.get).toHaveBeenCalledWith('/x', { headers: { 'x-overridden': 'yes' } })
    })

    it('exposes callUnderlying as a protected escape hatch that bypasses dispatch overrides', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)
      const client = new DispatchOverrideHookable(stubHttp as unknown as HttpServiceLike)

      // Calling `callUnderlying` directly skips the `dispatch` override — the
      // observed-args hook never fires, and the transport receives the
      // explicit carrier the caller provides. This is the contract relied on
      // by AuthRestClient's 401 retry path (replay without re-running auth
      // pre-flight).
      const result = await client.invokeUnderlying('get', {
        url: '/x',
        config: { headers: { 'x-direct': 'yes' } },
      })

      expect(result).toBe(successResponse)
      expect(client.observedArgs).toBeUndefined()
      expect(stubHttp.get).toHaveBeenCalledWith('/x', { headers: { 'x-direct': 'yes' } })
    })
  })

  describe('underlying transport return-value normalisation', () => {
    it('awaits an Observable<AxiosResponse> via firstValueFrom (HttpService case)', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)
      // HttpService returns Observable; replace the verb to assert the
      // dispatcher unwraps via `firstValueFrom`.
      stubHttp.get.mockReturnValue(of(successResponse))

      const client = new ConcreteHookable(stubHttp as unknown as HttpServiceLike)
      const result = await client.get('/x')

      expect(result).toBe(successResponse)
    })

    it('awaits a Promise<AxiosResponse> directly (RestClient case)', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)
      // RestClient returns Promise — verify the dispatcher does NOT try to
      // observe it as an Observable.
      stubHttp.get.mockReturnValue(Promise.resolve(successResponse))

      const client = new ConcreteHookable(stubHttp as unknown as HttpServiceLike)
      const result = await client.get('/x')

      expect(result).toBe(successResponse)
    })
  })

  describe('rxjsPipeline slot', () => {
    it('applies rxjsPipeline to Observable result when provided (verb + args + source forwarded)', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)
      // Observable transport so the pipeline branch is exercised — Promise
      // transports skip the pipeline entirely.
      stubHttp.get.mockReturnValue(of(successResponse))

      // Identity pipeline — passes the source through unchanged. Wrapped in a
      // jest mock so the spec can assert on the (verb, args, source) it
      // received, proving `callUnderlying` forwards every slot.
      const pipeline = jest.fn<Observable<AxiosResponse>, Parameters<RxjsPipeline>>(
        (_verb, _args, source) => source,
      )

      const client = new ConcreteHookable(
        stubHttp as unknown as HttpServiceLike,
        pipeline,
      )
      const result = await client.get('/x', { headers: { 'x-trace': 't' } })

      // Identity pipeline → response unchanged.
      expect(result).toBe(successResponse)
      // Pipeline received the verb, the carrier args, and the underlying
      // Observable source produced by `invokeVerb`.
      expect(pipeline).toHaveBeenCalledTimes(1)
      const [verb, args, source] = pipeline.mock.calls[0]
      expect(verb).toBe('get')
      expect(args).toEqual({
        url: '/x',
        config: { headers: { 'x-trace': 't' } },
      })
      // The source is the raw Observable returned by the transport — the
      // dispatcher forwards it without unwrapping so the operator owns the
      // subscription strategy.
      expect(typeof (source as Observable<AxiosResponse>).subscribe).toBe('function')
    })

    it('does NOT apply rxjsPipeline to Promise<AxiosResponse> results (RestClient/Auth path)', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)
      // Promise-returning transport — same shape RestClient exposes when
      // wrapped by AuthRestClient. The pipeline contract is defined over
      // Observable, so this branch must skip it entirely.
      stubHttp.get.mockReturnValue(Promise.resolve(successResponse))

      const pipeline = jest.fn<Observable<AxiosResponse>, Parameters<RxjsPipeline>>(
        (_verb, _args, source) => source,
      )

      const client = new ConcreteHookable(
        stubHttp as unknown as HttpServiceLike,
        pipeline,
      )
      const result = await client.get('/x')

      expect(result).toBe(successResponse)
      // Pipeline never ran because the transport returned a Promise.
      expect(pipeline).not.toHaveBeenCalled()
    })

    it('falls back to the raw Observable when no rxjsPipeline is supplied (default behaviour preserved)', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)
      stubHttp.get.mockReturnValue(of(successResponse))

      // No pipeline argument → optional slot is `undefined`, so
      // `callUnderlying` must hand the raw Observable straight to
      // `firstValueFrom` (i.e. behave exactly as it did before the slot
      // was introduced).
      const client = new ConcreteHookable(stubHttp as unknown as HttpServiceLike)
      const result = await client.get('/x')

      expect(result).toBe(successResponse)
    })
  })

  describe('axiosRef passthrough', () => {
    it('exposes the underlying axiosRef when the transport carries it', () => {
      const stubHttp = buildHttpServiceStub(successResponse)
      const client = new ConcreteHookable(stubHttp as unknown as HttpServiceLike)

      expect(client.axiosRef).toBe(stubHttp.axiosRef)
    })
  })
})

describe('HookableHttpService — hooks lifecycle', () => {
  it('AC-8: onInvoke transforms args; the upstream receives the transformed request', async () => {
    const stubHttp = buildHttpServiceStub(successResponse)
    const hooks: HooksConfig = {
      // Attach an X-Hook header by returning a NEW carrier (must not mutate
      // the input). The hook contract requires immutable args handling so
      // the resilience pipeline can re-issue retries from the same source.
      onInvoke: (_verb, args) => ({
        ...args,
        config: {
          ...args.config,
          headers: { ...(args.config.headers ?? {}), 'X-Hook': '1' },
        },
      }),
    }
    const client = new HookableHttpService(stubHttp as unknown as HttpServiceLike, hooks)

    await client.get('/x')

    // The upstream observes the transformed config — proving onInvoke ran
    // BEFORE the inner dispatch and its return value replaced the carrier.
    expect(stubHttp.get).toHaveBeenCalledWith('/x', { headers: { 'X-Hook': '1' } })
  })

  it('AC-9: onReturn substitutes the response; the caller observes the substituted data', async () => {
    const upstream: AxiosResponse = { ...successResponse, data: { id: 1 } }
    const stubHttp = buildHttpServiceStub(upstream)
    const hooks: HooksConfig = {
      // Wrap the response payload — proving onReturn runs AFTER super.dispatch
      // and its return value replaces the response handed back to the caller.
      onReturn: (_verb, _args, response) => ({
        ...response,
        data: { wrapped: response.data },
      }),
    }
    const client = new HookableHttpService(stubHttp as unknown as HttpServiceLike, hooks)

    const result = await client.get<{ wrapped: { id: number } }>('/x')

    expect(result.data).toEqual({ wrapped: { id: 1 } })
  })

  it('AC-10: onError returns AxiosResponse to suppress the error and substitute a fallback response', async () => {
    const stubHttp = buildHttpServiceStub(successResponse)
    const upstreamError = new Error('boom')
    // Force the inner dispatch to throw — onError must intercept and recover.
    stubHttp.get.mockRejectedValue(upstreamError)

    const fallback: AxiosResponse = {
      data: 'fallback',
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as AxiosResponse['config'],
    }
    const hooks: HooksConfig = {
      // Return an AxiosResponse to suppress the original error.
      onError: (_verb, _args, _error) => fallback,
    }
    const client = new HookableHttpService(stubHttp as unknown as HttpServiceLike, hooks)

    const result = await client.get('/x')

    // No throw — the synthetic response substitutes for the upstream failure.
    expect(result).toBe(fallback)
    expect(result.data).toBe('fallback')
  })

  it('AC-10: onError returning undefined rethrows the original error (passthrough)', async () => {
    const stubHttp = buildHttpServiceStub(successResponse)
    const upstreamError = new Error('boom')
    stubHttp.get.mockRejectedValue(upstreamError)

    const hooks: HooksConfig = {
      // `undefined` is the documented passthrough sentinel for onError —
      // the dispatch override MUST rethrow rather than resolve with `undefined`.
      onError: () => undefined,
    }
    const client = new HookableHttpService(stubHttp as unknown as HttpServiceLike, hooks)

    // Identity check: the SAME error instance must surface so the caller's
    // catch handler observes the original failure (not a wrapped/replaced one).
    await expect(client.get('/x')).rejects.toBe(upstreamError)
  })

  it('AC-19: all three hooks returning undefined behaves identically to no-hooks construction', async () => {
    // Two parallel clients, one with all-undefined hooks, one with no hooks.
    // The pair lets the spec assert behavioural identity (same upstream args,
    // same response identity) on both the success and error paths.
    const allUndefinedHooks: HooksConfig = {
      onInvoke: () => undefined,
      onReturn: () => undefined,
      onError: () => undefined,
    }

    // Success path — upstream args and the resolved response must match.
    {
      const stubWithHooks = buildHttpServiceStub(successResponse)
      const stubWithoutHooks = buildHttpServiceStub(successResponse)
      const withHooks = new HookableHttpService(
        stubWithHooks as unknown as HttpServiceLike,
        allUndefinedHooks,
      )
      const withoutHooks = new HookableHttpService(
        stubWithoutHooks as unknown as HttpServiceLike,
      )

      const headers = { 'x-original': 'caller' }
      const resultWith = await withHooks.get('/x', { headers })
      const resultWithout = await withoutHooks.get('/x', { headers })

      // Both upstreams observe IDENTICAL args — proving onInvoke's `undefined`
      // return is a true passthrough rather than a no-op replacement.
      expect(stubWithHooks.get).toHaveBeenCalledWith('/x', { headers })
      expect(stubWithoutHooks.get).toHaveBeenCalledWith('/x', { headers })
      // Both callers observe the SAME response instance — proving onReturn's
      // `undefined` preserves response identity (no `{ ...response }` clone).
      expect(resultWith).toBe(successResponse)
      expect(resultWithout).toBe(successResponse)
    }

    // Error path — the original error must surface unchanged.
    {
      const stubWithHooks = buildHttpServiceStub(successResponse)
      const stubWithoutHooks = buildHttpServiceStub(successResponse)
      const upstreamError = new Error('boom')
      stubWithHooks.get.mockRejectedValue(upstreamError)
      stubWithoutHooks.get.mockRejectedValue(upstreamError)

      const withHooks = new HookableHttpService(
        stubWithHooks as unknown as HttpServiceLike,
        allUndefinedHooks,
      )
      const withoutHooks = new HookableHttpService(
        stubWithoutHooks as unknown as HttpServiceLike,
      )

      // Identical rejection identity proves onError's `undefined` rethrows
      // the ORIGINAL error rather than wrapping it in a derived value.
      await expect(withHooks.get('/x')).rejects.toBe(upstreamError)
      await expect(withoutHooks.get('/x')).rejects.toBe(upstreamError)
    }
  })

  it('AC-20: onInvoke returning Promise<InvokeArgs> is awaited; resolved value is used and ~50ms delay is observable', async () => {
    const stubHttp = buildHttpServiceStub(successResponse)
    const asyncDelayMs = 50
    const hooks: HooksConfig = {
      // Async hook — returns a Promise that resolves AFTER a measurable delay
      // with a transformed carrier. Proves both (a) the dispatch override
      // awaits the hook return value and (b) the resolved value is used as
      // the args (not discarded because it arrived asynchronously).
      onInvoke: async (_verb, args) => {
        await new Promise((resolve) => setTimeout(resolve, asyncDelayMs))
        return {
          ...args,
          config: {
            ...args.config,
            headers: { ...(args.config.headers ?? {}), 'X-Async': '1' },
          },
        }
      },
    }
    const client = new HookableHttpService(stubHttp as unknown as HttpServiceLike, hooks)

    const startedAt = Date.now()
    await client.get('/x')
    const elapsedMs = Date.now() - startedAt

    // The transformed header reaches the upstream — proves the resolved value
    // of the Promise was used as the new args.
    expect(stubHttp.get).toHaveBeenCalledWith('/x', { headers: { 'X-Async': '1' } })
    // The caller's promise resolves no earlier than ~50 ms after invocation —
    // proves the dispatch override awaited the hook's Promise rather than
    // discarding it. A small (-5 ms) tolerance accounts for timer-resolution
    // variance on slower runners; the load-bearing assertion is "not faster
    // than the hook's delay", not exactness.
    expect(elapsedMs).toBeGreaterThanOrEqual(asyncDelayMs - 5)
  })
})
