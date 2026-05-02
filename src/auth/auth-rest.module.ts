import { HttpModule, HttpService } from '@nestjs/axios'
import { type DynamicModule, Module, type Type } from '@nestjs/common'
import type { InjectionToken, OptionalFactoryDependency } from '@nestjs/common/interfaces'

import { ResilencePresets } from '../resilence.policy'
import { RestClient } from '../client/rest.client'
import { resolveResilience, type RestModuleOptions } from '../client/rest.module'
import { AuthProcessor } from './auth-processor'
import { AuthRestClient } from './auth-rest.client'
import type { AuthStrategy } from './auth.config'

/**
 * Options object resolved by the consumer-supplied async factory passed to
 * {@link AuthRestModule.registerAsync}.
 *
 * Extends {@link RestModuleOptions} with no additional fields — `AuthRestModule`
 * now owns its own `HttpModule` registration (driven by `axios`), so consumers
 * no longer supply `httpService` directly. This aligns the authenticated and
 * unauthenticated module ergonomics: both are configured via the same
 * `{ axios?, resilience?, hooks? }` shape.
 *
 * **Breaking change from pre-1.0:** the `httpService` field has been removed.
 * Replace
 * `useFactory: (h: HttpService) => ({ httpService: h })`
 * with
 * `useFactory: () => ({ axios: { baseURL: '...' } })`.
 * The internal `HttpModule.registerAsync(...)` call now consumes
 * `opts.axios` so the upstream transport is built once, in this module, with
 * the consumer-supplied axios configuration.
 *
 * Inherited fields from {@link RestModuleOptions}:
 *
 * - `axios?` — forwarded verbatim to the internally-registered `HttpModule`
 *   (`baseURL`, `timeout`, default headers, …).
 * - `resilience?` — override the CONSERVATIVE default. When omitted, the module
 *   falls back to `ResilencePresets.CONSERVATIVE` inside the
 *   {@link RestClient} provider factory.
 * - `hooks?` — `HookableHttpService` lifecycle hooks (`onInvoke` / `onReturn` /
 *   `onError`) forwarded verbatim to the constructed {@link RestClient}.
 *
 * **Note on the strategy class:** the {@link AuthStrategy} *class token* is
 * passed synchronously as the top-level `authStrategy` field on
 * {@link AuthRestModule.registerAsync}'s argument — it is *not* part of this
 * options object — so the DI container can register it before the async
 * factory resolves. See {@link AuthRestModule.registerAsync} for the full
 * wiring.
 *
 * @example
 * ```ts
 * import type { AuthRestModuleOptions } from 'nestjs-http-client'
 *
 * // Returned by the useFactory callback in AuthRestModule.forRootAsync.
 * const options: AuthRestModuleOptions = {
 *   axios: { baseURL: 'https://api.example.com' },
 *   // Omitting `resilience` applies the CONSERVATIVE preset automatically.
 * }
 * ```
 */
export type AuthRestModuleOptions = RestModuleOptions

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
 *     return this.opts.axios?.baseURL
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
   * `strategy` class token plus a consumer-supplied async factory for
   * runtime data. Mirrors the standard NestJS `forRootAsync` shape on the
   * async side: the factory receives whatever providers are listed in
   * `inject` and returns (or resolves to) an {@link AuthRestModuleOptions}
   * object.
   *
   * The strategy class is registered via `useClass` self-binding
   * (`{ provide: options.strategy, useClass: options.strategy }`),
   * which makes it a full DI citizen with access to constructor-injected
   * dependencies. Strategy classes with constructor dependencies MUST carry
   * `@Injectable()` so NestJS can resolve their parameter metadata.
   *
   * Provider registration order is significant — Nest resolves them lazily,
   * but listing them in dependency order keeps the wiring readable and
   * surfaces accidental cycles as straight-line dependency errors:
   *
   * 1. {@link AUTH_MODULE_OPTIONS} (no internal deps; depends only on `inject`)
   * 2. Strategy self-binding `{ provide: strategy, useClass: strategy }`
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
   * @param options.strategy - Class implementing {@link AuthStrategy}; used
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
   * AuthRestModule.registerAsync({
   *   strategy: StaticBearerStrategy,
   *   inject: [HttpService],
   *   useFactory: (httpService: HttpService) => ({ httpService }),
   * })
   * ```
   */
  static registerAsync(options: {
    strategy: Type<AuthStrategy>
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
      // Mirrors `RestModule.forRootAsync`: the module owns its own axios
      // lifecycle by registering `HttpModule.registerAsync(...)` against
      // `opts.axios ?? {}` so the upstream transport is built once with the
      // consumer-supplied configuration. The resulting `HttpService` is
      // consumed locally (see the `RestClient` provider below) so the
      // canonical `new RestClient(httpService, resilience, hooks)` wiring
      // lives in exactly one place.
      //
      // Note: `RestModule.forHttpService` is intentionally NOT used here
      // even though it would centralise the `new RestClient(...)` call.
      // Routing through that delegation ran into a NestJS DI shadowing
      // issue: the static `@Module({})` decorator on `RestModule` provides
      // an unconfigured default `HttpService` (`axios.create({})`) so the
      // zero-config `imports: [RestModule]` path works, but that local
      // provider shadows the configured `HttpService` from the imported
      // `HttpModule.registerAsync(...)` — yielding a `RestClient` whose
      // `axiosRef.defaults.baseURL` is `undefined` regardless of what the
      // consumer's factory returned. Constructing `RestClient` directly in
      // this module's own provider scope (where `HttpService` resolves
      // unambiguously to the registered `HttpModule.registerAsync` export)
      // avoids the shadowing without dragging the fix into the bare
      // `forHttpService` API.
      imports: [
        HttpModule.registerAsync({
          imports: userImports,
          inject,
          useFactory: async (...args: unknown[]) => {
            const opts = await options.useFactory(...args)
            return opts.axios ?? {}
          },
        }),
        ...userImports,
      ],
      providers: [
        // 1. Resolve the consumer's async options first — kept available to
        //    diagnostics/test fixtures via the AUTH_MODULE_OPTIONS token, and
        //    consumed by the AuthRestClient provider to forward `opts.hooks`.
        {
          provide: AUTH_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject,
        },
        // 2. RestClient — built from the `HttpService` produced by the
        //    `HttpModule.registerAsync(...)` registration above plus the
        //    consumer's resilience/hooks (read out of AUTH_MODULE_OPTIONS).
        //    `resolveResilience` reconciles axios-vs-resilience timeout
        //    precedence (see helper docstring in rest.module.ts). Default
        //    preset fallback applied here so explicit-undefined and omitted
        //    both yield CONSERVATIVE.
        //
        //    DI-scope note: because this provider lives inside
        //    `AuthRestModule`'s dynamic-module scope (NOT inside
        //    `RestModule`), the local static-decorator default
        //    `HttpService` from `RestModule` does NOT shadow the configured
        //    one — `HttpService` resolves cleanly to the export of
        //    `HttpModule.registerAsync(...)` listed in `imports` above.
        {
          provide: RestClient,
          useFactory: (
            httpService: HttpService,
            opts: AuthRestModuleOptions,
          ): RestClient => new RestClient(
            httpService,
            resolveResilience(opts) ?? ResilencePresets.CONSERVATIVE,
            opts.hooks,
          ),
          inject: [HttpService, AUTH_MODULE_OPTIONS],
        },
        // 3. Strategy class self-binding. NestJS DI accepts `useClass`
        //    self-registration for any class with parameter-decorator
        //    metadata (`@Injectable()` on classes with constructor deps;
        //    no decorator needed when the constructor is parameterless).
        //    This makes the strategy injectable into AuthProcessor by token
        //    while still letting it pull its own dependencies from the
        //    surrounding module scope.
        {
          provide: options.strategy,
          useClass: options.strategy,
        },
        // 4. AuthProcessor: receives the DI-resolved strategy instance plus
        //    the resilient RestClient (provided above) so its auth handshake
        //    reuses the same resilience policy stack as application calls.
        //    Inject token is `options.authStrategy` (the user's class token)
        //    — NOT a hardcoded class — so swapping strategies at the call
        //    site is enough to swap the processor's upstream.
        {
          provide: AuthProcessor,
          useFactory: (
            strategy: AuthStrategy,
            client: RestClient,
          ): AuthProcessor => new AuthProcessor(strategy, client),
          inject: [options.strategy, RestClient],
        },
        // 5. AuthRestClient: top-level facade composed from the two
        //    collaborators above. Reads `hooks` from AUTH_MODULE_OPTIONS so
        //    the HookableHttpService lifecycle (`onInvoke` / `onReturn` /
        //    `onError`) wraps the auth lifecycle (which itself wraps the
        //    resilience pipeline owned by the inner RestClient) — same
        //    third-positional-arg contract as `new RestClient(...)`.
        {
          provide: AuthRestClient,
          useFactory: (
            client: RestClient,
            processor: AuthProcessor,
            opts: AuthRestModuleOptions,
          ): AuthRestClient => new AuthRestClient(client, processor, opts.hooks),
          inject: [RestClient, AuthProcessor, AUTH_MODULE_OPTIONS],
        },
      ],
      // Both `AuthRestClient` (the authenticated facade) and `RestClient`
      // (the underlying resilient transport) are exported so consumers can
      // inject either without spinning up a second instance.
      exports: [AuthRestClient, RestClient],
    }
  }
}
