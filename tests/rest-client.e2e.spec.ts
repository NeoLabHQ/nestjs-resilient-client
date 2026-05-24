import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { HttpService } from '@nestjs/axios'
import { Test, type TestingModule } from '@nestjs/testing'
import axios, { isAxiosError } from 'axios'
import { ConstantBackoff, isTaskCancelledError } from 'cockatiel'

import {
  RestClient,
  RestModule,
  ResiliencePresets,
  type ResilanceConfig,
} from '../src/index'

/**
 * End-to-end coverage for {@link RestClient} against the shared httpbin
 * container started by `tests/e2e-setup.ts`. Exercises the resilience
 * pipeline (CONSERVATIVE preset) over real network calls so that the
 * `HookableHttpService.dispatch` override on `RestClient` and the cockatiel
 * policy wrap order are validated against actual `AxiosError` instances
 * rather than fabricated stubs.
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
    const conservative = ResiliencePresets.CONSERVATIVE
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

  /**
   * Timeout-precedence coverage. Each case targets a distinct rung of the
   * `resolveResilience` truth table in `src/client/rest.module.ts`:
   *
   * - AC-1 — `axios: { timeout: > 0 }` and no `resilience` field strips the
   *   CONSERVATIVE preset's per-attempt timeout so axios's deadline is the
   *   only one in effect; the failure surfaces as axios's own
   *   `ECONNABORTED` (not a cockatiel `TaskCancelledError`).
   * - AC-22 — `axios: { timeout: 0 }` is the documented "disabled"
   *   sentinel and MUST NOT trigger preset-stripping; the user-supplied
   *   `resilience.timeout` is therefore preserved and the failure surfaces
   *   as an axios `CanceledError` (`code: 'ERR_CANCELED'`, the
   *   resilience-layer error code triggered by cockatiel cancelling the
   *   request via `AbortSignal`) — NOT an axios `ECONNABORTED`.
   *
   * Both cases drive a deliberately slow in-memory HTTP server. Each test
   * configures an upstream delay strictly greater than the deadline under
   * test (AC-1: 6000ms upstream vs 5000ms deadline; AC-22: 3000ms upstream
   * vs 1500ms deadline) so the request can only fail by being cancelled,
   * never by responding.
   */
  describe('timeout precedence', () => {
    /**
     * Spins up a localhost HTTP server that delays `delayMs` before
     * responding. Each test starts and tears down its own server instance
     * to keep timeout-policy state and pending sockets isolated.
     */
    function startSlowUpstream(delayMs: number): Promise<{ baseURL: string, server: Server }> {
      return new Promise((resolve) => {
        const server = createServer((_, res) => {
          // Caller-supplied delay puts the upstream response well past
          // the deadline being tested, so the request can only fail by
          // being cancelled, never by responding.
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
          }, delayMs)
        })

        // Bind on an ephemeral port (`0`) on loopback to avoid clashing
        // with the testcontainers httpbin port and to skip any external
        // DNS / firewall path.
        server.listen(0, '127.0.0.1', () => {
          const { port } = server.address() as AddressInfo
          resolve({ baseURL: `http://127.0.0.1:${port}`, server })
        })
      })
    }

    /**
     * Closes a slow-upstream server and resolves once node's `close`
     * callback fires. Awaiting the close prevents a leaked listening
     * socket from spilling into the next test (Jest reuses the worker
     * process).
     */
    function stopSlowUpstream(server: Server): Promise<void> {
      return new Promise((resolve, reject) => {
        // `closeAllConnections` dropping in-flight requests is what lets
        // the close handler resolve without waiting on the per-test
        // delay timer; without it the server would block until the
        // queued `setTimeout` fires.
        server.closeAllConnections?.()
        server.close((err) => {
          if (err) {
            reject(err)
            return
          }
          resolve()
        })
      })
    }

    let slowServer: Server | undefined
    let slowBaseURL: string | undefined
    let moduleRef: TestingModule | undefined

    afterEach(async () => {
      // Tear the testing module down BEFORE the upstream server so any
      // axios sockets it owns close cleanly. Order matters: closing the
      // upstream first would leave the client's socket half-open until
      // node garbage-collects.
      if (moduleRef !== undefined) {
        await moduleRef.close()
        moduleRef = undefined
      }
      if (slowServer !== undefined) {
        await stopSlowUpstream(slowServer)
        slowServer = undefined
        slowBaseURL = undefined
      }
    })

    it('AC-1: axios.timeout strips the CONSERVATIVE preset timeout (axios ECONNABORTED at ~5000ms)', async () => {
      // Upstream sleeps 6000ms — strictly greater than the 5000ms axios
      // deadline so the request can only fail by being cancelled.
      const upstream = await startSlowUpstream(6_000)
      slowServer = upstream.server
      slowBaseURL = upstream.baseURL

      // Factory returns ONLY `axios.timeout` — no `resilience` field at
      // all. This is the AC-1 truth-table row: `resolveResilience`
      // returns `{ ...CONSERVATIVE, timeout: undefined }`, so the
      // cockatiel pipeline does NOT enforce a deadline and axios's own
      // `timeout: 5_000` is the sole cancellation source.
      moduleRef = await Test.createTestingModule({
        imports: [
          RestModule.registerAsync({
            useFactory: () => ({
              axios: {
                baseURL: slowBaseURL,
                timeout: 5_000,
              },
            }),
          }),
        ],
      }).compile()

      const client = moduleRef.get(RestClient)

      const startedAt = Date.now()
      let caught: unknown
      try {
        await client.get('/')
      }
      catch (error) {
        caught = error
      }
      const elapsedMs = Date.now() - startedAt

      // Must be an AxiosError carrying `code === 'ECONNABORTED'` —
      // axios's own timeout error. A cockatiel `TaskCancelledError` here
      // would mean the preset timeout was NOT stripped (regression).
      expect(caught).toBeDefined()
      expect(isAxiosError(caught)).toBe(true)
      if (!isAxiosError(caught)) {
        throw new Error('expected an AxiosError after axios.timeout fired')
      }
      expect(caught.code).toBe('ECONNABORTED')

      // Axios's timeout fires close to the 5000ms boundary. ±200ms
      // tolerance per the success criteria covers CI runner jitter
      // without making the assertion meaningless.
      expect(elapsedMs).toBeGreaterThanOrEqual(4_800)
      expect(elapsedMs).toBeLessThanOrEqual(5_200)
    })

    it('AC-22: axios.timeout=0 does NOT suppress resilience.timeout (resilience-layer cancellation at ~1500ms)', async () => {
      // Upstream sleeps 3000ms — strictly greater than the 1500ms
      // resilience deadline so the request can only fail by being
      // cancelled by the cockatiel TimeoutPolicy.
      const upstream = await startSlowUpstream(3_000)
      slowServer = upstream.server
      slowBaseURL = upstream.baseURL

      // Factory returns `axios: { timeout: 0 }` (axios's "disabled"
      // sentinel) AND an explicit `resilience.timeout`. This is the
      // AC-22 truth-table row: `resolveResilience` returns the user's
      // resilience verbatim, so the cockatiel `TimeoutPolicy` is the
      // only deadline in effect. Retry intentionally omitted so the
      // test asserts a SINGLE cancellation rather than chained retries.
      const resilience: ResilanceConfig<unknown> = {
        timeout: 1_500,
      }

      moduleRef = await Test.createTestingModule({
        imports: [
          RestModule.registerAsync({
            useFactory: () => ({
              axios: {
                baseURL: slowBaseURL,
                timeout: 0,
              },
              resilience,
            }),
          }),
        ],
      }).compile()

      const client = moduleRef.get(RestClient)

      const startedAt = Date.now()
      let caught: unknown
      try {
        await client.get('/')
      }
      catch (error) {
        caught = error
      }
      const elapsedMs = Date.now() - startedAt

      // The resilience-layer cancellation surfaces as an axios
      // `CanceledError` (`code: 'ERR_CANCELED'`) — NOT an axios
      // `ECONNABORTED` (axios's own timeout) — because cockatiel's
      // `TimeoutPolicy` cancels the underlying request via the
      // `AbortSignal` forwarded into axios's request config (see
      // `RestClient.dispatch` and `mergeSignal` in `rest.client.ts`).
      // Asserting on `ERR_CANCELED` therefore distinguishes the
      // resilience-layer cancellation from axios's own timeout path —
      // this is the "equivalent resilience-layer error code"
      // referenced in the success criteria. If `axios.timeout: 0` had
      // triggered the preset-stripping branch in `resolveResilience`,
      // no resilience timeout would fire and the request would hang
      // for the full 3000ms slow-upstream delay (causing the test to
      // fail on the elapsed-time bounds below).
      expect(caught).toBeDefined()
      expect(isAxiosError(caught)).toBe(true)
      if (!isAxiosError(caught)) {
        throw new Error('expected an AxiosError after the cockatiel timeout fired')
      }
      // AxiosError code MUST be `ERR_CANCELED` (cockatiel cancelled via
      // AbortSignal); a `code === 'ECONNABORTED'` here would mean axios's
      // own timeout fired (regression: axios.timeout=0 should disable that
      // path). Cockatiel's `isTaskCancelledError` returns `false` for this
      // axios-relayed cancellation, so we assert directly on the axios
      // error code instead.
      expect(caught.code).toBe('ERR_CANCELED')
      expect(isTaskCancelledError(caught)).toBe(false)

      // Cockatiel's cooperative timeout fires close to the 1500ms
      // boundary. ±200ms tolerance per the success criteria.
      expect(elapsedMs).toBeGreaterThanOrEqual(1_300)
      expect(elapsedMs).toBeLessThanOrEqual(1_700)
    })
  })
})
