import { HttpService } from '@nestjs/axios'
import axios, { isAxiosError, type AxiosRequestConfig } from 'axios'

import {
  AuthRestClient,
  AuthStrategyService,
  RestClient,
  type AuthConfig,
  type AuthStrategy,
} from '../src/index'

/**
 * End-to-end coverage for {@link AuthRestClient} against the shared
 * httpbin container started by `tests/e2e-setup.ts`. Exercises the
 * hook stack (`AuthRestClient.onInvoke` running on top of the inner
 * `RestClient`'s `dispatch` override) end to end:
 * - Pre-flight `authenticateIfNeeded()` runs before every request.
 * - The strategy's `extendRequest()` injects an `Authorization: Bearer X`
 *   header that httpbin echoes back under `.headers.Authorization`.
 * - A real HTTP 401 response (from `/status/401`) drives the
 *   `AuthRestClient.dispatch` single-shot re-auth retry path:
 *   `clearAuth()` followed by a second `authenticateIfNeeded()` call.
 *
 * Container coordinates flow in via `process.env.TEST_HTTP_BASE_URL` —
 * tests never hard-code hosts or ports.
 */

/** Token value injected by the stub strategy's `extendRequest`. */
const BEARER_TOKEN = 'Bearer test-token-X'

/**
 * Builds a fresh {@link AuthStrategy} stub that:
 * - Reports authenticated by default (so `authenticateIfNeeded()` is a
 *   no-op once the strategy is cached).
 * - Returns a NEW config (never mutates the input) with an
 *   `Authorization` header merged in.
 */
function createBearerStrategy(): AuthStrategy {
  return {
    isAuthenticated: () => true,
    extendRequest: (config: AxiosRequestConfig): AxiosRequestConfig => ({
      ...config,
      headers: {
        ...((config.headers as Record<string, unknown> | undefined) ?? {}),
        Authorization: BEARER_TOKEN,
      },
    }),
  }
}

/**
 * Stub {@link AuthConfig} whose `authenticate` returns a fresh Bearer
 * strategy each time it is called. Implemented as a class (rather than
 * a bare object literal) so tests can read `callCount` to verify the
 * decorator's single-shot re-auth on 401.
 */
class CountingAuthConfig implements AuthConfig {
  callCount = 0

  async authenticate(): Promise<AuthStrategy> {
    this.callCount += 1
    return createBearerStrategy()
  }
}

/**
 * Wires up a real {@link AuthRestClient} backed by a real {@link RestClient}
 * (CONSERVATIVE preset) pointing at the httpbin container, plus a fresh
 * {@link AuthStrategyService} bound to a counting stub config.
 */
function buildSut(): {
  client: AuthRestClient
  authConfig: CountingAuthConfig
} {
  const baseURL = process.env.TEST_HTTP_BASE_URL
  if (!baseURL) {
    throw new Error('TEST_HTTP_BASE_URL must be set by tests/e2e-setup.ts')
  }

  const httpService = new HttpService(axios.create({ baseURL }))
  const restClient = new RestClient(httpService)
  const authConfig = new CountingAuthConfig()
  const authStrategy = new AuthStrategyService(authConfig, restClient)
  const client = new AuthRestClient(restClient, authStrategy)
  return { client, authConfig }
}

describe('AuthRestClient (e2e)', () => {
  describe('successful authenticated GET', () => {
    it('attaches Authorization: Bearer X to the outbound request and httpbin echoes it back', async () => {
      const { client, authConfig } = buildSut()

      // httpbin's `/anything` echoes request headers under `.headers` —
      // a strong signal that the bearer token was actually transmitted
      // (not just present on the in-process config object).
      const response = await client.get<{ headers: Record<string, string> }>('/anything')

      expect(response.status).toBe(200)
      expect(response.data.headers).toHaveProperty('Authorization', BEARER_TOKEN)
      // First request triggers a single authenticate() handshake; no
      // re-auth path runs because the response is a 200.
      expect(authConfig.callCount).toBe(1)
    })
  })

  describe('HTTP 401 -> re-auth -> retry once', () => {
    it('clears auth and re-authenticates exactly once when the server returns 401', async () => {
      const { client, authConfig } = buildSut()

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
      expect(authConfig.callCount).toBe(2)
    })
  })
})
