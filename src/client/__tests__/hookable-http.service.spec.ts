import type { AxiosResponse } from 'axios'
import { of } from 'rxjs'

import {
  HookableHttpService,
  type HttpServiceLike,
  type HttpVerb,
  type InvokeArgs,
} from '../hookable-http.service'

/**
 * Concrete subclass of the abstract {@link HookableHttpService} so the spec
 * can exercise the protected `dispatch` template method through the public
 * verb surface. The class adds no behaviour — every public verb defers to the
 * inherited template method.
 */
class ConcreteHookable extends HookableHttpService {}

/**
 * Subclass that exposes the protected {@link HookableHttpService.dispatch}
 * and {@link HookableHttpService.callUnderlying} methods so tests can assert
 * on the template-method override pattern (subclasses pre/post-process the
 * carrier and either delegate to `super.dispatch` or call `callUnderlying`
 * directly to bypass any sibling override).
 */
class DispatchOverrideHookable extends HookableHttpService {
  /** Captures the args the override observed before forwarding. */
  observedArgs: InvokeArgs | undefined

  /**
   * Mutates the carrier (replaces the config) and forwards via
   * {@link HookableHttpService.dispatch}. The base `dispatch` simply calls
   * {@link HookableHttpService.callUnderlying}, so this override proves a
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

describe('HookableHttpService', () => {
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

  describe('axiosRef passthrough', () => {
    it('exposes the underlying axiosRef when the transport carries it', () => {
      const stubHttp = buildHttpServiceStub(successResponse)
      const client = new ConcreteHookable(stubHttp as unknown as HttpServiceLike)

      expect(client.axiosRef).toBe(stubHttp.axiosRef)
    })
  })
})
