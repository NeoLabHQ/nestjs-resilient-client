import { HttpModule, type HttpService } from '@nestjs/axios'
import { type DynamicModule, Module, type Type } from '@nestjs/common'
import type { InjectionToken, OptionalFactoryDependency } from '@nestjs/common/interfaces'

import { RestClient } from '../client/rest.client'
import type { ResilanceConfig } from '../client/resilance.config'
import { RestModule } from '../client/rest.module'
import { AuthProcessor } from './auth-processor'
import { AuthRestClient } from './auth-rest.client'
import type { AuthStrategy } from './auth.config'

/**
 * Options object resolved by the consumer-supplied async factory passed to
 * {@link AuthRestModule.forRootAsync}. Carries the runtime collaborators the
 * module needs to wire up the authenticated transport stack:
 *
 * - `httpService` — the upstream `@nestjs/axios` `HttpService` used to perform
 *   the actual network calls. Consumers typically obtain it from `HttpModule`
 *   (already imported by this module) via `inject: [HttpService]`.
 * - `resilience` — optional resilience policy configuration. When omitted, the
 *   module falls back to `ResilencePresets.CONSERVATIVE` inside the
 *   {@link RestClient} provider factory (see "AuthRestModule defaults to
 *   CONSERVATIVE preset" acceptance criterion).
 *
 * **Note on the strategy class:** the {@link AuthStrategy} *class token* is no
 * longer carried inside this options object — it is passed synchronously as the
 * top-level `authStrategy` field on {@link AuthRestModule.forRootAsync}'s
 * argument so the DI container can register it before the async factory
 * resolves. See {@link AuthRestModule.forRootAsync} for the full wiring.
 *
 * @example
 * ```ts
 * import { HttpService } from '@nestjs/axios'
 * import type { AuthRestModuleOptions } from 'nestjs-http-client'
 *
 * // Returned by the useFactory callback in AuthRestModule.forRootAsync.
 * const options: AuthRestModuleOptions = {
 *   httpService: inject(HttpService),
 *   // Omitting `resilience` applies the CONSERVATIVE preset automatically.
 * }
 * ```
 */
export interface AuthRestModuleOptions {
  /** Upstream `@nestjs/axios` HTTP transport used by the constructed {@link RestClient}. */
  httpService: HttpService
  /** Optional resilience policy stack; defaults to the CONSERVATIVE preset when absent. */
  resilience?: ResilanceConfig<unknown>
}

/**
 * DI token under which the resolved {@link AuthRestModuleOptions} are
 * registered. Defined as a unique `Symbol` (not a magic string) so consumers
 * cannot accidentally shadow it from another module and so the type system
 * can flag mismatches at the provider boundary.
 *
 * Exported for advanced consumers that need to inject the raw options object
 * into their own providers (e.g. for diagnostics or test fixtures).
 *
 * @example
 * ```ts
 * import { Inject, Injectable } from '@nestjs/common'
 * import { AUTH_MODULE_OPTIONS, type AuthRestModuleOptions } from 'nestjs-http-client'
 *
 * // Inject the raw options for diagnostics or test fixtures.
 * @Injectable()
 * class AuthDiagnosticsService {
 *   constructor(
 *     @Inject(AUTH_MODULE_OPTIONS) private readonly opts: AuthRestModuleOptions,
 *   ) {}
 *
 *   getBaseUrl(): string | undefined {
 *     return this.opts.httpService.axiosRef.defaults.baseURL
 *   }
 * }
 * ```
 */
export const AUTH_MODULE_OPTIONS: unique symbol = Symbol('AUTH_MODULE_OPTIONS')

/**
 * NestJS dynamic module that wires the full authenticated, resilient HTTP
 * client stack:
 *
 * 1. {@link AUTH_MODULE_OPTIONS} — resolved from the consumer-supplied async
 *    factory; carries `httpService` and optional `resilience`.
 * 2. {@link AuthStrategy} class — registered via `useClass` self-binding under
 *    the consumer-supplied `authStrategy` token. This makes the strategy a
 *    full DI citizen: it can `@Inject(...)` any provider available in the
 *    module's DI scope (configuration services, secret stores, loggers, …).
 * 3. {@link RestClient} — built from `opts.httpService` and
 *    `opts.resilience ?? CONSERVATIVE` so a missing `resilience` deterministically
 *    yields the documented default preset. Construction is delegated to
 *    {@link RestModule.forHttpService} so the canonical
 *    `new RestClient(httpService, resilanceConfig)` wiring lives in exactly
 *    one place.
 * 4. {@link AuthProcessor} — built from the DI-resolved {@link AuthStrategy}
 *    instance and the resolved {@link RestClient} (so auth requests go through
 *    the same resilience policy stack as application requests).
 * 5. {@link AuthRestClient} — built from the resolved {@link RestClient} and
 *    {@link AuthProcessor}.
 *
 * Only {@link AuthRestClient} and {@link RestClient} are exported — the
 * {@link AuthProcessor} and the user's strategy class are implementation
 * details of the authenticated transport pipeline. Consumers that need to
 * inspect them can layer on extra exports themselves.
 *
 * **Strategy class requirements:**
 *
 * - Implements {@link AuthStrategy}.
 * - Carries `@Injectable()` from `@nestjs/common` if it has constructor
 *   dependencies — without the decorator, NestJS cannot resolve constructor
 *   parameter metadata and will throw at module bootstrap.
 *
 * **Single-source-of-truth invariant:** This module is the canonical place to
 * construct {@link RestClient} for the authenticated stack. Re-registering
 * {@link RestClient} elsewhere will produce a second, unrelated instance and
 * break shared circuit-breaker / bulkhead state.
 *
 * @example
 * ```ts
 * import { Inject, Injectable, Module } from '@nestjs/common'
 * import { ConfigModule, ConfigService } from '@nestjs/config'
 * import { HttpService } from '@nestjs/axios'
 * import {
 *   AuthRestModule,
 *   RestClient,
 *   type AuthStrategy,
 * } from 'nestjs-http-client'
 * import type { AxiosRequestConfig } from 'axios'
 *
 * // Strategy classes are full DI citizens — `@Injectable()` enables
 * // constructor injection of any provider in the module scope.
 * @Injectable()
 * class BearerTokenStrategy implements AuthStrategy {
 *   private token?: string
 *   private expiresAt = 0
 *
 *   constructor(@Inject(ConfigService) private readonly config: ConfigService) {}
 *
 *   async authenticate(client: RestClient): Promise<void> {
 *     const response = await client.post<{ access_token: string, expires_in: number }>(
 *       this.config.getOrThrow('AUTH_TOKEN_URL'),
 *       { grant_type: 'client_credentials' },
 *     )
 *     this.token = response.data.access_token
 *     this.expiresAt = Date.now() + response.data.expires_in * 1_000 - 60_000
 *   }
 *
 *   isAuthenticated(): boolean {
 *     return this.token !== undefined && Date.now() < this.expiresAt
 *   }
 *
 *   extendRequest(config: AxiosRequestConfig): AxiosRequestConfig {
 *     return {
 *       ...config,
 *       headers: { ...(config.headers ?? {}), Authorization: `Bearer ${this.token}` },
 *     }
 *   }
 *
 *   invalidate(): void {
 *     this.token = undefined
 *     this.expiresAt = 0
 *   }
 * }
 *
 * @Module({
 *   imports: [
 *     AuthRestModule.forRootAsync({
 *       // Synchronous: passed to NestJS DI as a class token, registered via
 *       // `useClass` self-binding so it can resolve its own constructor deps.
 *       authStrategy: BearerTokenStrategy,
 *       // Async: runtime data only — httpService and optional resilience.
 *       imports: [ConfigModule],
 *       inject: [HttpService],
 *       useFactory: (httpService: HttpService) => ({ httpService }),
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
@Module({})
export class AuthRestModule {
  /**
   * Builds a fully wired {@link DynamicModule} from a synchronous
   * `authStrategy` class token plus a consumer-supplied async factory for
   * runtime data. Mirrors the standard NestJS `forRootAsync` shape on the
   * async side: the factory receives whatever providers are listed in
   * `inject` and returns (or resolves to) an {@link AuthRestModuleOptions}
   * object.
   *
   * The strategy class is registered via `useClass` self-binding
   * (`{ provide: options.authStrategy, useClass: options.authStrategy }`),
   * which makes it a full DI citizen with access to constructor-injected
   * dependencies. Strategy classes with constructor dependencies MUST carry
   * `@Injectable()` so NestJS can resolve their parameter metadata.
   *
   * Provider registration order is significant — Nest resolves them lazily,
   * but listing them in dependency order keeps the wiring readable and
   * surfaces accidental cycles as straight-line dependency errors:
   *
   * 1. {@link AUTH_MODULE_OPTIONS} (no internal deps; depends only on `inject`)
   * 2. Strategy self-binding `{ provide: authStrategy, useClass: authStrategy }`
   *    (depends on whatever the strategy class itself injects)
   * 3. {@link AuthProcessor} (depends on the strategy token + RestClient)
   * 4. {@link AuthRestClient} (depends on RestClient + AuthProcessor)
   *
   * The default-preset fallback lives inside the {@link RestClient} factory
   * (delegated to {@link RestModule.forHttpService}) so consumers explicitly
   * passing `resilience: undefined` and consumers omitting the field both
   * receive the documented CONSERVATIVE preset.
   *
   * `imports` are spread alongside the always-included `HttpModule` so
   * consumers' factories can `inject: [HttpService]` without re-importing
   * `HttpModule` themselves.
   *
   * @param options - Module wiring descriptor.
   * @param options.authStrategy - Class implementing {@link AuthStrategy}; used
   *   as both the DI token and the `useClass` value (self-binding). Must carry
   *   `@Injectable()` if it has constructor dependencies.
   * @param options.useFactory - Async factory returning {@link AuthRestModuleOptions}
   *   (runtime data: `httpService`, optional `resilience`).
   * @param options.inject - Tokens forwarded to `useFactory` (NestJS idiom).
   * @param options.imports - Modules forwarded to the internal `HttpModule`,
   *   `AUTH_MODULE_OPTIONS`, and {@link RestModule.forHttpService} factories.
   * @returns DynamicModule wiring AUTH_MODULE_OPTIONS, the strategy class,
   *   RestClient, AuthProcessor, and AuthRestClient.
   *
   * @example
   * ```ts
   * import { Injectable } from '@nestjs/common'
   * import { HttpService } from '@nestjs/axios'
   * import { AuthRestModule, type AuthStrategy } from 'nestjs-http-client'
   *
   * @Injectable()
   * class StaticBearerStrategy implements AuthStrategy {
   *   async authenticate() {}
   *   isAuthenticated() { return true }
   *   extendRequest(config) {
   *     return { ...config, headers: { ...config.headers, Authorization: 'Bearer static' } }
   *   }
   *   invalidate() {}
   * }
   *
   * AuthRestModule.forRootAsync({
   *   authStrategy: StaticBearerStrategy,
   *   inject: [HttpService],
   *   useFactory: (httpService: HttpService) => ({ httpService }),
   * })
   * ```
   */
  static forRootAsync(options: {
    authStrategy: Type<AuthStrategy>
    useFactory: (
      ...args: unknown[]
    ) => Promise<AuthRestModuleOptions> | AuthRestModuleOptions
    inject?: unknown[]
    imports?: unknown[]
  }): DynamicModule {
    const inject = (options.inject ?? []) as Array<
      InjectionToken | OptionalFactoryDependency
    >
    const userImports = (options.imports ?? []) as NonNullable<DynamicModule['imports']>

    return {
      module: AuthRestModule,
      // HttpModule is always imported so the consumer's `useFactory` can
      // `inject: [HttpService]` without re-importing it themselves. Any
      // additional `imports` from the caller are appended verbatim.
      // RestModule.forHttpService is imported so RestClient construction
      // is delegated there — eliminating the duplicate `new RestClient(...)`
      // call that would otherwise exist in both modules.
      imports: [
        HttpModule,
        ...userImports,
        RestModule.forHttpService({
          imports: userImports,
          inject,
          // Derive httpService and resilience directly from the consumer's
          // factory so RestModule does not need to know about
          // AUTH_MODULE_OPTIONS. The field names in this module's options shape
          // (`httpService`, `resilience`) match `RestFromHttpServiceOptions`
          // exactly, so the consumer's factory output flows through unchanged.
          useFactory: async (...args: unknown[]) => {
            const opts = await options.useFactory(...args)
            return { httpService: opts.httpService, resilience: opts.resilience }
          },
        }),
      ],
      providers: [
        // 1. Resolve the consumer's async options first — kept available to
        //    diagnostics/test fixtures via the AUTH_MODULE_OPTIONS token.
        {
          provide: AUTH_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject,
        },
        // 2. Strategy class self-binding. NestJS DI accepts `useClass`
        //    self-registration for any class with parameter-decorator
        //    metadata (`@Injectable()` on classes with constructor deps;
        //    no decorator needed when the constructor is parameterless).
        //    This makes the strategy injectable into AuthProcessor by token
        //    while still letting it pull its own dependencies from the
        //    surrounding module scope.
        {
          provide: options.authStrategy,
          useClass: options.authStrategy,
        },
        // 3. AuthProcessor: receives the DI-resolved strategy instance plus
        //    the resilient RestClient (provided by the imported RestModule)
        //    so its auth handshake reuses the same resilience policy stack
        //    as application calls. Inject token is `options.authStrategy`
        //    (the user's class token) — NOT a hardcoded class — so swapping
        //    strategies at the call site is enough to swap the processor's
        //    upstream.
        {
          provide: AuthProcessor,
          useFactory: (
            strategy: AuthStrategy,
            client: RestClient,
          ): AuthProcessor => new AuthProcessor(strategy, client),
          inject: [options.authStrategy, RestClient],
        },
        // 4. AuthRestClient: top-level facade composed from the two
        //    collaborators above.
        {
          provide: AuthRestClient,
          useFactory: (
            client: RestClient,
            processor: AuthProcessor,
          ): AuthRestClient => new AuthRestClient(client, processor),
          inject: [RestClient, AuthProcessor],
        },
      ],
      // `AuthRestClient` (the authenticated facade) is exported directly.
      // `RestClient` (the underlying resilient transport) is re-exported by
      // listing `RestModule` — the module that owns the RestClient provider.
      // NestJS re-exports all exports of a listed module, so consumers can
      // inject RestClient from either module without a second instance.
      exports: [AuthRestClient, RestModule],
    }
  }
}
