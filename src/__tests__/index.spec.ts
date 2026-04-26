import * as publicSurface from '../index'

import { RestClient } from '../client/rest.client'
import { AuthRestClient } from '../auth/auth-rest.client'
import { AuthStrategyService } from '../auth/auth-strategy.service'
import { AuthRestModule } from '../auth/auth-rest.module'
import { ExecuteWithPolicy } from '../client/execute-with-policy.decorator'
import { Authenticate } from '../auth/authenticate.decorator'
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
  })

  describe('decorator factory re-exports', () => {
    it('exports the ExecuteWithPolicy decorator identical to the source factory', () => {
      expect(publicSurface.ExecuteWithPolicy).toBe(ExecuteWithPolicy)
    })

    it('exports the Authenticate decorator identical to the source factory', () => {
      expect(publicSurface.Authenticate).toBe(Authenticate)
    })

    it('exports the DeduplicateInflight decorator identical to the source factory', () => {
      expect(publicSurface.DeduplicateInflight).toBe(DeduplicateInflight)
    })
  })

  describe('resilience preset re-exports', () => {
    it('exports the ResilencePresets enum with stable string values', () => {
      // ResilencePresets is both a value (object) and a type. Pinning the
      // string values here guards against accidental renames that would
      // silently break consumers using `resiliencePolicyPresets[ResilencePresets.X]`.
      expect(publicSurface.ResilencePresets).toBe(DirectResilencePresets)
      expect(publicSurface.ResilencePresets.CONSERVATIVE).toBe('conservative')
      expect(publicSurface.ResilencePresets.RESTFULL).toBe('restfull')
      expect(publicSurface.ResilencePresets.LOW_QUALITY).toBe('low-quality')
    })

    it('exports the resiliencePolicyPresets lookup keyed by every preset value', () => {
      expect(publicSurface.resiliencePolicyPresets).toBe(directResiliencePolicyPresets)
      // Must contain a config entry for every enum member; missing presets
      // surface as `undefined` indexing at consumer call sites.
      for (const preset of Object.values(publicSurface.ResilencePresets)) {
        expect(publicSurface.resiliencePolicyPresets[preset]).toBeDefined()
      }
    })
  })

  describe('exhaustive named export list', () => {
    it('exports exactly the runtime + enum + lookup symbols documented in README', () => {
      // Type-only exports (AuthConfig, AuthStrategy, ResilanceConfig, etc.)
      // are erased at runtime; the runtime keys must therefore be exactly the
      // 9 symbols below. Drift here is a public-API change.
      const actualKeys = Object.keys(publicSurface).sort()
      expect(actualKeys).toEqual(
        [
          'Authenticate',
          'AuthRestClient',
          'AuthRestModule',
          'AuthStrategyService',
          'DeduplicateInflight',
          'ExecuteWithPolicy',
          'ResilencePresets',
          'RestClient',
          'resiliencePolicyPresets',
        ].sort(),
      )
    })
  })
})
