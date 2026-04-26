import { HttpService } from '@nestjs/axios'
import axios, { isAxiosError } from 'axios'
import { ConstantBackoff } from 'cockatiel'

import {
  RestClient,
  ResilencePresets,
  resiliencePolicyPresets,
  type ResilanceConfig,
} from '../src/index'

/**
 * End-to-end coverage for {@link RestClient} against the shared httpbin
 * container started by `tests/e2e-setup.ts`. Exercises the resilience
 * pipeline (CONSERVATIVE preset) over real network calls so that the
 * decorator stack (`@ExecuteWithPolicy`) and the cockatiel policy wrap
 * order are validated against actual `AxiosError` instances rather than
 * fabricated stubs.
 *
 * Container coordinates flow in via `process.env.TEST_HTTP_BASE_URL` —
 * tests never hard-code hosts or ports.
 */
describe('RestClient (e2e)', () => {
  /**
   * Resolves the shared container's base URL or throws a clear error if
   * the harness misfired. Centralised so every helper produces a
   * uniform diagnostic when `tests/e2e-setup.ts` did not run.
   */
  function requireBaseUrl(): string {
    const baseURL = process.env.TEST_HTTP_BASE_URL
    if (!baseURL) {
      throw new Error('TEST_HTTP_BASE_URL must be set by tests/e2e-setup.ts')
    }
    return baseURL
  }

  /**
   * Builds a fresh {@link RestClient} bound to a real `axios` instance
   * targeting the httpbin container. Each test gets its own client so
   * circuit-breaker state from prior tests cannot leak across cases.
   *
   * The default constructor uses the CONSERVATIVE preset (3-attempt
   * retry for safe methods on 5xx + circuit breaker), which is exactly
   * what the success criteria for this spec require.
   */
  function buildClient(): RestClient {
    const httpService = new HttpService(axios.create({ baseURL: requireBaseUrl() }))
    return new RestClient(httpService)
  }

  /**
   * Builds a {@link RestClient} with the CONSERVATIVE preset's retry
   * shape (`maxAttempts: 3`, safe-methods-only `shouldRetry`) but with
   * `ConstantBackoff(0)` substituted for `ExponentialBackoff` so the
   * retry-exhaustion test completes in well under the 60s e2e timeout
   * regardless of CI runner speed. Determinism > backoff fidelity here
   * because the assertion is on retry COUNT, not on inter-attempt timing.
   */
  function buildClientWithFastBackoff(): RestClient {
    const conservative = resiliencePolicyPresets[ResilencePresets.CONSERVATIVE]
    // The preset's `retry` field is non-optional in CONSERVATIVE, but the
    // type system models it as optional. Guard explicitly so a future
    // preset edit cannot silently drop retries from this test.
    if (!conservative.retry) {
      throw new Error('CONSERVATIVE preset must define a retry config')
    }

    const fastConfig: ResilanceConfig<unknown> = {
      ...conservative,
      retry: {
        ...conservative.retry,
        backoff: new ConstantBackoff(0),
      },
    }

    const httpService = new HttpService(axios.create({ baseURL: requireBaseUrl() }))
    return new RestClient(httpService, fastConfig)
  }

  describe('GET /get', () => {
    it('returns HTTP 200 with a body that echoes the request URL', async () => {
      const client = buildClient()

      const response = await client.get<{ url: string }>('/get')

      expect(response.status).toBe(200)
      // httpbin's `/get` echoes the full request URL — strong assertion
      // that the request actually reached the container (not a stub).
      expect(response.data).toHaveProperty('url')
      expect(response.data.url).toContain('/get')
    })
  })

  describe('GET /status/500', () => {
    it('exhausts the CONSERVATIVE retry budget (3 attempts) and surfaces the final 500 AxiosError', async () => {
      // Fast-backoff client keeps the test bounded: 1 initial + 3 retries
      // back-to-back with zero delay, well under `testTimeout: 60000`.
      const client = buildClientWithFastBackoff()

      // Count actual request attempts via an axios interceptor on the
      // underlying instance — proves cockatiel really retried, not just
      // that the final error happened to carry status 500.
      let attemptCount = 0
      const interceptorId = client.axiosRef.interceptors.request.use((cfg) => {
        attemptCount += 1
        return cfg
      })

      try {
        let caught: unknown
        try {
          await client.get('/status/500')
        }
        catch (error) {
          caught = error
        }

        // The retry policy exhausts and rethrows the last AxiosError.
        expect(caught).toBeDefined()
        expect(isAxiosError(caught)).toBe(true)
        // Narrow with isAxiosError so `caught.response` is well-typed.
        if (!isAxiosError(caught)) {
          throw new Error('expected an AxiosError after retry exhaustion')
        }
        expect(caught.response?.status).toBe(500)

        // CONSERVATIVE preset: maxAttempts: 3 -> 1 initial call + 3 retries = 4.
        expect(attemptCount).toBe(4)
      }
      finally {
        client.axiosRef.interceptors.request.eject(interceptorId)
      }
    })
  })

  describe('POST /anything', () => {
    it('echoes the request body and headers in the response payload', async () => {
      const client = buildClient()
      const payload = { hello: 'world', n: 42 }

      const response = await client.post<{
        json: typeof payload
        method: string
        headers: Record<string, string>
      }>('/anything', payload)

      expect(response.status).toBe(200)
      // httpbin's `/anything` reflects the parsed JSON body under `.json`
      // and the HTTP method under `.method` — both are strong signals
      // that the request was transmitted and parsed correctly.
      expect(response.data.method).toBe('POST')
      expect(response.data.json).toEqual(payload)
      // Echoed headers prove the outbound HTTP request actually reached
      // the container with axios's default `Content-Type` for JSON.
      expect(response.data.headers).toBeDefined()
      expect(response.data.headers['Content-Type']).toMatch(/application\/json/)
    })
  })
})
