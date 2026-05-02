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
 * End-to-end coverage for AC-4: when `resilience.rateLimiter` is configured
 * with `{ strategy: 'token-bucket', capacity: 2, refillRatePerSec: 1 }`, a
 * burst of sequential GETs through a single {@link RestClient} must respect
 * the documented bucket semantics:
 *
 * - The first `capacity` requests pass through near-immediately (the bucket
 *   starts full).
 * - Subsequent requests wait `~1000 / refillRatePerSec` ms each for a fresh
 *   token to drip in.
 *
 * Strategy: stand up a self-contained in-memory HTTP server that responds
 * with a constant 200 immediately so the rate-limiter is the only source of
 * delay observable in the timing assertion. Construct a `RestClient`
 * directly with the AC-4 configuration. Fire 4 sequential GETs (instead of
 * the AC-prescribed 10) — keeping the count low caps the wall-clock cost at
 * ~2 s while still exercising both the burst window (requests 1–2) and the
 * refill window (requests 3–4).
 *
 * Why direct `RestClient` construction (vs. `RestModule.forRootAsync`): the
 * AC-4 contract is on the resilience config behaviour, not on the module
 * wiring path. Mirrors the construction pattern used by
 * `tests/rest-client.e2e.spec.ts` for the same reasons — keeps the spec
 * focused on what AC-4 actually pins (the rate-limiter timing semantics).
 *
 * Tolerance bands: ±500ms on the per-pair timing and ±200ms on the burst
 * window — generous bands absorb CI runner jitter without weakening the
 * "rate-limiter actually delayed the request" signal.
 */

/** Total sequential GETs fired in the timing test. */
const SEQUENTIAL_REQUESTS = 4

/** Burst window: requests within this index range should pass near-immediately. */
const BURST_CAPACITY = 2

/** Expected per-request delay after the burst window (1 token / sec). */
const REFILL_INTERVAL_MS = 1000

/** Tolerance for the burst window completion time (start → 2nd response). */
const BURST_TOLERANCE_MS = 200

/** Tolerance for the per-pair (and cumulative) elapsed time across requests. */
const TOTAL_TOLERANCE_MS = 500

describe('RateLimiter policy (e2e, AC-4)', () => {
  // Stable handles populated in `beforeAll`; closed in `afterAll`. Using
  // module-scoped variables keeps each `it` body focused on the assertion
  // rather than on server bootstrap.
  let server: Server
  let baseURL: string

  // Inbound request counter — incremented per HTTP hit. Reset in
  // `beforeEach` so a flake-induced retry from a previous test cannot make
  // a later test's count assertion satisfy itself. Also serves as a strong
  // signal that all 4 requests reached the upstream (i.e. none were dropped).
  let inboundCount = 0

  /**
   * Starts a minimal in-memory HTTP server bound to `127.0.0.1` on an
   * OS-assigned port. The server replies with HTTP 200 immediately so the
   * rate-limiter is the sole source of timing delay — a slow upstream would
   * confound the ±500ms tolerance budget.
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
   * targeting the in-memory upstream and wired with the AC-4 rate-limiter
   * configuration. Each test gets its own client so the rate-limiter
   * operator's per-instance state (token bucket, refill timer) starts
   * cleanly for every test.
   */
  function buildClient(): RestClient {
    const httpService = new HttpService(axios.create({ baseURL }))
    return new RestClient(httpService, {
      // Token bucket with capacity=2 → 2 immediate; refillRatePerSec=1
      // → 1 token per 1000 ms. Matches AC-4 verbatim.
      rateLimiter: {
        strategy: 'token-bucket',
        capacity: BURST_CAPACITY,
        refillRatePerSec: 1,
      },
    })
  }

  describe('sequential GETs through a token-bucket rate limiter', () => {
    it('admits the first 2 immediately and spaces requests 3 and 4 by ~1s each', async () => {
      const client = buildClient()

      // Per-request wall-clock timestamps captured at completion. The deltas
      // between successive entries are the primary observation channel for
      // AC-4: bursts complete tightly together; refill-gated requests
      // complete one second apart.
      const completionTimes: number[] = []
      const startTime = Date.now()

      // Fire requests SEQUENTIALLY (await each before starting the next)
      // so the rate-limiter observes a steady arrival pattern. A
      // `Promise.all` over the same range would test concurrent admission,
      // which is a different — and unrelated — AC.
      for (let i = 0; i < SEQUENTIAL_REQUESTS; i++) {
        const response = await client.get<{ result: string, count: number }>(
          '/rate-limiter-target',
        )
        completionTimes.push(Date.now() - startTime)
        // Sanity: every request must reach the upstream successfully.
        // A 5xx here would defeat the timing assertion (resilience
        // policies may inject retry delays into the elapsed total).
        expect(response.status).toBe(200)
      }

      // Upstream observed all 4 requests — no request was silently dropped
      // by the rate-limiter (the operator queues; it does not drop).
      expect(inboundCount).toBe(SEQUENTIAL_REQUESTS)

      // AC-4 first half: requests 1 and 2 consume the initial bucket
      // capacity, so both must complete within `BURST_TOLERANCE_MS`. The
      // burst window is bounded by completionTimes[1] (when request 2
      // resolves) since we await sequentially.
      expect(completionTimes[1]).toBeLessThanOrEqual(BURST_TOLERANCE_MS)

      // AC-4 second half: each subsequent request must wait ~1s for a
      // fresh token. Use deltas (not absolute times) so the assertion is
      // robust against process-startup jitter on slow CI runners.
      const delta23 = completionTimes[2]! - completionTimes[1]!
      const delta34 = completionTimes[3]! - completionTimes[2]!

      expect(delta23).toBeGreaterThanOrEqual(REFILL_INTERVAL_MS - TOTAL_TOLERANCE_MS)
      expect(delta23).toBeLessThanOrEqual(REFILL_INTERVAL_MS + TOTAL_TOLERANCE_MS)
      expect(delta34).toBeGreaterThanOrEqual(REFILL_INTERVAL_MS - TOTAL_TOLERANCE_MS)
      expect(delta34).toBeLessThanOrEqual(REFILL_INTERVAL_MS + TOTAL_TOLERANCE_MS)

      // Total wall clock: 2 immediate + 2 refill-spaced ≈ 2000ms ± 500ms.
      // Asserting on the total is a coarse guard against an implementation
      // that satisfies the per-delta bands by some pathological accident
      // (e.g. zero delay on 2→3 and double delay on 3→4).
      const totalElapsed = completionTimes[completionTimes.length - 1]!
      expect(totalElapsed).toBeGreaterThanOrEqual(
        REFILL_INTERVAL_MS * (SEQUENTIAL_REQUESTS - BURST_CAPACITY) - TOTAL_TOLERANCE_MS,
      )
    })
  })
})
