import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

import { Test, type TestingModule } from '@nestjs/testing'

// Import directly from concrete modules rather than the `../src/index` barrel
// so this spec stays orthogonal to in-progress refactors elsewhere in the
// package (mirrors the rationale in `tests/static-token.e2e.spec.ts`).
import { RestClient } from '../src/client/rest.client'
import { RestModule } from '../src/client/rest.module'

/**
 * End-to-end coverage for the README's zero-config Quick Start (AC-15) and
 * the regression guard that the default `RestModule` does NOT auto-enable
 * any of the new resilience policies introduced by this feature (AC-18).
 *
 * Bootstraps NestJS with the literal Quick Start snippet — `imports:
 * [RestModule]` (no factory) — so the test fails the moment the populated
 * class-level `@Module` decorator on `RestModule` regresses to the previous
 * factory-only shape.
 *
 * Uses an in-memory `node:http` stub server (NOT the shared httpbin
 * testcontainer) for two reasons:
 *
 * 1. The CONSERVATIVE-preset retry assertion needs a deterministic
 *    "fail N then succeed" sequence keyed on a per-test request counter;
 *    httpbin's `/status/<code>` endpoint cannot model that without
 *    cross-test state bleed.
 * 2. The AC-18 regression guard needs to count exact inbound request
 *    arrivals and time them to sub-second precision; container traversal
 *    plus the testcontainers proxy add jitter that would force
 *    flakiness-tolerant thresholds and weaken the assertion.
 *
 * The stub binds to port `0` so the OS assigns an ephemeral port — no
 * coordination with `tests/e2e-setup.ts` is required, and parallel test
 * workers cannot collide on a hard-coded port.
 */

/**
 * In-memory stub upstream used by both AC-15 and AC-18 tests. The
 * `requestHandler` slot is rebound per test so each scenario can install
 * its own response policy (sequential 500-then-200 vs. always-200) without
 * tearing down and rebuilding the underlying server.
 */
interface StubServer {
  /** Absolute URL (`http://127.0.0.1:<ephemeral>`) the test should pass to `client.get(...)`. */
  baseUrl: string
  /** Number of inbound HTTP requests observed since the last `resetCounter()`. */
  getCount: () => number
  /** Resets the inbound-request counter; called from `beforeEach`. */
  resetCounter: () => void
  /** Replaces the response policy for the next test. */
  setHandler: (handler: (count: number, res: ServerResponse) => void) => void
  /** Stops the underlying server; called from `afterAll`. */
  close: () => Promise<void>
}

/**
 * Boots a `node:http` server on an OS-assigned port and returns a {@link StubServer}
 * façade. The handler is wrapped in a closure that increments the request
 * counter BEFORE delegating, so even handlers that throw are still counted —
 * the counter reflects "what the upstream actually saw on the wire", which
 * is the exact assertion AC-15 and AC-18 make.
 */
async function startStubServer(): Promise<StubServer> {
  let counter = 0
  let handler: (count: number, res: ServerResponse) => void = (_count, res) => {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
  }

  const server: Server = createServer(
    (_req: IncomingMessage, res: ServerResponse) => {
      counter += 1
      handler(counter, res)
    },
  )

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address() as AddressInfo | null
  if (address === null || typeof address === 'string') {
    throw new Error('expected stub server to bind to an AddressInfo tuple')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    getCount: () => counter,
    resetCounter: () => {
      counter = 0
    },
    setHandler: (next) => {
      handler = next
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err)
            return
          }
          resolve()
        })
      }),
  }
}

describe('Zero-config RestModule (e2e)', () => {
  let stub: StubServer

  beforeAll(async () => {
    stub = await startStubServer()
  })

  afterAll(async () => {
    await stub.close()
  })

  beforeEach(() => {
    // Each test starts from a clean inbound-request count so the assertions
    // (`expect(stub.getCount()).toBe(N)`) are scoped to a single scenario.
    stub.resetCounter()
  })

  /**
   * Builds a fresh NestJS testing module wired EXACTLY as the README's
   * zero-config Quick Start: `imports: [RestModule]` (no `forRootAsync`
   * factory). This relies on the populated class-level `@Module` decorator
   * on `RestModule` providing both `HttpService` and `RestClient` with
   * CONSERVATIVE-preset defaults — the central invariant AC-15 protects.
   */
  async function buildZeroConfigModule(): Promise<TestingModule> {
    return Test.createTestingModule({
      imports: [RestModule],
    }).compile()
  }

  describe('AC-15: CONSERVATIVE preset retries on 5xx by default', () => {
    it('retries a GET 3 times against an upstream that fails 3 times then succeeds', async () => {
      // Stub policy: first 3 inbound requests return HTTP 500, the 4th
      // returns HTTP 200 with body `{ ok: true }`. Verifies the
      // CONSERVATIVE preset's `maxAttempts: 3` (1 initial + 3 retries) is
      // active out of the box without any consumer-side configuration.
      stub.setHandler((count, res) => {
        if (count <= 3) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'transient' }))
          return
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      })

      const moduleRef = await buildZeroConfigModule()
      try {
        const client = moduleRef.get(RestClient)

        // Absolute URL is mandatory: zero-config `RestModule` provides an
        // axios instance via `axios.create({})` (no `baseURL`), so relative
        // paths would be sent to `http://localhost/...` rather than the stub.
        const response = await client.get<{ ok: boolean }>(`${stub.baseUrl}/`)

        expect(response.status).toBe(200)
        expect(response.data).toEqual({ ok: true })
        // 1 initial attempt + 3 retries = 4 inbound requests. Asserting on
        // the upstream-observed count (rather than an axios interceptor)
        // proves the requests actually traversed the wire.
        expect(stub.getCount()).toBe(4)
      }
      finally {
        await moduleRef.close()
      }
    })
  })

  describe('AC-18: default preset does not auto-enable new policies', () => {
    it('issues 2 inbound requests for 2 concurrent identical GETs (no auto-deduplication)', async () => {
      // Always-200 handler: both concurrent calls must be visible upstream
      // independently. If the default preset silently enabled the new
      // `deduplication` policy, the upstream would observe ONE request
      // and one of the two promises would resolve from a shared pipeline.
      stub.setHandler((_count, res) => {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      })

      const moduleRef = await buildZeroConfigModule()
      try {
        const client = moduleRef.get(RestClient)

        // Identical URL on purpose — that is the exact key shape any
        // deduplication policy would key on. Promise.all preserves
        // arrival concurrency for the regression guard.
        const [first, second] = await Promise.all([
          client.get<{ ok: boolean }>(`${stub.baseUrl}/`),
          client.get<{ ok: boolean }>(`${stub.baseUrl}/`),
        ])

        expect(first.status).toBe(200)
        expect(second.status).toBe(200)
        expect(stub.getCount()).toBe(2)
      }
      finally {
        await moduleRef.close()
      }
    })

    it('completes 10 sequential GETs in a tight loop with no rate-limiter / throttling delay', async () => {
      // Always-200 handler: aggregate wall-clock time is bounded by the
      // network + cockatiel pipeline overhead, NOT by any rate-limiter
      // or throttling delay. The threshold is intentionally generous
      // (well above the actual ~tens-of-milliseconds runtime) so the
      // test fails LOUDLY if a default rate-limit/throttle slips in,
      // without flaking on slow CI runners.
      stub.setHandler((_count, res) => {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      })

      const moduleRef = await buildZeroConfigModule()
      try {
        const client = moduleRef.get(RestClient)

        // Sequential await is the worst case for a token-bucket
        // rate-limiter (each request waits for the previous to clear)
        // and the only meaningful case for a fixed-interval throttle.
        // The reduce() chain expresses the same sequential semantics as a
        // `for ... await` loop without requiring the `no-await-in-loop`
        // suppression that the loop form would otherwise need.
        const startedAt = Date.now()
        await Array.from({ length: 10 }).reduce<Promise<unknown>>(
          previous => previous.then(
            () => client.get<{ ok: boolean }>(`${stub.baseUrl}/`),
          ),
          Promise.resolve(),
        )
        const elapsedMs = Date.now() - startedAt

        // Even a 1-rps rate-limiter would push this past 9_000 ms; a
        // 100 ms-interval throttle would push it past 1_000 ms. The
        // 2_000 ms ceiling sits comfortably between the regression
        // signal floor (~1_000 ms) and the no-policy ceiling (~tens of ms).
        expect(elapsedMs).toBeLessThan(2_000)
        expect(stub.getCount()).toBe(10)
      }
      finally {
        await moduleRef.close()
      }
    })
  })
})
