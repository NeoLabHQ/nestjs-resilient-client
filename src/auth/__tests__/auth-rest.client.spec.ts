import type { AxiosRequestConfig, AxiosResponse } from 'axios'

import type { HooksConfig } from '../../client/hookable-http.service'
import type { RestClient } from '../../client/rest.client'
import type { AuthProcessor } from '../auth-processor'
import { AuthRestClient } from '../auth-rest.client'

/**
 * Verb method names exposed by both {@link RestClient} and {@link AuthRestClient}.
 * Used to drive table-style tests so that a missing auth lifecycle on any
 * individual verb surfaces as a per-verb assertion failure rather than a
 * silent gap in coverage.
 */
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

/** Verbs whose config argument lives at args[1] — `(url, config?)` shape. */
const INDEX_1_VERBS: ReadonlySet<Verb> = new Set([
  'get',
  'delete',
  'head',
])

/**
 * Builds an axios-like error object that satisfies `isAxiosError(err)`.
 *
 * `axios.isAxiosError` checks the truthy `isAxiosError` flag on the error
 * value, so any plain `Error` augmented with that flag and a `response`
 * member behaves identically to a real `AxiosError` for the dispatcher's
 * 401 / non-401 branching logic.
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

/** Per-verb jest.fn map covering every method on {@link RestClient}. */
type RestClientStub = {
  [K in Verb]: jest.Mock<Promise<AxiosResponse>, unknown[]>
}

/** Builds a fresh {@link RestClient} stub where every verb resolves to the same response. */
function createRestClientStub(response: AxiosResponse = { data: 'ok' } as AxiosResponse): RestClientStub {
  const stub = {} as RestClientStub
  for (const verb of ALL_VERBS) {
    stub[verb] = jest.fn().mockResolvedValue(response)
  }
  return stub
}

/** Lightweight typed stub for the auth strategy surface read by AuthRestClient. */
interface AuthStrategyStub {
  authenticateIfNeeded: jest.Mock<Promise<void>, []>
  extendRequest: jest.Mock<AxiosRequestConfig, [AxiosRequestConfig]>
  clearAuth: jest.Mock<Promise<void>, []>
}

/**
 * Builds a fresh strategy stub whose {@link AuthStrategyStub.extendRequest}
 * merges an `Authorization: Bearer X` header into any incoming config.
 */
function createAuthStrategyStub(): AuthStrategyStub {
  return {
    authenticateIfNeeded: jest.fn().mockResolvedValue(undefined),
    extendRequest: jest.fn(
      (config: AxiosRequestConfig): AxiosRequestConfig => ({
        ...config,
        headers: {
          ...((config.headers as Record<string, unknown> | undefined) ?? {}),
          Authorization: 'Bearer X',
        },
      }),
    ),
    clearAuth: jest.fn().mockResolvedValue(undefined),
  }
}

/**
 * Constructs an {@link AuthRestClient} bound to fresh stubs and returns the
 * client together with handles to those stubs for assertions.
 */
function buildSut(): {
  client: AuthRestClient
  restClient: RestClientStub
  authStrategy: AuthStrategyStub
} {
  const restClient = createRestClientStub()
  const authStrategy = createAuthStrategyStub()
  const client = new AuthRestClient(
    restClient as unknown as RestClient,
    authStrategy as unknown as AuthProcessor,
  )
  return { client, restClient, authStrategy }
}

describe('AuthRestClient', () => {
  describe('constructor and field visibility', () => {
    it('exposes processor as a public-readable field', () => {
      const { client, authStrategy } = buildSut()

      // Module wiring and adapters read `client.processor` directly, so
      // the field MUST be public-readable on the instance.
      expect(client.processor).toBe(authStrategy)
    })
  })

  describe('verb forwarding', () => {
    it.each(ALL_VERBS)('forwards %s to the underlying RestClient exactly once', async (verb) => {
      const { client, restClient } = buildSut()

      // Each verb is invoked with the canonical positional shape that
      // {@link BaseHttpService} maps to `InvokeArgs`. Verbs at index 1 use
      // `(url, config)`; verbs at index 2 use `(url, data, config)`;
      // `request` uses `(config)` directly.
      if (verb === 'request') {
        await (client[verb] as (config: AxiosRequestConfig) => Promise<AxiosResponse>)({ url: '/r' })
      }
      else if (INDEX_1_VERBS.has(verb)) {
        await (client[verb] as (url: string, config?: AxiosRequestConfig) => Promise<AxiosResponse>)('/x')
      }
      else {
        await (
          client[verb] as (url: string, data: unknown, config?: AxiosRequestConfig) => Promise<AxiosResponse>
        )('/x', { payload: 1 })
      }

      expect(restClient[verb]).toHaveBeenCalledTimes(1)
      // No other verb method on the underlying RestClient should have fired.
      for (const other of ALL_VERBS) {
        if (other === verb) continue
        expect(restClient[other]).not.toHaveBeenCalled()
      }
    })

    it.each(ALL_VERBS)('pre-flight authenticate runs before forwarding %s', async (verb) => {
      const { client, restClient, authStrategy } = buildSut()

      const callOrder: string[] = []
      authStrategy.authenticateIfNeeded.mockImplementation(async () => {
        callOrder.push('authenticateIfNeeded')
      })
      restClient[verb].mockImplementation(async () => {
        callOrder.push('forward')
        return { data: 'ok' } as AxiosResponse
      })

      if (verb === 'request') {
        await (client[verb] as (config: AxiosRequestConfig) => Promise<AxiosResponse>)({ url: '/r' })
      }
      else if (INDEX_1_VERBS.has(verb)) {
        await (client[verb] as (url: string, config?: AxiosRequestConfig) => Promise<AxiosResponse>)('/x')
      }
      else {
        await (
          client[verb] as (url: string, data: unknown, config?: AxiosRequestConfig) => Promise<AxiosResponse>
        )('/x', { payload: 1 })
      }

      // The hook is verified by observing the pre-flight authenticateIfNeeded
      // call firing strictly before the underlying RestClient call.
      expect(authStrategy.authenticateIfNeeded).toHaveBeenCalledTimes(1)
      expect(callOrder).toEqual(['authenticateIfNeeded', 'forward'])
    })
  })

  describe('header merge after extendRequest', () => {
    it('merges Authorization: Bearer X with original headers on get(/x, { headers: { y: \'z\' } })', async () => {
      const { client, restClient, authStrategy } = buildSut()

      await client.get('/x', { headers: { y: 'z' } })

      // The dispatch override passes the original config through extendRequest…
      expect(authStrategy.extendRequest).toHaveBeenCalledTimes(1)
      expect(authStrategy.extendRequest).toHaveBeenCalledWith({ headers: { y: 'z' } })

      // …and the underlying RestClient receives the merged result, with both
      // the original `y: 'z'` header and the strategy's Authorization header.
      expect(restClient.get).toHaveBeenCalledTimes(1)
      expect(restClient.get).toHaveBeenCalledWith('/x', {
        headers: { y: 'z', Authorization: 'Bearer X' },
      })
    })
  })

  describe('401 first, success second', () => {
    it('triggers exactly two underlying RestClient calls and invokes authenticateIfNeeded twice', async () => {
      const { client, restClient, authStrategy } = buildSut()

      // First call rejects with a 401; second call resolves successfully.
      // The AuthRestClient.dispatch contract is: catch 401, clearAuth,
      // re-authenticate, and retry the underlying method exactly once.
      restClient.get
        .mockRejectedValueOnce(makeAxiosError(401))
        .mockResolvedValueOnce({ data: 'ok' } as AxiosResponse)

      const response = await client.get('/x')

      expect(response.data).toBe('ok')
      expect(restClient.get).toHaveBeenCalledTimes(2)
      expect(authStrategy.authenticateIfNeeded).toHaveBeenCalledTimes(2)
      expect(authStrategy.clearAuth).toHaveBeenCalledTimes(1)
    })

    it('awaits clearAuth before invoking authenticateIfNeeded on the 401 recovery path', async () => {
      // Pins the awaited-ordering invariant on the 401 recovery branch:
      // `AuthRestClient.dispatch` MUST `await processor.clearAuth()` BEFORE
      // calling `authenticateIfNeeded` for the re-handshake. A regression that
      // drops the `await` would still type-check (both return Promise<void>)
      // and could pass call-count assertions because nothing else pins the
      // resolution timing — so this test gates the ordering with a deferred
      // Promise that only resolves when the test explicitly releases it.
      const { client, restClient, authStrategy } = buildSut()

      restClient.get
        .mockRejectedValueOnce(makeAxiosError(401))
        .mockResolvedValueOnce({ data: 'ok' } as AxiosResponse)

      // Manually-resolved deferred so `clearAuth` stays pending until the
      // test releases it. The pre-flight authenticateIfNeeded fires once
      // BEFORE the 401, so we snapshot that baseline call count and assert
      // the recovery handshake has not yet been triggered.
      let resolveClearAuth!: () => void
      const clearAuthDeferred = new Promise<void>((resolve) => {
        resolveClearAuth = resolve
      })
      authStrategy.clearAuth.mockImplementationOnce(() => clearAuthDeferred)

      const dispatchPromise = client.get('/x')

      // Drain the microtask + macrotask queues so the dispatcher reaches
      // `clearAuth` and suspends on the deferred. A `setImmediate` boundary
      // is required because the pre-flight `authenticateIfNeeded` await, the
      // first `restClient.get` rejection, and the error-branch `await` form
      // a chain of microtasks that all need to flush before `clearAuth` is
      // actually invoked.
      await new Promise<void>(resolve => setImmediate(resolve))

      // Pre-flight handshake ran once; recovery handshake MUST NOT have
      // fired while `clearAuth` is still pending. A dropped `await` on
      // `clearAuth` would have allowed authenticateIfNeeded to run already.
      expect(authStrategy.clearAuth).toHaveBeenCalledTimes(1)
      expect(authStrategy.authenticateIfNeeded).toHaveBeenCalledTimes(1)

      // Release the deferred — the dispatcher should now proceed to the
      // recovery handshake and the second underlying RestClient call.
      resolveClearAuth()

      const response = await dispatchPromise

      expect(response.data).toBe('ok')
      // Recovery handshake fired exactly once AFTER clearAuth resolved,
      // bringing the total authenticateIfNeeded invocations to two.
      expect(authStrategy.authenticateIfNeeded).toHaveBeenCalledTimes(2)
      expect(authStrategy.clearAuth).toHaveBeenCalledTimes(1)
      expect(restClient.get).toHaveBeenCalledTimes(2)
    })
  })

  describe('500 error path', () => {
    it('rethrows the 500 and invokes authenticateIfNeeded exactly once (pre-flight only)', async () => {
      const { client, restClient, authStrategy } = buildSut()

      // 500 is non-401, so the dispatcher must NOT retry and must NOT clearAuth.
      restClient.get.mockRejectedValueOnce(makeAxiosError(500))

      await expect(client.get('/x')).rejects.toMatchObject({
        isAxiosError: true,
        response: { status: 500 },
      })

      expect(restClient.get).toHaveBeenCalledTimes(1)
      expect(authStrategy.authenticateIfNeeded).toHaveBeenCalledTimes(1)
      expect(authStrategy.clearAuth).not.toHaveBeenCalled()
    })
  })

  describe('per-verb argument forwarding with explicit config', () => {
    // Each verb is exercised with both shapes of its public surface — with
    // and without the optional `config` argument — so the optional-arg
    // branches in the verb wrappers' transpiled output are exercised.

    it.each(['get', 'delete', 'head'] as const)(
      '%s forwards (url, config) to the underlying RestClient with merged Authorization header',
      async (verb) => {
        const { client, restClient, authStrategy } = buildSut()

        const config: AxiosRequestConfig = { headers: { 'x-trace': 't' } }
        await client[verb]('/path', config)

        expect(restClient[verb]).toHaveBeenCalledTimes(1)
        expect(restClient[verb]).toHaveBeenCalledWith('/path', {
          headers: { 'x-trace': 't', Authorization: 'Bearer X' },
        })
        // The strategy must observe the original (un-augmented) config so that
        // re-authentication after a 401 starts from the caller-supplied state.
        expect(authStrategy.extendRequest).toHaveBeenCalledWith({ headers: { 'x-trace': 't' } })
      },
    )

    it.each(['post', 'put', 'patch', 'postForm', 'putForm', 'patchForm'] as const)(
      '%s forwards (url, data, config) to the underlying RestClient with merged Authorization header',
      async (verb) => {
        const { client, restClient, authStrategy } = buildSut()

        const data = { id: 42 }
        const config: AxiosRequestConfig = { headers: { 'x-trace': 't' } }
        await client[verb]('/path', data, config)

        expect(restClient[verb]).toHaveBeenCalledTimes(1)
        expect(restClient[verb]).toHaveBeenCalledWith('/path', data, {
          headers: { 'x-trace': 't', Authorization: 'Bearer X' },
        })
        expect(authStrategy.extendRequest).toHaveBeenCalledWith({ headers: { 'x-trace': 't' } })
      },
    )

    it.each(['post', 'put', 'patch', 'postForm', 'putForm', 'patchForm'] as const)(
      '%s defaults the omitted config to {} and still merges Authorization',
      async (verb) => {
        const { client, restClient, authStrategy } = buildSut()

        // Omitting the `config` arg forces the dispatcher's `args.config ?? {}`
        // fallback to fire — covers the optional-config branch on data verbs.
        await (
          client[verb] as (url: string, data: unknown) => Promise<AxiosResponse>
        )('/path', { id: 1 })

        expect(authStrategy.extendRequest).toHaveBeenCalledWith({})
        expect(restClient[verb]).toHaveBeenCalledWith('/path', { id: 1 }, {
          headers: { Authorization: 'Bearer X' },
        })
      },
    )

    it.each(['get', 'delete', 'head'] as const)(
      '%s defaults the omitted config to {} and still merges Authorization',
      async (verb) => {
        const { client, restClient, authStrategy } = buildSut()

        // Omit `config` for the (url, config?) verbs — exercises the optional
        // arg branch on the index-1 verb shape.
        await client[verb]('/path')

        expect(authStrategy.extendRequest).toHaveBeenCalledWith({})
        expect(restClient[verb]).toHaveBeenCalledWith('/path', {
          headers: { Authorization: 'Bearer X' },
        })
      },
    )

    it('request forwards the merged (config) to the underlying RestClient', async () => {
      const { client, restClient, authStrategy } = buildSut()

      await client.request({ url: '/raw', method: 'GET' })

      expect(restClient.request).toHaveBeenCalledTimes(1)
      // `request` carries its config in the first positional slot, so the
      // dispatcher forwards the merged config straight back to args[0]. The
      // underlying RestClient therefore receives the caller's config plus the
      // strategy's Authorization header.
      expect(restClient.request).toHaveBeenCalledWith({
        url: '/raw',
        method: 'GET',
        headers: { Authorization: 'Bearer X' },
      })
      // The strategy must observe the original (un-augmented) config so that
      // re-authentication after a 401 starts from the caller-supplied state.
      expect(authStrategy.extendRequest).toHaveBeenCalledWith({ url: '/raw', method: 'GET' })
      // Pre-flight authenticate ran exactly once.
      expect(authStrategy.authenticateIfNeeded).toHaveBeenCalledTimes(1)
    })
  })

  describe('per-verb 401 retry semantics', () => {
    // Mutation testing flips the 401 status check across every verb. Running
    // the 401 retry path through every verb makes those mutants observable.
    type IndexOneVerb = 'get' | 'delete' | 'head'
    type IndexTwoVerb = 'post' | 'put' | 'patch' | 'postForm' | 'putForm' | 'patchForm'
    const INDEX_ONE_VERBS: IndexOneVerb[] = ['get', 'delete', 'head']
    const INDEX_TWO_VERBS: IndexTwoVerb[] = ['post', 'put', 'patch', 'postForm', 'putForm', 'patchForm']

    it.each(INDEX_ONE_VERBS)(
      '%s recovers from a single 401 by retrying once and clearing auth',
      async (verb) => {
        const { client, restClient, authStrategy } = buildSut()
        restClient[verb]
          .mockRejectedValueOnce(makeAxiosError(401))
          .mockResolvedValueOnce({ data: 'recovered' } as AxiosResponse)

        const response = await client[verb]('/x')
        expect(response.data).toBe('recovered')
        expect(restClient[verb]).toHaveBeenCalledTimes(2)
        expect(authStrategy.clearAuth).toHaveBeenCalledTimes(1)
      },
    )

    it.each(INDEX_TWO_VERBS)(
      '%s recovers from a single 401 by retrying once and clearing auth',
      async (verb) => {
        const { client, restClient, authStrategy } = buildSut()
        restClient[verb]
          .mockRejectedValueOnce(makeAxiosError(401))
          .mockResolvedValueOnce({ data: 'recovered' } as AxiosResponse)

        const response = await client[verb]('/x', { id: 1 })
        expect(response.data).toBe('recovered')
        expect(restClient[verb]).toHaveBeenCalledTimes(2)
        expect(authStrategy.clearAuth).toHaveBeenCalledTimes(1)
      },
    )

    it('request recovers from a single 401 by retrying once', async () => {
      const { client, restClient, authStrategy } = buildSut()
      restClient.request
        .mockRejectedValueOnce(makeAxiosError(401))
        .mockResolvedValueOnce({ data: 'recovered' } as AxiosResponse)

      const response = await client.request({ url: '/raw' })
      expect(response.data).toBe('recovered')
      expect(restClient.request).toHaveBeenCalledTimes(2)
      expect(authStrategy.clearAuth).toHaveBeenCalledTimes(1)
    })
  })

  describe('hooks forwarding (AC-12)', () => {
    it('invokes onError with (verb, args, error) when the underlying RestClient rejects with 500', async () => {
      // AC-12: AuthRestClient must forward the optional `hooks` constructor arg
      // to its `HookableHttpService` parent so onError observes failures from
      // the inner auth-aware dispatch (which itself wraps the RestClient
      // transport). A 500 is non-401, so the auth lifecycle does NOT retry —
      // the error propagates straight to the hook layer above the dispatch.
      const restClient = createRestClientStub()
      const authStrategy = createAuthStrategyStub()
      const upstreamError = makeAxiosError(500)
      restClient.get.mockRejectedValueOnce(upstreamError)

      const onError = jest.fn(
        (_verb: string, _args: unknown, _error: unknown): undefined => undefined,
      )
      const hooks: HooksConfig = { onError }
      const client = new AuthRestClient(
        restClient as unknown as RestClient,
        authStrategy as unknown as AuthProcessor,
        hooks,
      )

      // Returning `undefined` from onError is the passthrough sentinel — the
      // original error must rethrow so the caller observes the upstream failure.
      await expect(client.get('/x')).rejects.toBe(upstreamError)

      // The hook MUST be invoked at least once; the canonical signature is
      // `(verb, args, error)` so the spy's first call carries those exact slots.
      expect(onError).toHaveBeenCalled()
      const [verb, args, error] = onError.mock.calls[0]
      expect(verb).toBe('get')
      // `args` is the InvokeArgs carrier the inner dispatch saw — for `get`,
      // this is `{ url: '/x', config: <auth-extended config> }`.
      expect(args).toMatchObject({ url: '/x' })
      expect(error).toBe(upstreamError)
    })
  })
})
