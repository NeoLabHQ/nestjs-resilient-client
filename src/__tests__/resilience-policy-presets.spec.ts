import type { AxiosError } from 'axios'

import {
  CONSERVATIVE_TIMEOUT_MS,
  LOW_QUALITY_TIMEOUT_MS,
  RESTFULL_TIMEOUT_MS,
  ResilencePresets,
  defaultCircutBreaker,
  resiliencePolicyPresets,
  safeMethodsRetry,
} from '../resilence.policy'

/**
 * Build a synthetic AxiosError that satisfies `axios.isAxiosError(...)`.
 *
 * The presets' `shouldRetry` functions delegate to `isRetryableError`, which
 * inspects `isAxiosError`, `config.method`, and `response.status`. Mirrors
 * the construction pattern used in `should-retry.spec.ts` so the suite is
 * consistent.
 */
function makeAxiosError(method: string, status?: number): AxiosError {
  const error = new Error('test') as Error & {
    isAxiosError: boolean
    response?: { status: number }
    request?: object
    config?: { method: string }
  }
  error.isAxiosError = true
  error.config = { method }
  if (status !== undefined) {
    error.response = { status }
  }
  else {
    error.request = {}
  }
  return error as unknown as AxiosError
}

describe('resilience policy presets', () => {
  describe('ResilencePresets const object', () => {
    it('exposes exactly three presets keyed by the documented identifiers', () => {
      // `ResilencePresets` is now a `const` object whose values are the full
      // `ResilanceConfig` payloads (no string-key indirection). The keys
      // CONSERVATIVE / RESTFULL / LOW_QUALITY are the public contract
      // referenced by the README's "Configuration Strategies" section —
      // adding or renaming a preset requires a README change.
      const keys = Object.keys(ResilencePresets).sort()
      expect(keys).toEqual(['CONSERVATIVE', 'LOW_QUALITY', 'RESTFULL'])
    })

    it('every preset value is a usable `ResilanceConfig` (not a string identifier)', () => {
      // The whole point of the const-object reshape: a preset value can be
      // passed directly to `new RestClient(http, ResilencePresets.X)` without
      // an extra lookup. Smoke-test the shape so a future regression that
      // re-introduces string identifiers is caught at compile + runtime.
      for (const preset of Object.values(ResilencePresets)) {
        expect(preset.retry).toBeDefined()
        expect(preset.circuitBreaker).toBeDefined()
        expect(preset.timeout).toBeDefined()
      }
    })
  })

  describe('safeMethodsRetry', () => {
    it('configures maxAttempts=3', () => {
      expect(safeMethodsRetry.maxAttempts).toBe(3)
    })

    it('retries safe HTTP methods (GET/HEAD/OPTIONS) on 5xx', () => {
      // Pin the documented "GET/HEAD/OPTIONS only" behaviour. Adding new
      // methods to the safe list requires updating the README + this test.
      expect(safeMethodsRetry.shouldRetry?.(makeAxiosError('GET', 500))).toBe(true)
      expect(safeMethodsRetry.shouldRetry?.(makeAxiosError('HEAD', 503))).toBe(true)
      expect(safeMethodsRetry.shouldRetry?.(makeAxiosError('OPTIONS', 502))).toBe(true)
    })

    it('does NOT retry non-safe methods (POST/PUT/DELETE/PATCH) on 5xx', () => {
      // Non-idempotent methods MUST NOT be retried under the conservative
      // safe-list. Mutation testing previously caught a regression where the
      // method allow-list was widened by accident.
      expect(safeMethodsRetry.shouldRetry?.(makeAxiosError('POST', 500))).toBe(false)
      expect(safeMethodsRetry.shouldRetry?.(makeAxiosError('PUT', 500))).toBe(false)
      expect(safeMethodsRetry.shouldRetry?.(makeAxiosError('DELETE', 500))).toBe(false)
      expect(safeMethodsRetry.shouldRetry?.(makeAxiosError('PATCH', 500))).toBe(false)
    })
  })

  describe('defaultCircutBreaker', () => {
    it('configures the half-open recovery window at 60 seconds', () => {
      expect(defaultCircutBreaker.halfOpenAfter).toBe(60_000)
    })

    it('uses a sampling-options breaker spec (threshold near 1, 60s duration, 100 minRps)', () => {
      // SamplingBreaker requires `0 < threshold < 1` strictly — `0.99` is the
      // pinned value. Reverting to `1` resurrects the historical RangeError.
      const breaker = defaultCircutBreaker.breaker as {
        threshold: number
        duration: number
        minimumRps: number
      }
      expect(breaker.threshold).toBeGreaterThan(0)
      expect(breaker.threshold).toBeLessThan(1)
      expect(breaker.threshold).toBe(0.99)
      expect(breaker.duration).toBe(60_000)
      expect(breaker.minimumRps).toBe(100)
    })
  })

  describe('ResilencePresets.CONSERVATIVE', () => {
    const preset = ResilencePresets.CONSERVATIVE

    it('shares the safeMethodsRetry retry config object', () => {
      // Identity equality matters — same object reference is the intent so
      // future tweaks to `safeMethodsRetry` propagate through the preset.
      expect(preset.retry).toBe(safeMethodsRetry)
    })

    it('shares the defaultCircutBreaker circuit-breaker config object', () => {
      expect(preset.circuitBreaker).toBe(defaultCircutBreaker)
    })

    it('does not configure bulkhead or fallback', () => {
      // README documents "retry + circuitBreaker only" for CONSERVATIVE.
      // Adding bulkhead/fallback is a NFR change requiring docs update.
      // The const-narrowed type omits these fields entirely, so the absence
      // check uses `Object.hasOwn` to keep the assertion grounded in runtime
      // behaviour rather than the narrowed compile-time shape.
      expect(Object.hasOwn(preset, 'bulkhead')).toBe(false)
      expect(Object.hasOwn(preset, 'fallback')).toBe(false)
    })

    it('configures a 60 s pipeline-wide timeout per the README spec', () => {
      // README "Conservative" section: "Timeout is 60 seconds." This bound
      // covers the full retry pipeline (including backoff sleeps), so callers
      // do not need to set a separate axios `timeout`.
      expect(preset.timeout).toBe(60_000)
      expect(preset.timeout).toBe(CONSERVATIVE_TIMEOUT_MS)
    })
  })

  describe('ResilencePresets.RESTFULL', () => {
    const preset = ResilencePresets.RESTFULL

    it('preserves maxAttempts=3 from safeMethodsRetry', () => {
      expect(preset.retry?.maxAttempts).toBe(3)
    })

    it('shares the same backoff factory as safeMethodsRetry (spread copy)', () => {
      // RESTFULL retry config spreads `safeMethodsRetry`, so sub-fields
      // (other than `shouldRetry`) must be reference-equal to the source.
      expect(preset.retry?.backoff).toBe(safeMethodsRetry.backoff)
    })

    it('uses a DIFFERENT shouldRetry function than safeMethodsRetry', () => {
      // The whole point of the RESTFULL preset is a wider method allow-list,
      // implemented by overriding `shouldRetry`. Identity inequality is the
      // simplest way to verify the override actually replaced the function.
      expect(preset.retry?.shouldRetry).not.toBe(safeMethodsRetry.shouldRetry)
    })

    it('retries safe HTTP methods (GET/HEAD/OPTIONS) on 5xx', () => {
      // RESTFULL is a superset — it MUST still retry GET/HEAD/OPTIONS.
      expect(preset.retry?.shouldRetry?.(makeAxiosError('GET', 500))).toBe(true)
      expect(preset.retry?.shouldRetry?.(makeAxiosError('HEAD', 503))).toBe(true)
      expect(preset.retry?.shouldRetry?.(makeAxiosError('OPTIONS', 502))).toBe(true)
    })

    it('retries PUT and DELETE on 5xx (extended idempotent set)', () => {
      // The README's "Restfull" section documents PUT/DELETE retries. This
      // test exercises the actual `shouldRetry` arrow function in the
      // preset (which `LOW_QUALITY` and `CONSERVATIVE` do not).
      expect(preset.retry?.shouldRetry?.(makeAxiosError('PUT', 500))).toBe(true)
      expect(preset.retry?.shouldRetry?.(makeAxiosError('DELETE', 503))).toBe(true)
    })

    it('does NOT retry POST or PATCH on 5xx (still excluded)', () => {
      // PATCH and POST remain non-idempotent under REST semantics, so the
      // preset MUST NOT retry them even though it widens PUT/DELETE.
      expect(preset.retry?.shouldRetry?.(makeAxiosError('POST', 500))).toBe(false)
      expect(preset.retry?.shouldRetry?.(makeAxiosError('PATCH', 500))).toBe(false)
    })

    it('also handles network errors for PUT/DELETE (no response)', () => {
      // Without a response, the error is treated as a network/internal error.
      // PUT/DELETE remain in the allow-list, so retry must fire.
      const putNetwork = makeAxiosError('PUT')
      // axios sets `code` for true network errors; supply one so
      // `isNetworkError` returns true.
      ;(putNetwork as AxiosError & { code: string }).code = 'ECONNRESET'
      expect(preset.retry?.shouldRetry?.(putNetwork)).toBe(true)
    })

    it('shares the defaultCircutBreaker circuit-breaker config object', () => {
      expect(preset.circuitBreaker).toBe(defaultCircutBreaker)
    })

    it('configures a 10 s pipeline-wide timeout per the README spec', () => {
      // README "Restfull" section: "Timeout is 10 seconds." Tighter than
      // CONSERVATIVE because the preset trusts the upstream API to be healthy
      // and idempotent.
      expect(preset.timeout).toBe(10_000)
      expect(preset.timeout).toBe(RESTFULL_TIMEOUT_MS)
    })
  })

  describe('ResilencePresets.LOW_QUALITY', () => {
    const preset = ResilencePresets.LOW_QUALITY

    it('reuses the same safeMethodsRetry config as CONSERVATIVE', () => {
      // README documents LOW_QUALITY as "same retry surface as CONSERVATIVE"
      // — naming-only differentiator. Identity equality enforces that.
      expect(preset.retry).toBe(safeMethodsRetry)
    })

    it('reuses the same defaultCircutBreaker as CONSERVATIVE', () => {
      expect(preset.circuitBreaker).toBe(defaultCircutBreaker)
    })

    it('configures a 180 s pipeline-wide timeout per the README spec', () => {
      // README "Low Quality" section: "Timeout is 180 seconds (3 minutes)."
      // The longest budget — designed for sluggish upstream services that
      // still occasionally finish.
      expect(preset.timeout).toBe(180_000)
      expect(preset.timeout).toBe(LOW_QUALITY_TIMEOUT_MS)
    })
  })

  describe('resiliencePolicyPresets backward-compatible alias', () => {
    it('points to the same const object as ResilencePresets (identity alias)', () => {
      // `resiliencePolicyPresets` is retained as a deprecated re-export so
      // older consumer code (referencing the historical lookup-table name)
      // keeps compiling. Identity equality is the contract — drift here means
      // we accidentally created a duplicate object rather than aliasing.
      expect(resiliencePolicyPresets).toBe(ResilencePresets)
    })

    it('exposes every preset directly as a usable ResilanceConfig', () => {
      // No string-key indirection — `resiliencePolicyPresets.CONSERVATIVE`
      // returns the config payload directly. This is the new ergonomics that
      // replace the historical `resiliencePolicyPresets[ResilencePresets.X]`
      // double-lookup form documented in earlier README revisions.
      for (const preset of Object.values(resiliencePolicyPresets)) {
        expect(preset.retry).toBeDefined()
        expect(preset.circuitBreaker).toBeDefined()
      }
    })
  })
})
