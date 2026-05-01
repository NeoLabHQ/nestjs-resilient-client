import { HttpService } from '@nestjs/axios'
import axios, { isAxiosError, type AxiosRequestConfig } from 'axios'

import {
  AuthProcessor,
  AuthRestClient,
  RestClient,
  type AuthStrategy,
} from '../src/index'

/**
 * End-to-end coverage for {@link AuthRestClient} against the shared
 * httpbin container started by `tests/e2e-setup.ts`. Exercises the
 * dispatch override stack (`AuthRestClient.dispatch` running on top of the inner
 * `RestClient`'s `dispatch` override) end to end:
 * - Pre-flight `authenticateIfNeeded()` runs before every request via
 *   {@link AuthProcessor}, which in turn delegates the handshake to a
 *   user-supplied class-based {@link AuthStrategy}.
 * - The strategy's `extendRequest()` injects an `Authorization: Bearer X`
 *   header that httpbin echoes back under `.headers.Authorization`.
 * - A real HTTP 401 response (from `/status/401`) drives the
 *   `AuthRestClient.dispatch` single-shot re-auth retry path:
 *   `processor.clearAuth()` (which delegates to `strategy.invalidate()`)
 *   followed by a second `authenticateIfNeeded()` call that triggers a
 *   fresh `strategy.authenticate(client)` invocation.
 *
 * Container coordinates flow in via `process.env.TEST_HTTP_BASE_URL` —
 * tests never hard-code hosts or ports.
 */

/** Token value injected by the stub strategy's `extendRequest`. */
const BEARER_TOKEN = 'Bearer test-token-X'

/**
 * Stub {@link AuthStrategy} that owns its own session state on the
 * instance — mirroring the real-world contract documented on
 * {@link AuthStrategy} where the strategy (not the processor) is the
 * single source of truth for the authenticated session.
 *
 * - `callCount` records every successful `authenticate()` invocation so
 *   tests can assert the decorator's "single pre-flight handshake" and
 *   "exactly one re-auth on 401" contracts.
 * - `authenticated` is the lifecycle flag flipped by `authenticate()` →
 *   true and `invalidate()` → false.
 * - `extendRequest()` returns a NEW config (never mutates the input) with
 *   the Bearer token merged into the headers, matching the immutability
 *   clause in the {@link AuthStrategy} JSDoc.
 */
class CountingAuthStrategy implements AuthStrategy {
  /** Number of successful `authenticate()` invocations. */
  callCount = 0

  /** Lifecycle flag: true after `authenticate()`, false after `invalidate()`. */
  private authenticated = false

  async authenticate(_client: RestClient): Promise<void> {
    this.callCount += 1
    this.authenticated = true
  }

  isAuthenticated(): boolean {
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

  invalidate(): void {
    this.authenticated = false
  }
}

/**
 * Wires up a real {@link AuthRestClient} backed by a real {@link RestClient}
 * (CONSERVATIVE preset) pointing at the httpbin container, plus a fresh
 * {@link AuthProcessor} bound to a counting class-based strategy.
 */
function buildSut(): {
  client: AuthRestClient
  strategy: CountingAuthStrategy
} {
  const baseURL = process.env.TEST_HTTP_BASE_URL
  if (!baseURL) {
    throw new Error('TEST_HTTP_BASE_URL must be set by tests/e2e-setup.ts')
  }

  const httpService = new HttpService(axios.create({ baseURL }))
  const restClient = new RestClient(httpService)
  const strategy = new CountingAuthStrategy()
  const processor = new AuthProcessor(strategy, restClient)
  const client = new AuthRestClient(restClient, processor)
  return { client, strategy }
}

describe('AuthRestClient (e2e)', () => {
  describe('successful authenticated GET', () => {
    it('attaches Authorization: Bearer X to the outbound request and httpbin echoes it back', async () => {
      const { client, strategy } = buildSut()

      // httpbin's `/anything` echoes request headers under `.headers` —
      // a strong signal that the bearer token was actually transmitted
      // (not just present on the in-process config object).
      const response = await client.get<{ headers: Record<string, string> }>('/anything')

      expect(response.status).toBe(200)
      expect(response.data.headers).toHaveProperty('Authorization', BEARER_TOKEN)
      // First request triggers a single authenticate() handshake; no
      // re-auth path runs because the response is a 200.
      expect(strategy.callCount).toBe(1)
    })
  })

  describe('HTTP 401 -> re-auth -> retry once', () => {
    it('clears auth and re-authenticates exactly once when the server returns 401', async () => {
      const { client, strategy } = buildSut()

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
      expect(strategy.callCount).toBe(2)
    })
  })
})
