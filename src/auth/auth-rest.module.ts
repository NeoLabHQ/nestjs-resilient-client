import { HttpModule, type HttpService } from '@nestjs/axios'
import { type DynamicModule, Module } from '@nestjs/common'
import type { InjectionToken, OptionalFactoryDependency } from '@nestjs/common/interfaces'

import { RestClient } from '../client/rest.client'
import type { ResilanceConfig } from '../client/resilance.config'
import { ResilencePresets, resiliencePolicyPresets } from '../resilence.policy'
import { AuthRestClient } from './auth-rest.client'
import { AuthStrategyService } from './auth-strategy.service'
import type { AuthConfig } from './auth.config'

/**
 * Options object resolved by the consumer-supplied async factory passed to
 * {@link AuthRestModule.forRootAsync}. Carries the three runtime collaborators
 * the module needs to wire up the full authenticated transport stack:
 *
 * - `httpService` — the upstream `@nestjs/axios` `HttpService` used to perform
 *   the actual network calls. Consumers typically obtain it from `HttpModule`
 *   (already imported by this module) via `inject: [HttpService]`.
 * - `authConfig` — the user-supplied authentication factory that produces an
 *   {@link AuthStrategy} when the {@link AuthStrategyService} performs its
 *   handshake (see {@link AuthConfig}).
 * - `resilanceConfig` — optional resilience policy configuration. When
 *   omitted, the module falls back to
 *   `resiliencePolicyPresets[ResilencePresets.CONSERVATIVE]` inside the
 *   {@link RestClient} provider factory (see "AuthRestModule defaults to
 *   CONSERVATIVE preset" acceptance criterion).
 */
export interface AuthRestModuleOptions {
  /** Upstream `@nestjs/axios` HTTP transport used by the constructed {@link RestClient}. */
  httpService: HttpService
  /** User-supplied authentication factory consumed by {@link AuthStrategyService}. */
  authConfig: AuthConfig
  /** Optional resilience policy stack; defaults to the CONSERVATIVE preset when absent. */
  resilanceConfig?: ResilanceConfig<unknown>
}

/**
 * DI token under which the resolved {@link AuthRestModuleOptions} are
 * registered. Defined as a unique `Symbol` (not a magic string) so consumers
 * cannot accidentally shadow it from another module and so the type system
 * can flag mismatches at the provider boundary.
 *
 * Exported for advanced consumers that need to inject the raw options object
 * into their own providers (e.g. for diagnostics or test fixtures).
 */
export const AUTH_MODULE_OPTIONS: unique symbol = Symbol('AUTH_MODULE_OPTIONS')

/**
 * NestJS dynamic module that wires the full authenticated, resilient HTTP
 * client stack:
 *
 * 1. {@link AUTH_MODULE_OPTIONS} — resolved from the consumer-supplied async
 *    factory; carries `httpService`, `authConfig`, and optional
 *    `resilanceConfig`.
 * 2. {@link RestClient} — built from `opts.httpService` and
 *    `opts.resilanceConfig ?? CONSERVATIVE` so a missing
 *    `resilanceConfig` deterministically yields the documented default
 *    preset.
 * 3. {@link AuthStrategyService} — built from `opts.authConfig` and the
 *    resolved {@link RestClient} (so auth requests go through the same
 *    resilience policy stack as application requests).
 * 4. {@link AuthRestClient} — built from the resolved {@link RestClient}
 *    and {@link AuthStrategyService}.
 *
 * Both {@link AuthRestClient} and {@link AuthStrategyService} are useful at
 * the consumer surface (the former for app calls, the latter for inspecting
 * auth state in adapters/middleware), but only {@link AuthRestClient} and
 * {@link RestClient} are exported per the module contract — consumers that
 * need {@link AuthStrategyService} can layer it on themselves or extend this
 * module's exports list.
 *
 * **Single-source-of-truth invariant:** This module is the canonical place to
 * construct {@link RestClient} for the authenticated stack. Re-registering
 * {@link RestClient} elsewhere will produce a second, unrelated instance and
 * break shared circuit-breaker / bulkhead state.
 */
@Module({})
export class AuthRestModule {
  /**
   * Builds a fully wired {@link DynamicModule} from a consumer-supplied async
   * factory. Mirrors the standard NestJS `forRootAsync` shape: the factory
   * receives whatever providers are listed in `inject` and returns (or
   * resolves to) an {@link AuthRestModuleOptions} object.
   *
   * Provider registration order is significant — Nest resolves them lazily,
   * but listing them in dependency order keeps the wiring readable and
   * surfaces accidental cycles as straight-line dependency errors:
   *
   * 1. {@link AUTH_MODULE_OPTIONS} (no internal deps; depends only on `inject`)
   * 2. {@link RestClient}              (depends on AUTH_MODULE_OPTIONS)
   * 3. {@link AuthStrategyService}     (depends on AUTH_MODULE_OPTIONS + RestClient)
   * 4. {@link AuthRestClient}          (depends on RestClient + AuthStrategyService)
   *
   * The default-preset fallback lives inside the {@link RestClient} factory
   * (not at options-resolution time) so consumers explicitly passing
   * `resilanceConfig: undefined` and consumers omitting the field both
   * receive the documented CONSERVATIVE preset.
   *
   * `imports` are spread alongside the always-included `HttpModule` so
   * consumers' factories can `inject: [HttpService]` without re-importing
   * `HttpModule` themselves.
   *
   * @param options - Async factory descriptor. Matches the NestJS dynamic-module idiom.
   * @returns DynamicModule wiring AUTH_MODULE_OPTIONS, RestClient, AuthStrategyService, AuthRestClient.
   */
  static forRootAsync(options: {
    useFactory: (
      ...args: unknown[]
    ) => Promise<AuthRestModuleOptions> | AuthRestModuleOptions
    inject?: unknown[]
    imports?: unknown[]
  }): DynamicModule {
    return {
      module: AuthRestModule,
      // HttpModule is always imported so the consumer's `useFactory` can
      // `inject: [HttpService]` without re-importing it themselves. Any
      // additional `imports` from the caller are appended verbatim.
      imports: [
        HttpModule,
        ...((options.imports ?? []) as NonNullable<DynamicModule['imports']>),
      ],
      providers: [
        // 1. Resolve the consumer's async options first — every other
        //    provider in this module reads from this token.
        {
          provide: AUTH_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: (options.inject ?? []) as Array<
            InjectionToken | OptionalFactoryDependency
          >,
        },
        // 2. RestClient: applies the CONSERVATIVE-preset fallback when the
        //    consumer's options omit `resilanceConfig`. Done inside the
        //    factory (not at options resolution) so the fallback is
        //    deterministic regardless of how the consumer constructs the
        //    options object (omitted vs. explicitly `undefined`).
        {
          provide: RestClient,
          useFactory: (opts: AuthRestModuleOptions): RestClient =>
            new RestClient(
              opts.httpService,
              opts.resilanceConfig,
            ),
          inject: [AUTH_MODULE_OPTIONS],
        },
        // 3. AuthStrategyService: receives the user's AuthConfig plus the
        //    resilient RestClient so its auth handshake reuses the same
        //    resilience policy stack as application calls.
        {
          provide: AuthStrategyService,
          useFactory: (
            opts: AuthRestModuleOptions,
            client: RestClient,
          ): AuthStrategyService =>
            new AuthStrategyService(opts.authConfig, client),
          inject: [AUTH_MODULE_OPTIONS, RestClient],
        },
        // 4. AuthRestClient: top-level facade composed from the two
        //    collaborators above.
        {
          provide: AuthRestClient,
          useFactory: (
            client: RestClient,
            strategy: AuthStrategyService,
          ): AuthRestClient => new AuthRestClient(client, strategy),
          inject: [RestClient, AuthStrategyService],
        },
      ],
      // Both `AuthRestClient` (the authenticated facade) and `RestClient`
      // (the underlying resilient transport) are exported so consumers can
      // inject either depending on whether they need the auth layer.
      exports: [AuthRestClient, RestClient],
    }
  }
}
