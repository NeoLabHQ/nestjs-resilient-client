import * as publicSurface from '../index'

import { HookableHttpService } from '../client/hookable-http.service'
import { RestClient } from '../client/rest.client'
import { RestModule } from '../client/rest.module'
import { AuthRestClient } from '../auth/auth-rest.client'
import { AuthStrategyService } from '../auth/auth-strategy.service'
import { AuthRestModule } from '../auth/auth-rest.module'
import { DeduplicateInflight } from '../deduplicate-inflight.decorator'
import {
  ResilencePresets as DirectResilencePresets,
  resiliencePolicyPresets as directResiliencePolicyPresets,
} from '../resilence.policy'

/**
 * The package's barrel file (`src/index.ts`) is the consumer-facing surface.
 * Drift between what's documented in README and what's exported is a
 * silent-but-deadly regression because `tsdown` happily bundles whatever the
 * barrel exposes.
 *
 * This spec pins both the runtime symbols (classes + decorator factories +
 * the preset enum/lookup) and the type-only re-exports (which obviously
 * vanish at runtime but are validated by the compile step).
 */
describe('public surface (src/index.ts)', () => {
  describe('runtime class re-exports', () => {
    it('exports the HookableHttpService base class identical to the source class', () => {
      expect(publicSurface.HookableHttpService).toBe(HookableHttpService)
    })

    it('exports the RestClient class identical to the source class', () => {
      expect(publicSurface.RestClient).toBe(RestClient)
    })

    it('exports the AuthRestClient class identical to the source class', () => {
      expect(publicSurface.AuthRestClient).toBe(AuthRestClient)
    })

    it('exports the AuthStrategyService class identical to the source class', () => {
      expect(publicSurface.AuthStrategyService).toBe(AuthStrategyService)
    })

    it('exports the AuthRestModule class identical to the source class', () => {
      expect(publicSurface.AuthRestModule).toBe(AuthRestModule)
    })

    it('exports the RestModule class identical to the source class', () => {
      expect(publicSurface.RestModule).toBe(RestModule)
    })
  })

  describe('decorator factory re-exports', () => {
    it('exports the DeduplicateInflight decorator identical to the source factory', () => {
      expect(publicSurface.DeduplicateInflight).toBe(DeduplicateInflight)
    })
  })

  describe('resilience preset re-exports', () => {
    it('exports the ResilencePresets const object whose values are usable ResilanceConfig payloads', () => {
      // `ResilencePresets` is a `const` object plus a `type` of the same name
      // (the union of preset config payloads). The runtime value carries the
      // three documented presets; consumers pass them directly to
      // `new RestClient(http, ResilencePresets.X)` without a string lookup.
      expect(publicSurface.ResilencePresets).toBe(DirectResilencePresets)
      expect(publicSurface.ResilencePresets.CONSERVATIVE.retry).toBeDefined()
      expect(publicSurface.ResilencePresets.RESTFULL.retry).toBeDefined()
      expect(publicSurface.ResilencePresets.LOW_QUALITY.retry).toBeDefined()
    })

    it('exports `resiliencePolicyPresets` as a backward-compatible identity alias of ResilencePresets', () => {
      // Older consumer code references `resiliencePolicyPresets.X` directly;
      // the alias preserves that surface without duplicating the table. Strict
      // identity equality guards against drift between the two names.
      expect(publicSurface.resiliencePolicyPresets).toBe(directResiliencePolicyPresets)
      expect(publicSurface.resiliencePolicyPresets).toBe(publicSurface.ResilencePresets)
    })
  })

  describe('exhaustive named export list', () => {
    it('exports exactly the runtime + enum + lookup symbols documented in README', () => {
      // Type-only exports (AuthConfig, AuthStrategy, ResilanceConfig, HooksConfig,
      // HttpVerb, InvokeArgs, ReturnArgs, etc.) are erased at runtime; the runtime
      // keys must therefore be exactly the symbols below. Drift here is a public-API
      // change.
      const actualKeys = Object.keys(publicSurface).sort()
      expect(actualKeys).toEqual(
        [
          'AuthRestClient',
          'AuthRestModule',
          'AuthStrategyService',
          'DeduplicateInflight',
          'HookableHttpService',
          'ResilencePresets',
          'RestClient',
          'RestModule',
          'resiliencePolicyPresets',
        ].sort(),
      )
    })
  })
})
