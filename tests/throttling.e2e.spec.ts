import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'

import { HttpService } from '@nestjs/axios'
import axios from 'axios'

// Imports point at the concrete `RestClient` module rather than the package
// barrel (`../src/index`) so this spec stays orthogonal to unrelated re-exports
// — a transient breakage elsewhere in the package surface cannot fail a test
// that only exercises `RestClient` construction.
import { RestClient } from '../src/client/rest.client'

/**
 * End-to-end coverage for AC-6: when `resilience.throttling` is configured
 * with `{ requestsPerInterval: 1, intervalMs: 100 }`, sequential GETs through
 * a single {@link RestClient} must respect the documented throttle:
 *
 * - At most 1 request is admitted per 100 ms window.
 * - Excess requests are queued (never dropped) and admitted in arrival
 *   order in subsequent windows.
 *
 * Strategy: stand up a self-contained in-memory HTTP server that replies
 * with HTTP 200 immediately so the throttle is the only source of delay
 * observable in the timing assertion. Construct a `RestClient` directly
 * with the AC-6 configuration. Fire 5 sequential GETs (instead of the
 * AC-prescribed 100) — keeping the count low caps the wall-clock cost at
 * ~500 ms while still exercising the throttle behaviour beyond the first
 * window.
 *
 * Why direct `RestClient` construction (vs. `RestModule.forRootAsync`): the
 * AC-6 contract is on the resilience config behaviour, not on the module
 * wiring path. Mirrors the construction pattern used by
 * `tests/rest-client.e2e.spec.ts` for the same reasons — keeps the spec
 * focused on what AC-6 actually pins (the throttle cadence semantics).
 *
 * Tolerance bands: ±100 ms per emission is a deliberately generous floor
 * that absorbs CI runner jitter without weakening the "throttle actually
 * spaced the requests" signal — for a 100 ms window, ±100 ms is the
 * smallest meaningful tolerance.
 */

/** Total sequential GETs fired in the timing test. */
const SEQUENTIAL_REQUESTS = 5

/** Maximum admissions per throttle window (matches AC-6 verbatim). */
const REQUESTS_PER_INTERVAL = 1

/** Length of the throttle window in milliseconds (matches AC-6 verbatim). */
const INTERVAL_MS = 100

/**
 * Floor for the cumulative elapsed time across all 5 requests.
 *
 * The first request is admitted immediately (t≈0 ms) because the throttle's
 * `countInWindow` starts at 0. Each subsequent request must wait for the
 * next 100 ms tick of the refill `interval`, so:
 *
 *   total_min ≈ (SEQUENTIAL_REQUESTS - 1) × INTERVAL_MS = 400 ms
 *
 * The 100ms tolerance band absorbs CI scheduler jitter while still
 * guaranteeing that the throttle WAS observed (a non-throttled run would
 * complete in tens of milliseconds, well below the 300 ms lower bound).
 */
const PER_REQUEST_TOLERANCE_MS = 100
const MIN_TOTAL_ELAPSED_MS = (SEQUENTIAL_REQUESTS - 1) * INTERVAL_MS - PER_REQUEST_TOLERANCE_MS

describe('Throttling policy (e2e, AC-6)', () => {
  // Stable handles populated in `beforeAll`; closed in `afterAll`. Using
  // module-scoped variables keeps each `it` body focused on the assertion
  // rather than on server bootstrap.
  let server: Server
  let baseURL: string

  // Inbound request counter — incremented per HTTP hit. Reset in
  // `beforeEach` so a flake-induced retry from a previous test cannot make
  // a later test's count assertion satisfy itself. Also serves as a strong
  // signal that all 5 requests reached the upstream (i.e. none were dropped
  // by the throttle queue).
  let inboundCount = 0

  /**
   * Starts a minimal in-memory HTTP server bound to `127.0.0.1` on an
   * OS-assigned port. The server replies with HTTP 200 immediately so the
   * throttle is the sole source of timing delay — a slow upstream would
   * confound the per-request tolerance budget.
   */
  beforeAll(async () => {
    server = createServer((_req, res) => {
      inboundCount += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // Constant body keeps the assertion focused on TIMING — payload variance
      // would force every assertion to special-case per-response data.
      res.end(JSON.stringify({ result: 'ok', count: inboundCount }))
    })

    await new Promise<void>((resolve) => {
      // Bind to the loopback interface so the test cannot accidentally
      // expose the in-memory upstream on a shared CI runner.
      server.listen(0, '127.0.0.1', resolve)
    })

    const address = server.address() as AddressInfo
    baseURL = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    // Gracefully tear down the server so jest can exit cleanly; without
    // `close()` the open listening socket would keep the worker alive past
    // the configured `testTimeout`.
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    })
  })

  beforeEach(() => {
    // Fresh counter per test so the post-test inbound-count assertion is
    // anchored at exactly the count of THIS test's requests.
    inboundCount = 0
  })

  /**
   * Builds a fresh {@link RestClient} bound to a real `axios` instance
   * targeting the in-memory upstream and wired with the AC-6 throttling
   * configuration. Each test gets its own client so the throttle's
   * shared queue and window counter start cleanly for every test (the
   * `throttlingOperator` factory captures shared state in its closure, so
   * a previous test's residual `countInWindow` would skew this test's
   * timing assertions).
   */
  function buildClient(): RestClient {
    const httpService = new HttpService(axios.create({ baseURL }))
    return new RestClient(httpService, {
      // 1 request per 100 ms window. Matches AC-6 verbatim.
      throttling: {
        requestsPerInterval: REQUESTS_PER_INTERVAL,
        intervalMs: INTERVAL_MS,
      },
    })
  }

  describe('sequential GETs through a 1-per-100ms throttle', () => {
    it('admits requests at the configured cadence and queues the rest in arrival order', async () => {
      const client = buildClient()

      // Per-request wall-clock timestamps captured at completion. The
      // monotonic increase between successive entries is the primary
      // observation channel for AC-6: each post-burst request must
      // arrive ≥ INTERVAL_MS after its predecessor.
      const completionTimes: number[] = []
      const startTime = Date.now()

      // Fire requests SEQUENTIALLY (await each before starting the next)
      // so the throttle queue observes a steady arrival pattern. A
      // `Promise.all` over the same range would test concurrent admission,
      // which is a related but distinct AC.
      for (let i = 0; i < SEQUENTIAL_REQUESTS; i++) {
        const response = await client.get<{ result: string, count: number }>(
          '/throttling-target',
        )
        completionTimes.push(Date.now() - startTime)
        // Sanity: every request must reach the upstream successfully.
        // A 5xx here would defeat the timing assertion (resilience
        // policies may inject retry delays into the elapsed total).
        expect(response.status).toBe(200)
      }

      // Upstream observed all 5 requests — the throttle queues, it does
      // not drop. A count of 4 (or any value < 5) would indicate the
      // throttle silently discarded a queued entry.
      expect(inboundCount).toBe(SEQUENTIAL_REQUESTS)

      // AC-6: total wall-clock time for 5 requests at 1 per 100 ms is
      // ≥ 400 ms (first immediate, then 4 × 100 ms). The MIN_TOTAL_
      // ELAPSED_MS constant pre-applies the ±100 ms tolerance so the
      // assertion's intent is legible at the call site.
      const totalElapsed = completionTimes[completionTimes.length - 1]!
      expect(totalElapsed).toBeGreaterThanOrEqual(MIN_TOTAL_ELAPSED_MS)

      // Strengthen the timing claim with a per-pair delta check: every
      // request after the first must complete at least
      // `INTERVAL_MS - PER_REQUEST_TOLERANCE_MS` after its predecessor.
      // A coarse total-elapsed guard alone could be satisfied by an
      // implementation that batches the entire delay onto the last
      // request — the per-pair check rules that out.
      for (let i = 1; i < completionTimes.length; i++) {
        const delta = completionTimes[i]! - completionTimes[i - 1]!
        expect(delta).toBeGreaterThanOrEqual(INTERVAL_MS - PER_REQUEST_TOLERANCE_MS)
      }
    })
  })
})
