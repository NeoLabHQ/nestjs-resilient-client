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
 * End-to-end coverage for AC-3: when `resilience.deduplication` is enabled,
 * concurrent identical GET requests share a single in-flight upstream call.
 *
 * Strategy: stand up a self-contained in-memory HTTP server that increments
 * a request counter on every inbound call and responds with a deterministic
 * JSON payload. Construct a `RestClient` directly with an `HttpService` whose
 * axios instance is bound to the in-memory server's `baseURL`, configured
 * with `resilience: { deduplication: {} }`. Fire 100 concurrent identical
 * GETs via `Promise.all` and assert the upstream observed exactly 1 inbound
 * request while every promise resolved with equivalent data.
 *
 * Why direct `RestClient` construction (vs. `RestModule.forRootAsync`): the
 * AC-3 contract is on the resilience config behaviour, not on the module
 * wiring path. Mirrors the construction pattern used by
 * `tests/rest-client.e2e.spec.ts` for the same reasons — keeps the spec
 * focused on what AC-3 actually pins (`resilience: { deduplication: {} }`).
 *
 * Why an in-memory server instead of the shared httpbin container: the
 * deduplication assertion requires precise control over the inbound request
 * counter — a counter that resets between tests and is not influenced by
 * ambient traffic from sibling specs sharing the testcontainers fixture.
 */

/** Number of concurrent identical GETs fired in the burst test. */
const CONCURRENT_REQUESTS = 100

describe('Deduplication policy (e2e, AC-3)', () => {
  // Stable handles populated in `beforeAll`; closed in `afterAll`. Using
  // module-scoped variables keeps each `it` body focused on the assertion
  // rather than on server bootstrap.
  let server: Server
  let baseURL: string

  // Inbound request counter incremented per HTTP hit on the local server.
  // Reset in `beforeEach` so cross-test bleed cannot mask a deduplication
  // regression (e.g. a stage that runs in O(N) instead of O(1)).
  let inboundCount = 0

  /**
   * Starts a minimal in-memory HTTP server bound to `127.0.0.1` on an
   * OS-assigned port. The server increments {@link inboundCount} on every
   * request and replies with a deterministic JSON envelope so consumers can
   * assert payload equivalence without worrying about response variance.
   */
  beforeAll(async () => {
    server = createServer((_req, res) => {
      inboundCount += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // Echo the running counter so a test that needs to spot duplicate
      // upstream calls can compare `count` across responses; AC-3 also
      // requires equivalent payloads, which the constant `result` field
      // provides.
      res.end(JSON.stringify({ result: 'ok', count: inboundCount }))
    })

    await new Promise<void>((resolve) => {
      // Listen on `127.0.0.1` rather than `0.0.0.0` so the test binds to a
      // loopback-only interface — avoids accidentally exposing the test
      // server on shared CI runners.
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
    // Fresh counter per test prevents the dedup assertion from being
    // satisfied by a previous test's ambient state. The counter is the
    // primary signal for AC-3, so resetting it is non-negotiable.
    inboundCount = 0
  })

  /**
   * Builds a fresh {@link RestClient} bound to a real `axios` instance
   * targeting the in-memory upstream and wired with
   * `resilience: { deduplication: {} }`. Each test gets its own client so
   * the deduplication operator's per-instance cache (a `Map` captured in
   * the operator closure) starts empty for every test.
   */
  function buildClient(): RestClient {
    const httpService = new HttpService(axios.create({ baseURL }))
    return new RestClient(httpService, {
      // Default key derivation (`${verb}:${url}`) is sufficient — every
      // burst request targets the same URL with the same verb, so the
      // dedup key collides exactly as the AC requires.
      deduplication: {},
    })
  }

  describe('100 concurrent identical GETs', () => {
    it('hits the upstream exactly once and resolves all promises with equivalent data', async () => {
      const client = buildClient()

      // Fire all 100 GETs synchronously so they enter the deduplication
      // operator concurrently — the cache hit window is the time between
      // the first subscriber attaching and the source emitting. Awaiting
      // each call sequentially would defeat the test entirely.
      const responses = await Promise.all(
        Array.from({ length: CONCURRENT_REQUESTS }, () =>
          client.get<{ result: string, count: number }>('/dedup-target')),
      )

      // AC-3 first half: upstream observes exactly 1 inbound request.
      // Any value > 1 means deduplication failed to share the in-flight
      // subscription across concurrent callers.
      expect(inboundCount).toBe(1)

      // AC-3 second half: every caller receives equivalent data. Use the
      // first response as the reference and compare every other response's
      // `data` payload byte-for-byte. `toEqual` is the right matcher here
      // because the response objects themselves are independent (the
      // `shareReplay` operator buffers the value, but each subscriber
      // observes its own `next` invocation).
      expect(responses).toHaveLength(CONCURRENT_REQUESTS)
      const referenceData = responses[0]!.data
      expect(referenceData).toEqual({ result: 'ok', count: 1 })
      for (const response of responses) {
        expect(response.status).toBe(200)
        expect(response.data).toEqual(referenceData)
      }
    })
  })
})
