import { of } from 'rxjs'
import type { IDefaultPolicyContext, IPolicy } from 'cockatiel'
import type { AxiosResponse } from 'axios'

import { ExecuteWithPolicy } from '../execute-with-policy.decorator'

/**
 * Constructor-injected stub policy that immediately invokes the executor with a
 * deterministic policy context (carrying a sentinel `AbortSignal`) and returns
 * its awaited result. Avoids any `jest.mock` of cockatiel/axios/@nestjs/axios,
 * keeping the test isolated to decorator semantics.
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

describe('ExecuteWithPolicy decorator', () => {
  describe('policy execution', () => {
    it('should invoke policy.execute exactly once per call', async () => {
      const stubSignal = new AbortController().signal
      const stubPolicy = buildStubPolicy(stubSignal)
      const response = { data: 'ok', status: 200 } as AxiosResponse

      class TestClient {
        constructor(public policy: IPolicy<IDefaultPolicyContext, unknown>) {}

        @ExecuteWithPolicy()
        get(_url: string): unknown {
          return of(response)
        }
      }

      const client = new TestClient(stubPolicy)
      await client.get('/users')

      expect(stubPolicy.execute).toHaveBeenCalledTimes(1)
      expect(stubPolicy.execute).toHaveBeenCalledWith(expect.any(Function))
    })

    it('should call original method inside executor with original args and unwrap Observable via firstValueFrom', async () => {
      const stubPolicy = buildStubPolicy(new AbortController().signal)
      const methodSpy = jest.fn()
      const response = { data: 'unwrapped', status: 200 } as AxiosResponse

      class TestClient {
        constructor(public policy: IPolicy<IDefaultPolicyContext, unknown>) {}

        @ExecuteWithPolicy()
        get(url: string, config?: object): unknown {
          methodSpy(url, config)
          return of(response)
        }
      }

      const client = new TestClient(stubPolicy)
      const result = await client.get('/items', { headers: { 'x-trace': '42' } })

      expect(methodSpy).toHaveBeenCalledTimes(1)
      expect(methodSpy).toHaveBeenCalledWith('/items', { headers: { 'x-trace': '42' } })
      expect(result).toBe(response)
    })

    it('should read `policy` lazily from the instance at call time, not at decoration time', async () => {
      const initialPolicy = buildStubPolicy(new AbortController().signal)
      const swappedPolicy = buildStubPolicy(new AbortController().signal)

      class TestClient {
        public policy: IPolicy<IDefaultPolicyContext, unknown>

        constructor(initial: IPolicy<IDefaultPolicyContext, unknown>) {
          this.policy = initial
        }

        @ExecuteWithPolicy()
        get(_url: string): unknown {
          return of({ data: 'ok', status: 200 } as AxiosResponse)
        }
      }

      const client = new TestClient(initialPolicy)
      client.policy = swappedPolicy

      await client.get('/swap')

      expect(initialPolicy.execute).not.toHaveBeenCalled()
      expect(swappedPolicy.execute).toHaveBeenCalledTimes(1)
    })
  })

  describe('signal forwarding for `request` propertyKey', () => {
    it('should inject `policyCtx.signal` into args[0] for `request` method', async () => {
      const stubSignal = new AbortController().signal
      const stubPolicy = buildStubPolicy(stubSignal)
      const methodSpy = jest.fn()

      class TestClient {
        constructor(public policy: IPolicy<IDefaultPolicyContext, unknown>) {}

        @ExecuteWithPolicy()
        request(config: { url: string, signal?: AbortSignal }): unknown {
          methodSpy(config)
          return of({ data: config, status: 200 } as AxiosResponse)
        }
      }

      const client = new TestClient(stubPolicy)
      await client.request({ url: '/raw' })

      expect(methodSpy).toHaveBeenCalledTimes(1)
      const passedConfig = methodSpy.mock.calls[0]![0] as { url: string, signal?: AbortSignal }
      expect(passedConfig.url).toBe('/raw')
      expect(passedConfig.signal).toBe(stubSignal)
    })

    it('should default to an empty config when args[0] is undefined for `request`', async () => {
      const stubSignal = new AbortController().signal
      const stubPolicy = buildStubPolicy(stubSignal)
      const methodSpy = jest.fn()

      class TestClient {
        constructor(public policy: IPolicy<IDefaultPolicyContext, unknown>) {}

        @ExecuteWithPolicy()
        request(config?: { signal?: AbortSignal }) {
          methodSpy(config)
          return of({ data: 'ok', status: 200 } as AxiosResponse)
        }
      }

      const client = new TestClient(stubPolicy)
      await (client.request as unknown as (config?: { signal?: AbortSignal }) => Promise<AxiosResponse>)()

      expect(methodSpy).toHaveBeenCalledTimes(1)
      const passedConfig = methodSpy.mock.calls[0]![0] as { signal?: AbortSignal }
      expect(passedConfig.signal).toBe(stubSignal)
    })
  })

  describe('non-observable return values', () => {
    it('awaits a Promise return value when the wrapped method does not return an Observable', async () => {
      const stubPolicy = buildStubPolicy(new AbortController().signal)
      const response = { data: 'promise-return', status: 200 } as AxiosResponse

      class TestClient {
        constructor(public policy: IPolicy<IDefaultPolicyContext, unknown>) {}

        // Returning a Promise<AxiosResponse> directly exercises the `await result`
        // branch of the decorator (line 79), bypassing `firstValueFrom`.
        @ExecuteWithPolicy()
        get(_url: string): unknown {
          return Promise.resolve(response)
        }
      }

      const client = new TestClient(stubPolicy)
      const result = await client.get('/promise')

      expect(result).toBe(response)
    })

    it('awaits a synchronous (non-Promise, non-Observable) return value', async () => {
      const stubPolicy = buildStubPolicy(new AbortController().signal)
      const response = { data: 'sync-return', status: 200 } as AxiosResponse

      class TestClient {
        constructor(public policy: IPolicy<IDefaultPolicyContext, unknown>) {}

        @ExecuteWithPolicy()
        get(_url: string): unknown {
          return response
        }
      }

      const client = new TestClient(stubPolicy)
      const result = await client.get('/sync')

      expect(result).toBe(response)
    })
  })

  describe('signal NOT forwarded for non-`request` methods', () => {
    it('should NOT inject signal into args for `get`', async () => {
      const stubPolicy = buildStubPolicy(new AbortController().signal)
      const methodSpy = jest.fn()

      class TestClient {
        constructor(public policy: IPolicy<IDefaultPolicyContext, unknown>) {}

        @ExecuteWithPolicy()
        get(url: string, config?: object): unknown {
          methodSpy(url, config)
          return of({ data: 'ok', status: 200 } as AxiosResponse)
        }
      }

      const client = new TestClient(stubPolicy)
      await client.get('/safe', { headers: { 'x-trace': '7' } })

      expect(methodSpy).toHaveBeenCalledWith('/safe', { headers: { 'x-trace': '7' } })
      // The config passed to get must remain unmutated — no signal injection.
      const calledConfig = methodSpy.mock.calls[0]![1] as Record<string, unknown>
      expect(calledConfig).not.toHaveProperty('signal')
    })

    it('should NOT inject signal into args for `post`', async () => {
      const stubPolicy = buildStubPolicy(new AbortController().signal)
      const methodSpy = jest.fn()

      class TestClient {
        constructor(public policy: IPolicy<IDefaultPolicyContext, unknown>) {}

        @ExecuteWithPolicy()
        post(url: string, data?: unknown, config?: object): unknown {
          methodSpy(url, data, config)
          return of({ data: 'ok', status: 200 } as AxiosResponse)
        }
      }

      const client = new TestClient(stubPolicy)
      await client.post('/submit', { id: 1 }, { headers: { 'x-id': 'a' } })

      expect(methodSpy).toHaveBeenCalledWith(
        '/submit',
        { id: 1 },
        { headers: { 'x-id': 'a' } },
      )
      const calledData = methodSpy.mock.calls[0]![1] as Record<string, unknown>
      expect(calledData).not.toHaveProperty('signal')
    })
  })
})
