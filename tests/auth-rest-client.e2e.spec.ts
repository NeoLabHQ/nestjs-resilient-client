import { Injectable } from '@nestjs/common'
import { Test, type TestingModule } from '@nestjs/testing'
import { isAxiosError, type AxiosRequestConfig } from 'axios'

import {
  AuthRestClient,
  AuthRestModule,
  RestClient,
  type AuthStrategy,
  type HooksConfig,
  type HttpVerb,
  type InvokeArgs,
} from '../src/index'

/**
 * End-to-end coverage for {@link AuthRestClient} against the shared
 * httpbin container started by `tests/e2e-setup.ts`. Exercises the
 * dispatch override stack (`AuthRestClient.dispatch` running on top of the
 * inner `RestClient`'s `dispatch` override) end to end:
 *
 * - Pre-flight `authenticateIfNeeded()` runs before every request via
 *   {@link AuthProcessor}, which delegates the handshake to a user-supplied
 *   class-based {@link AuthStrategy}.
 * - The strategy's `extendRequest()` injects an `Authorization: Bearer X`
 *   header that httpbin echoes back under `.headers.Authorization`.
 * - A real HTTP 401 response (from `/status/401`) drives the
 *   `AuthRestClient.dispatch` single-shot re-auth retry path:
 *   `processor.clearAuth()` (which delegates to `strategy.invalidate()`)
 *   followed by a second `authenticateIfNeeded()` call that triggers a
 *   fresh `strategy.authenticate(client)` invocation.
 *
 * Bootstrapping is driven by {@link AuthRestModule.forRootAsync} with the
 * post-Step-12 options shape (`{ axios?, resilience?, hooks? }`). The
 * `httpService` field has been removed — the module now owns its own
 * `HttpModule.registerAsync(opts.axios ?? {})` registration, mirroring
 * `RestModule.forRootAsync` ergonomics.
 *
 * Container coordinates flow in via `process.env.TEST_HTTP_BASE_URL` —
 * tests never hard-code hosts or ports.
 */

/** Token value injected by the stub strategy's `extendRequest`. */
const BEARER_TOKEN = 'Bearer test-token-X'

/** Token value injected by the AC-14 strategy fixture. Distinct from the
 * shared {@link BEARER_TOKEN} so a wiring mix-up between fixtures surfaces
 * as an explicit assertion mismatch rather than a silent collision. */
const AC14_TOKEN = 'Bearer ac14-token'

/**
 * Shared counter for {@link CountingAuthStrategy} instances managed by
 * NestJS DI. Module-scoped because each test compiles a new
 * `TestingModule` — and NestJS instantiates the strategy via `useClass`
 * self-binding inside that module — so the test cannot read instance
 * state off the strategy class itself without introducing per-test
 * coupling. A module-scoped counter (cleared in `beforeEach`) keeps
 * the assertion target visible to the test body without leaking state
 * across cases.
 */
let strategyAuthenticateCalls = 0

/**
 * Stub {@link AuthStrategy} that owns its own session state on the
 * instance — mirroring the real-world contract documented on
 * {@link AuthStrategy} where the strategy (not the processor) is the
 * single source of truth for the authenticated session.
 *
 * Decorated with `@Injectable()` because {@link AuthRestModule.forRootAsync}
 * registers strategy classes via `useClass` self-binding; NestJS requires
 * constructor parameter metadata even on a parameterless constructor for
 * the binding to resolve. `extendRequest()` returns a NEW config (never
 * mutates the input) with the Bearer token merged into the headers,
 * matching the immutability clause in the {@link AuthStrategy} JSDoc.
 */
@Injectable()
class CountingAuthStrategy implements AuthStrategy {
  /** Lifecycle flag: true after `authenticate()`, false after `invalidate()`. */
  private authenticated = false

  async authenticate(_client: RestClient): Promise<void> {
    strategyAuthenticateCalls += 1
    this.authenticated = true
  }

  async isAuthenticated(): Promise<boolean> {
    return this.authenticated
  }

  extendRequest(config: AxiosRequestConfig): AxiosRequestConfig {
    return {
      ...config,
      headers: {
        ...((config.headers as Record<string, unknown> | undefined) ?? {}),
        Authorization: BEARER_TOKEN,
      },
    }
  }

  async invalidate(): Promise<void> {
    this.authenticated = false
  }
}

/**
 * AC-14 strategy fixture. Stamps a sentinel `Authorization` header
 * ({@link AC14_TOKEN}) on every outgoing request so the test can assert
 * that the auth-strategy header was attached on top of the new
 * `axios` + `hooks` factory shape. Distinct class identity from
 * {@link CountingAuthStrategy} so the AC-14 test's intent is
 * self-evident from the registered class.
 */
@Injectable()
class StampingAuthStrategy implements AuthStrategy {
  async authenticate(_client: RestClient): Promise<void> {}

  async isAuthenticated(): Promise<boolean> {
    return true
  }

  extendRequest(config: AxiosRequestConfig): AxiosRequestConfig {
    return {
      ...config,
      headers: {
        ...((config.headers as Record<string, unknown> | undefined) ?? {}),
        Authorization: AC14_TOKEN,
      },
    }
  }

  async invalidate(): Promise<void> {}
}

/**
 * Resolves the shared httpbin container's base URL or throws a clear
 * diagnostic if the testcontainers harness in `tests/e2e-setup.ts`
 * misfired. Centralised so every bootstrap helper produces a uniform
 * error when the env var is absent.
 */
function requireBaseUrl(): string {
  const baseURL = process.env.TEST_HTTP_BASE_URL
  if (!baseURL) {
    throw new Error('TEST_HTTP_BASE_URL must be set by tests/e2e-setup.ts')
  }
  return baseURL
}

describe('AuthRestClient (e2e)', () => {
  /**
   * Each test compiles its own `TestingModule` — closing it in
   * `afterEach` releases the internally-registered `HttpModule`'s axios
   * sockets and any cockatiel circuit-breaker state owned by the
   * resolved `RestClient`. Without explicit teardown, leaked sockets
   * would accumulate across tests and the worker process could exit with
   * pending handles.
   */
  let moduleRef: TestingModule | undefined

  beforeEach(() => {
    strategyAuthenticateCalls = 0
  })

  afterEach(async () => {
    if (moduleRef !== undefined) {
      await moduleRef.close()
      moduleRef = undefined
    }
  })

  describe('successful authenticated GET', () => {
    it('attaches Authorization: Bearer X to the outbound request and httpbin echoes it back', async () => {
      // Bootstrap with the post-Step-12 options shape: `axios.baseURL` flows
      // into the module-internal `HttpModule.registerAsync(opts.axios ?? {})`
      // so the resolved `HttpService` carries the httpbin container URL —
      // no `httpService` field, no manual `HttpModule` wiring.
      moduleRef = await Test.createTestingModule({
        imports: [
          AuthRestModule.registerAsync({
            strategy: CountingAuthStrategy,
            useFactory: () => ({ axios: { baseURL: requireBaseUrl() } }),
          }),
        ],
      }).compile()

      const client = moduleRef.get(AuthRestClient)

      // httpbin's `/anything` echoes request headers under `.headers` —
      // a strong signal that the bearer token was actually transmitted
      // (not just present on the in-process config object).
      const response = await client.get<{ headers: Record<string, string> }>('/anything')

      expect(response.status).toBe(200)
      expect(response.data.headers).toHaveProperty('Authorization', BEARER_TOKEN)
      // First request triggers a single authenticate() handshake; no
      // re-auth path runs because the response is a 200.
      expect(strategyAuthenticateCalls).toBe(1)
    })
  })

  describe('HTTP 401 -> re-auth -> retry once', () => {
    it('clears auth and re-authenticates exactly once when the server returns 401', async () => {
      moduleRef = await Test.createTestingModule({
        imports: [
          AuthRestModule.registerAsync({
            strategy: CountingAuthStrategy,
            useFactory: () => ({ axios: { baseURL: requireBaseUrl() } }),
          }),
        ],
      }).compile()

      const client = moduleRef.get(AuthRestClient)

      // `/status/401` always returns 401, so the decorator's retry is
      // also a 401. The decorator surfaces that final AxiosError; the
      // observable invariant is the auth handshake count.
      let caught: unknown
      try {
        await client.get('/status/401')
      }
      catch (error) {
        caught = error
      }

      expect(caught).toBeDefined()
      expect(isAxiosError(caught)).toBe(true)
      // Narrow with isAxiosError so `caught.response` is well-typed.
      if (!isAxiosError(caught)) {
        throw new Error('expected an AxiosError after the 401 re-auth retry')
      }
      expect(caught.response?.status).toBe(401)

      // Initial pre-flight handshake (1) + post-401 forced re-auth (1) = 2.
      // Anything more would indicate the decorator's "retry exactly once"
      // contract is broken.
      expect(strategyAuthenticateCalls).toBe(2)
    })
  })

  describe('AC-14: AuthRestModuleOptions extends RestModuleOptions and accepts `axios` + `hooks`', () => {
    it('useFactory `() => ({ axios: { baseURL }, hooks: { onInvoke: spy } })` — request dispatched to baseURL; spy invoked; auth header attached', async () => {
      // Pins AC-14 end-to-end: post-Step-12, `AuthRestModuleOptions` no
      // longer carries a `httpService` field. The factory shape now
      // matches `RestModuleOptions` exactly (`{ axios?, resilience?,
      // hooks? }`) plus the synchronous `authStrategy` class token at
      // the top level. This single test asserts all three convergent
      // contracts:
      //   (a) `axios.baseURL` flows through to the internally-registered
      //       `HttpModule.registerAsync(opts.axios ?? {})` so the verb
      //       call carries the resolved URL — verified via httpbin's
      //       `/anything` endpoint echoing `.url` back to the caller;
      //   (b) `hooks.onInvoke` is forwarded into the constructed
      //       `AuthRestClient` so the HookableHttpService lifecycle
      //       observes every dispatched verb;
      //   (c) `extendRequest` (from the user-supplied AuthStrategy)
      //       still stamps the auth header on the outgoing request —
      //       proving the auth lifecycle composes cleanly with the new
      //       options shape.
      const baseURL = requireBaseUrl()
      const onInvoke: jest.Mock<
        ReturnType<NonNullable<HooksConfig['onInvoke']>>,
        Parameters<NonNullable<HooksConfig['onInvoke']>>
      > = jest.fn(
        // Passthrough — return undefined so the original args propagate
        // unchanged through `super.dispatch`. Capturing the call is
        // sufficient for the AC-14 contract.
        (_verb: HttpVerb, _args: InvokeArgs) => undefined,
      )

      moduleRef = await Test.createTestingModule({
        imports: [
          AuthRestModule.registerAsync({
            strategy: StampingAuthStrategy,
            useFactory: () => ({
              axios: { baseURL },
              hooks: { onInvoke },
            }),
          }),
        ],
      }).compile()

      const client = moduleRef.get(AuthRestClient)

      // httpbin's `/anything` reflects both the resolved request URL
      // (under `.url`) AND the request headers (under `.headers`) — a
      // single round-trip that exercises (a) and (c) at once.
      const response = await client.get<{
        url: string
        headers: Record<string, string>
      }>('/anything')

      // (a) Request dispatched to `axios.baseURL`. `/anything` echoes
      // the full request URL back, so a successful response with the
      // expected `url` field proves the baseURL was applied to the
      // relative `/anything` path on the way out.
      expect(response.status).toBe(200)
      expect(response.data.url).toContain(`${baseURL}/anything`)

      // (b) `hooks.onInvoke` was invoked with the verb + carrier.
      // Step 12 forwards `opts.hooks` into BOTH the inner RestClient
      // (via `RestModule.forHttpService`) AND the outer AuthRestClient
      // provider, so onInvoke fires on both layers per call. The AC-14
      // success criterion only requires "spy invoked"; we assert the
      // looser invariant via `toHaveBeenCalled()` and pin the call
      // signature so wiring regressions surface here. If Step 12's
      // wiring dropped `opts.hooks` from either provider factory, this
      // would never fire.
      expect(onInvoke).toHaveBeenCalled()
      expect(onInvoke).toHaveBeenCalledWith(
        'get',
        expect.objectContaining({ url: '/anything', config: expect.any(Object) }),
      )

      // (c) Auth-strategy `Authorization` header attached to outgoing
      // request. `StampingAuthStrategy.extendRequest` stamps
      // `Authorization: Bearer ac14-token` on the carrier config, which
      // BaseHttpService.callUnderlying forwards to axios; httpbin
      // echoes the request headers back under `.headers`.
      expect(response.data.headers).toHaveProperty('Authorization', AC14_TOKEN)
    })
  })
})
