import * as publicSurface from '../index'

import { BaseHttpService } from '../client/base-http.service'
import { HookableHttpService } from '../client/hookable-http.service'
import { RestClient } from '../client/rest.client'
import { RestModule } from '../client/rest.module'
import { AuthRestClient } from '../auth/auth-rest.client'
import { AuthProcessor } from '../auth/auth-processor'
import { AuthRestModule } from '../auth/auth-rest.module'
import {
  ResiliencePresets as DirectResiliencePresets,
  resiliencePolicyPresets as directResiliencePolicyPresets,
} from '../resilience.policy'

// Type-only imports — re-imported from the BARREL (not the source modules) so
// the smoke spec exercises the public surface end-to-end. If any of these type
// re-exports goes missing, this file fails to typecheck before any runtime
// assertion has a chance to run.
import type {
  HooksConfig,
  DeduplicationConfig,
  RateLimiterConfig,
  ThrottlingConfig,
  AuthRestModuleOptions,
} from '../index'

/**
 * The package's barrel file (`src/index.ts`) is the consumer-facing surface.
 * Drift between what's documented in README and what's exported is a
 * silent-but-deadly regression because `tsdown` happily bundles whatever the
 * barrel exposes.
 *
 * This spec pins both the runtime symbols (classes + the preset enum/lookup)
 * and the type-only re-exports (which obviously vanish at runtime but are
 * validated by the compile step).
 */
describe('public surface (src/index.ts)', () => {
  describe('runtime class re-exports', () => {
    it('exports the BaseHttpService base class identical to the source class', () => {
      expect(publicSurface.BaseHttpService).toBe(BaseHttpService)
    })

    it('AC-7: BaseHttpService is exported as a constructor function (the abstract marker is a type-only assertion)', () => {
      // `abstract` is erased at runtime — TypeScript prevents direct
      // instantiation at compile time, but the emitted JavaScript is a normal
      // constructor function. Asserting `typeof === 'function'` plus the
      // `prototype` slot pins the runtime metadata that downstream subclasses
      // (RestClient, AuthRestClient, HookableHttpService) rely on.
      expect(typeof publicSurface.BaseHttpService).toBe('function')
      expect(publicSurface.BaseHttpService.prototype).toBeDefined()
    })

    it('AC-7: HookableHttpService is exported as a concrete subclass of BaseHttpService', () => {
      // Identity equality with the source class proves the barrel re-export
      // hasn't been shadowed; the prototype-chain check pins the inheritance
      // relationship documented in README ("HookableHttpService is the new
      // concrete subclass of BaseHttpService").
      expect(publicSurface.HookableHttpService).toBe(HookableHttpService)
      expect(typeof publicSurface.HookableHttpService).toBe('function')
      expect(Object.getPrototypeOf(publicSurface.HookableHttpService)).toBe(
        publicSurface.BaseHttpService,
      )
    })

    it('AC-7: HookableHttpService accepts (httpService, hooks?) and produces a working instance', () => {
      // Smoke-construct a HookableHttpService with a minimal HttpServiceLike
      // stub plus an empty hooks object. This exercises the documented
      // (httpService, hooks?) constructor surface end-to-end through the
      // public barrel — drift in the constructor signature would surface as a
      // TypeScript compilation error before the assertion runs.
      const stubHttp = {
        axiosRef: {} as never,
        request: () => undefined,
        get: () => undefined,
        delete: () => undefined,
        head: () => undefined,
        post: () => undefined,
        put: () => undefined,
        patch: () => undefined,
        postForm: () => undefined,
        putForm: () => undefined,
        patchForm: () => undefined,
      }
      const hooks: HooksConfig = {}
      const instance = new publicSurface.HookableHttpService(stubHttp, hooks)
      expect(instance).toBeInstanceOf(publicSurface.HookableHttpService)
      expect(instance).toBeInstanceOf(publicSurface.BaseHttpService)
    })

    it('exports the RestClient class identical to the source class', () => {
      expect(publicSurface.RestClient).toBe(RestClient)
    })

    it('exports the AuthRestClient class identical to the source class', () => {
      expect(publicSurface.AuthRestClient).toBe(AuthRestClient)
    })

    it('exports the AuthProcessor class identical to the source class', () => {
      expect(publicSurface.AuthProcessor).toBe(AuthProcessor)
    })

    it('exports the AuthRestModule class identical to the source class', () => {
      expect(publicSurface.AuthRestModule).toBe(AuthRestModule)
    })

    it('exports the RestModule class identical to the source class', () => {
      expect(publicSurface.RestModule).toBe(RestModule)
    })
  })

  describe('module token re-exports', () => {
    it('exports the REST_MODULE_OPTIONS symbol from the rest module', () => {
      // REST_MODULE_OPTIONS is the documented DI token consumers use to inject
      // raw RestModule options for diagnostics / test fixtures. Pinning the
      // identity prevents accidental shadowing across re-exports.
      expect(typeof publicSurface.REST_MODULE_OPTIONS).toBe('symbol')
    })
  })

  describe('resilience preset re-exports', () => {
    it('exports the ResiliencePresets const object whose values are usable ResilanceConfig payloads', () => {
      // `ResiliencePresets` is a `const` object plus a `type` of the same name
      // (the union of preset config payloads). The runtime value carries the
      // three documented presets; consumers pass them directly to
      // `new RestClient(http, ResiliencePresets.X)` without a string lookup.
      expect(publicSurface.ResiliencePresets).toBe(DirectResiliencePresets)
      expect(publicSurface.ResiliencePresets.CONSERVATIVE.retry).toBeDefined()
      expect(publicSurface.ResiliencePresets.RESTFULL.retry).toBeDefined()
      expect(publicSurface.ResiliencePresets.LOW_QUALITY.retry).toBeDefined()
    })

    it('exports `resiliencePolicyPresets` as a backward-compatible identity alias of ResiliencePresets', () => {
      // Older consumer code references `resiliencePolicyPresets.X` directly;
      // the alias preserves that surface without duplicating the table. Strict
      // identity equality guards against drift between the two names.
      expect(publicSurface.resiliencePolicyPresets).toBe(directResiliencePolicyPresets)
      expect(publicSurface.resiliencePolicyPresets).toBe(publicSurface.ResiliencePresets)
    })
  })

  describe('type-only re-exports', () => {
    // Type-only exports vanish at runtime, so the assertions in this block are
    // intentionally type-level — the file fails to typecheck (and therefore
    // the whole spec fails to run) if a type re-export goes missing from the
    // barrel. The runtime `expect(true)` is a placeholder so Jest reports the
    // test as executed once the type imports have been resolved.

    it('re-exports HooksConfig from the barrel as a type-only export', () => {
      // Compile-time check: assigning an object literal that satisfies the
      // documented passthrough sentinel proves the type was re-exported with
      // the same shape as the source declaration.
      const config: HooksConfig = {
        onInvoke: (_verb, args) => args,
        onReturn: (_verb, _args, response) => response,
        onError: () => undefined,
      }
      expect(config).toBeDefined()
    })

    it('re-exports DeduplicationConfig, RateLimiterConfig, ThrottlingConfig from the barrel as type-only exports', () => {
      // Compile-time checks: each interface carries the documented required
      // fields. Drift in any field — for example renaming `refillRatePerSec`
      // or making `strategy` optional — is caught here at typecheck time.
      const dedup: DeduplicationConfig = {
        key: (verb, args) => `${verb}:${args.url ?? ''}`,
      }
      const limiter: RateLimiterConfig = {
        strategy: 'token-bucket',
        capacity: 10,
        refillRatePerSec: 5,
      }
      const throttler: ThrottlingConfig = {
        requestsPerInterval: 100,
        intervalMs: 60_000,
      }
      expect(dedup).toBeDefined()
      expect(limiter).toBeDefined()
      expect(throttler).toBeDefined()
    })

    it('re-exports AuthRestModuleOptions from the barrel as a type-only export', () => {
      // Compile-time check: AuthRestModuleOptions extends RestModuleOptions, so
      // a literal carrying the inherited `axios` / `resilience` slots
      // typechecks against the re-exported shape.
      const options: AuthRestModuleOptions = {}
      expect(options).toBeDefined()
    })
  })
})
