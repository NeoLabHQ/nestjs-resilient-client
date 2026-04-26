import type { AxiosRequestConfig } from 'axios'
import { Authenticate } from '../authenticate.decorator'

/**
 * Builds an axios-like error object that satisfies `isAxiosError(err)`.
 *
 * `axios.isAxiosError` checks the truthy `isAxiosError` flag on the error
 * value, so any plain `Error` augmented with that flag and a `response`
 * member behaves identically to a real `AxiosError` for the decorator's
 * branching logic. Constructing the error manually avoids spinning up a
 * real axios request just to obtain a 401 / 500.
 */
function makeAxiosError(status: number): Error {
  const error = new Error(`Request failed with status code ${status}`) as Error & {
    isAxiosError: boolean
    response: { status: number }
  }
  error.isAxiosError = true
  error.response = { status }
  return error
}

interface AuthStrategyStub {
  authenticateIfNeeded: jest.Mock<Promise<void>, []>
  extendRequest: jest.Mock<AxiosRequestConfig, [AxiosRequestConfig | undefined]>
  clearAuth: jest.Mock<void, []>
}

/** Builds a fresh strategy stub with default merge-Authorization-header behaviour. */
function createAuthStrategyStub(): AuthStrategyStub {
  return {
    authenticateIfNeeded: jest.fn().mockResolvedValue(undefined),
    extendRequest: jest.fn(
      (config: AxiosRequestConfig | undefined): AxiosRequestConfig => ({
        ...(config ?? {}),
        headers: {
          ...((config?.headers as Record<string, unknown> | undefined) ?? {}),
          Authorization: 'Bearer X',
        },
      }),
    ),
    clearAuth: jest.fn(),
  }
}

describe('Authenticate decorator', () => {
  describe('(a) pre-flight authenticateIfNeeded', () => {
    it('calls authStrategy.authenticateIfNeeded() before the wrapped method on every request', async () => {
      const stub = createAuthStrategyStub()
      const callOrder: string[] = []
      stub.authenticateIfNeeded.mockImplementation(async () => {
        callOrder.push('authenticateIfNeeded')
      })

      class Client {
        readonly authStrategy: AuthStrategyStub = stub

        @Authenticate()
        async get(_url: string, _config?: AxiosRequestConfig): Promise<string> {
          callOrder.push('get')
          return 'ok'
        }
      }

      const client = new Client()
      await client.get('/users')

      expect(stub.authenticateIfNeeded).toHaveBeenCalledTimes(1)
      expect(callOrder).toEqual(['authenticateIfNeeded', 'get'])
    })
  })

  describe('(b) config arg index per HTTP method', () => {
    it('extends config at index 1 for get/delete/head/options/request', async () => {
      const stub = createAuthStrategyStub()
      const seenArgs: Record<string, unknown[]> = {}

      class Client {
        readonly authStrategy: AuthStrategyStub = stub

        @Authenticate()
        async get(url: string, config?: AxiosRequestConfig): Promise<void> {
          seenArgs.get = [url, config]
        }

        @Authenticate()
        async delete(url: string, config?: AxiosRequestConfig): Promise<void> {
          seenArgs.delete = [url, config]
        }

        @Authenticate()
        async head(url: string, config?: AxiosRequestConfig): Promise<void> {
          seenArgs.head = [url, config]
        }

        @Authenticate()
        async options(url: string, config?: AxiosRequestConfig): Promise<void> {
          seenArgs.options = [url, config]
        }

        @Authenticate()
        async request(_first: unknown, config?: AxiosRequestConfig): Promise<void> {
          // The decorator's contract puts the config at args[1] for `request`,
          // matching the rest of the index-1 verb family. The test mirrors that
          // shape so an unintended index-0 implementation would surface as a
          // missing Authorization header on the second argument.
          seenArgs.request = [_first, config]
        }
      }

      const client = new Client()
      await client.get('/g')
      await client.delete('/d')
      await client.head('/h')
      await client.options('/o')
      await client.request('placeholder', { url: '/r' })

      // Every index-1 verb (including `request`) must observe the same merged
      // Authorization header at args[1]; failures point to a wrong index lookup.
      const verbs = ['get', 'delete', 'head', 'options'] as const
      for (const verb of verbs) {
        const [, config] = seenArgs[verb] as [string, AxiosRequestConfig]
        expect(config).toEqual({ headers: { Authorization: 'Bearer X' } })
      }

      const [, requestConfig] = seenArgs.request as [unknown, AxiosRequestConfig]
      expect(requestConfig).toEqual({ url: '/r', headers: { Authorization: 'Bearer X' } })
    })

    it('extends config at index 2 for post/put/patch/postForm/putForm/patchForm', async () => {
      const stub = createAuthStrategyStub()
      const seenArgs: Record<string, unknown[]> = {}

      class Client {
        readonly authStrategy: AuthStrategyStub = stub

        @Authenticate()
        async post(url: string, data: unknown, config?: AxiosRequestConfig): Promise<void> {
          seenArgs.post = [url, data, config]
        }

        @Authenticate()
        async put(url: string, data: unknown, config?: AxiosRequestConfig): Promise<void> {
          seenArgs.put = [url, data, config]
        }

        @Authenticate()
        async patch(url: string, data: unknown, config?: AxiosRequestConfig): Promise<void> {
          seenArgs.patch = [url, data, config]
        }

        @Authenticate()
        async postForm(url: string, data: unknown, config?: AxiosRequestConfig): Promise<void> {
          seenArgs.postForm = [url, data, config]
        }

        @Authenticate()
        async putForm(url: string, data: unknown, config?: AxiosRequestConfig): Promise<void> {
          seenArgs.putForm = [url, data, config]
        }

        @Authenticate()
        async patchForm(url: string, data: unknown, config?: AxiosRequestConfig): Promise<void> {
          seenArgs.patchForm = [url, data, config]
        }
      }

      const client = new Client()
      const payload = { x: 1 }
      await client.post('/p', payload)
      await client.put('/p', payload)
      await client.patch('/p', payload)
      await client.postForm('/p', payload)
      await client.putForm('/p', payload)
      await client.patchForm('/p', payload)

      const verbs = ['post', 'put', 'patch', 'postForm', 'putForm', 'patchForm'] as const
      for (const verb of verbs) {
        const [url, data, config] = seenArgs[verb] as [string, unknown, AxiosRequestConfig]
        expect(url).toBe('/p')
        expect(data).toBe(payload)
        expect(config).toEqual({ headers: { Authorization: 'Bearer X' } })
      }
    })
  })

  describe('(c) header merging', () => {
    it('preserves original headers and merges new Authorization header', async () => {
      const stub = createAuthStrategyStub()
      let observedConfig: AxiosRequestConfig | undefined

      class Client {
        readonly authStrategy: AuthStrategyStub = stub

        @Authenticate()
        async get(_url: string, config?: AxiosRequestConfig): Promise<void> {
          observedConfig = config
        }
      }

      const client = new Client()
      await client.get('/u', { headers: { y: 'z' } })

      expect(observedConfig).toEqual({
        headers: {
          y: 'z',
          Authorization: 'Bearer X',
        },
      })
      expect(stub.extendRequest).toHaveBeenCalledTimes(1)
      expect(stub.extendRequest).toHaveBeenCalledWith({ headers: { y: 'z' } })
    })

    it('passes empty object to extendRequest when config arg is omitted', async () => {
      const stub = createAuthStrategyStub()

      class Client {
        readonly authStrategy: AuthStrategyStub = stub

        @Authenticate()
        async get(_url: string, _config?: AxiosRequestConfig): Promise<void> {
          // no-op
        }
      }

      const client = new Client()
      await client.get('/u')

      expect(stub.extendRequest).toHaveBeenCalledWith({})
    })
  })

  describe('(d) 401 triggers re-auth and retry exactly once', () => {
    it('on 401 calls clearAuth, re-authenticates, re-extends config, and retries the underlying method once', async () => {
      const stub = createAuthStrategyStub()
      const methodSpy = jest.fn()
      const callOrder: string[] = []

      stub.authenticateIfNeeded.mockImplementation(async () => {
        callOrder.push('authenticateIfNeeded')
      })
      stub.clearAuth.mockImplementation(() => {
        callOrder.push('clearAuth')
      })

      class Client {
        readonly authStrategy: AuthStrategyStub = stub

        @Authenticate()
        async get(_url: string, _config?: AxiosRequestConfig): Promise<string> {
          callOrder.push('get')
          methodSpy()
          if (methodSpy.mock.calls.length === 1) {
            throw makeAxiosError(401)
          }
          return 'ok'
        }
      }

      const client = new Client()
      const result = await client.get('/u')

      expect(result).toBe('ok')
      expect(methodSpy).toHaveBeenCalledTimes(2)
      expect(stub.authenticateIfNeeded).toHaveBeenCalledTimes(2)
      expect(stub.clearAuth).toHaveBeenCalledTimes(1)
      expect(stub.extendRequest).toHaveBeenCalledTimes(2)
      expect(callOrder).toEqual([
        'authenticateIfNeeded',
        'get',
        'clearAuth',
        'authenticateIfNeeded',
        'get',
      ])
    })
  })

  describe('(e) repeated 401 rethrows after one retry', () => {
    it('rethrows the second 401 without performing a third attempt', async () => {
      const stub = createAuthStrategyStub()
      const methodSpy = jest.fn()

      class Client {
        readonly authStrategy: AuthStrategyStub = stub

        @Authenticate()
        async get(_url: string, _config?: AxiosRequestConfig): Promise<string> {
          methodSpy()
          throw makeAxiosError(401)
        }
      }

      const client = new Client()

      await expect(client.get('/u')).rejects.toMatchObject({
        isAxiosError: true,
        response: { status: 401 },
      })

      expect(methodSpy).toHaveBeenCalledTimes(2)
      expect(stub.authenticateIfNeeded).toHaveBeenCalledTimes(2)
      expect(stub.clearAuth).toHaveBeenCalledTimes(1)
    })
  })

  describe('(f) non-401 axios error rethrows without re-auth', () => {
    it('rethrows a 500 axios error without calling clearAuth or re-authenticating', async () => {
      const stub = createAuthStrategyStub()
      const methodSpy = jest.fn()

      class Client {
        readonly authStrategy: AuthStrategyStub = stub

        @Authenticate()
        async get(_url: string, _config?: AxiosRequestConfig): Promise<string> {
          methodSpy()
          throw makeAxiosError(500)
        }
      }

      const client = new Client()

      await expect(client.get('/u')).rejects.toMatchObject({
        isAxiosError: true,
        response: { status: 500 },
      })

      expect(methodSpy).toHaveBeenCalledTimes(1)
      expect(stub.authenticateIfNeeded).toHaveBeenCalledTimes(1)
      expect(stub.clearAuth).not.toHaveBeenCalled()
    })
  })

  describe('(b2) config-arg index for post/put/patch (index 2)', () => {
    it('extends config at index 2 for post (data, config) signature', async () => {
      const stub = createAuthStrategyStub()

      class Client {
        readonly authStrategy: AuthStrategyStub = stub

        @Authenticate()
        async post(_url: string, _data?: unknown, config?: AxiosRequestConfig): Promise<AxiosRequestConfig> {
          return config ?? {}
        }
      }

      const client = new Client()
      const result = await client.post('/u', { key: 'value' }, { headers: { x: '1' } })

      expect(result).toHaveProperty('headers.Authorization', 'Bearer X')
      expect(result).toHaveProperty('headers.x', '1')
    })
  })

  describe('(b3) unsupported verb throws', () => {
    it('throws an error when applied to an unrecognised HTTP verb', async () => {
      const stub = createAuthStrategyStub()

      class Client {
        readonly authStrategy: AuthStrategyStub = stub

        @Authenticate()
        async customVerb(_url: string, _config?: AxiosRequestConfig): Promise<string> {
          return 'ok'
        }
      }

      const client = new Client()

      await expect(client.customVerb('/u')).rejects.toThrow('@Authenticate: unsupported method')
    })
  })

  describe('(g) non-axios error rethrows without re-auth', () => {
    it('rethrows a plain network Error without calling clearAuth or re-authenticating', async () => {
      const stub = createAuthStrategyStub()
      const methodSpy = jest.fn()

      class Client {
        readonly authStrategy: AuthStrategyStub = stub

        @Authenticate()
        async get(_url: string, _config?: AxiosRequestConfig): Promise<string> {
          methodSpy()
          throw new Error('socket hang up')
        }
      }

      const client = new Client()

      await expect(client.get('/u')).rejects.toThrow('socket hang up')

      expect(methodSpy).toHaveBeenCalledTimes(1)
      expect(stub.authenticateIfNeeded).toHaveBeenCalledTimes(1)
      expect(stub.clearAuth).not.toHaveBeenCalled()
    })
  })
})
