import type { AxiosResponse } from 'axios'
import { of } from 'rxjs'

import {
  HookableHttpService,
  type HooksConfig,
  type HttpServiceLike,
  type InvokeArgs,
  type ReturnArgs,
} from '../hookable-http.service'

/**
 * Concrete subclass of the abstract {@link HookableHttpService} so the spec
 * can exercise the protected `dispatch` lifecycle through the public verb
 * surface. The class adds no behaviour — every public verb defers to the
 * inherited template method.
 */
class ConcreteHookable extends HookableHttpService {}

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
  describe('dispatch lifecycle', () => {
    it('runs onInvoke before the underlying transport call and onReturn after', async () => {
      const callOrder: string[] = []
      const stubHttp = buildHttpServiceStub(successResponse)
      stubHttp.get.mockImplementation(async () => {
        callOrder.push('underlying')
        return successResponse
      })

      const hooks: HooksConfig = {
        onInvoke: (args) => {
          callOrder.push('onInvoke')
          return args
        },
        onReturn: (args) => {
          callOrder.push('onReturn')
          return args
        },
      }

      const client = new ConcreteHookable(stubHttp as unknown as HttpServiceLike, hooks)
      await client.get('/x')

      // onInvoke MUST run before the call, onReturn MUST run after it.
      expect(callOrder).toEqual(['onInvoke', 'underlying', 'onReturn'])
    })

    it('forwards onInvoke-modified args to the underlying transport (config substitution)', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)
      const hooks: HooksConfig = {
        onInvoke: (args) => ({
          ...args,
          // Replace the entire config so the underlying transport receives
          // the hook's substitution rather than the caller's original.
          config: { headers: { 'x-injected': 'yes' } },
        }),
      }

      const client = new ConcreteHookable(stubHttp as unknown as HttpServiceLike, hooks)
      await client.get('/x', { headers: { 'x-original': 'caller' } })

      expect(stubHttp.get).toHaveBeenCalledWith(
        '/x',
        { headers: { 'x-injected': 'yes' } },
      )
    })

    it('substitutes the response when onReturn returns a different response field', async () => {
      const substituted: AxiosResponse = {
        data: { fallback: true },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as AxiosResponse['config'],
      }
      const stubHttp = buildHttpServiceStub(successResponse)
      const hooks: HooksConfig = {
        onReturn: (args) => ({ ...args, response: substituted }),
      }

      const client = new ConcreteHookable(stubHttp as unknown as HttpServiceLike, hooks)
      const result = await client.get('/x')

      expect(result).toBe(substituted)
    })

    it('treats hooks as optional — dispatching without hooks delegates straight through to the transport', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)
      const client = new ConcreteHookable(stubHttp as unknown as HttpServiceLike)

      const result = await client.get('/x', { headers: { 'x-original': 'caller' } })

      expect(result).toBe(successResponse)
      expect(stubHttp.get).toHaveBeenCalledWith('/x', { headers: { 'x-original': 'caller' } })
    })

    it('awaits async onInvoke / onReturn hooks before continuing the lifecycle', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)
      const seen: string[] = []

      const hooks: HooksConfig = {
        onInvoke: async (args) => {
          await Promise.resolve()
          seen.push('async-onInvoke')
          return args
        },
        onReturn: async (args) => {
          await Promise.resolve()
          seen.push('async-onReturn')
          return args
        },
      }

      const client = new ConcreteHookable(stubHttp as unknown as HttpServiceLike, hooks)
      await client.get('/x')

      // Both hooks observed (proves the dispatcher awaits async results) and
      // ordered correctly across the underlying call.
      expect(seen).toEqual(['async-onInvoke', 'async-onReturn'])
    })
  })

  describe('verb argument shapes', () => {
    it('request forwards `{ config }` to httpService.request without url/data slots', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)
      let captured: InvokeArgs | undefined
      const hooks: HooksConfig = {
        onInvoke: (args) => {
          captured = args
          return args
        },
      }
      const client = new ConcreteHookable(stubHttp as unknown as HttpServiceLike, hooks)

      await client.request({ url: '/raw', method: 'GET' })

      expect(captured).toEqual({ config: { url: '/raw', method: 'GET' } })
      expect(stubHttp.request).toHaveBeenCalledWith({ url: '/raw', method: 'GET' })
    })

    it('(url, config?) verbs (get/delete/head) carry `url` and a defaulted `config` of `{}` when omitted', async () => {
      for (const verb of ['get', 'delete', 'head'] as const) {
        const stubHttp = buildHttpServiceStub(successResponse)
        let captured: InvokeArgs | undefined
        const hooks: HooksConfig = {
          onInvoke: (args) => {
            captured = args
            return args
          },
        }
        const client = new ConcreteHookable(stubHttp as unknown as HttpServiceLike, hooks)

        await client[verb]('/users')

        // Omitted config defaults to `{}` so the hook always observes a
        // non-undefined slot — required by the 401 retry path on
        // AuthRestClient that re-extends `args.config`.
        expect(captured).toEqual({ url: '/users', config: {} })
      }
    })

    it('(url, data?, config?) verbs (post/put/patch/*Form) carry `url`, `data`, and a defaulted `config` of `{}`', async () => {
      for (const verb of ['post', 'put', 'patch', 'postForm', 'putForm', 'patchForm'] as const) {
        const stubHttp = buildHttpServiceStub(successResponse)
        let captured: InvokeArgs | undefined
        const hooks: HooksConfig = {
          onInvoke: (args) => {
            captured = args
            return args
          },
        }
        const client = new ConcreteHookable(stubHttp as unknown as HttpServiceLike, hooks)

        await client[verb]('/items', { id: 7 })

        expect(captured).toEqual({ url: '/items', data: { id: 7 }, config: {} })
      }
    })

    it('forwards onInvoke-modified url and data slots to the underlying transport', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)
      const hooks: HooksConfig = {
        onInvoke: (args) => ({ ...args, url: '/rewritten', data: { rewritten: true } }),
      }
      const client = new ConcreteHookable(stubHttp as unknown as HttpServiceLike, hooks)

      await client.post('/original', { id: 1 })

      // The dispatcher reads the verb-specific positional args from the
      // (possibly mutated) carrier, so onInvoke can rewrite url and data —
      // not just config.
      expect(stubHttp.post).toHaveBeenCalledWith('/rewritten', { rewritten: true }, {})
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

  describe('return type carrier', () => {
    it('passes the full ReturnArgs carrier (config/url/data/response) to onReturn', async () => {
      const stubHttp = buildHttpServiceStub(successResponse)
      let returnArgs: ReturnArgs | undefined
      const hooks: HooksConfig = {
        onReturn: (args) => {
          returnArgs = args
          return args
        },
      }
      const client = new ConcreteHookable(stubHttp as unknown as HttpServiceLike, hooks)

      await client.post('/items', { id: 1 }, { headers: { 'x-trace': 't' } })

      expect(returnArgs).toEqual({
        url: '/items',
        data: { id: 1 },
        config: { headers: { 'x-trace': 't' } },
        response: successResponse,
      })
    })
  })
})
