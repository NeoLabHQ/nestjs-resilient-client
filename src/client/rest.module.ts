import { HttpModule, HttpService } from '@nestjs/axios'
import type { HttpModuleOptions } from '@nestjs/axios'
import { type DynamicModule, Module } from '@nestjs/common'
import type { InjectionToken, OptionalFactoryDependency } from '@nestjs/common/interfaces'

import type { ResilanceConfig } from './resilance.config'
import { RestClient } from './rest.client'

/**
 * Minimal options for {@link RestModule.forHttpService} — the caller supplies a
 * pre-resolved `HttpService` so the sub-module does not need to spin up its own
 * `HttpModule`. Used by {@link AuthRestModule} to delegate `RestClient` construction
 * to `RestModule`, eliminating the duplicated `new RestClient(httpService, config)`
 * call that would otherwise exist in both modules.
 *
 * @example
 * ```ts
 * import { HttpModule, HttpService } from '@nestjs/axios'
 * import { Module } from '@nestjs/common'
 * import { RestModule, ResilencePresets } from 'nestjs-http-client'
 *
 * @Module({
 *   imports: [
 *     HttpModule,
 *     RestModule.forHttpService({
 *       imports: [HttpModule],
 *       inject: [HttpService],
 *       useFactory: (httpService: HttpService) => ({
 *         httpService,
 *         resilience: ResilencePresets.RESTFULL,
 *       }),
 *     }),
 *   ],
 * })
 * export class CatalogModule {}
 * ```
 */
export interface RestFromHttpServiceOptions {
  /** Pre-resolved `@nestjs/axios` transport to hand to the constructed {@link RestClient}. */
  httpService: HttpService
  /** Optional resilience policy stack; defaults to the CONSERVATIVE preset when absent. */
  resilience?: ResilanceConfig<unknown>
}

/**
 * Options object resolved by the consumer-supplied async factory passed to
 * {@link RestModule.forRootAsync}. Carries the two collaborating concerns the
 * module needs to wire up the resilient transport stack:
 *
 * - `axios` — forwarded verbatim to `HttpModule.registerAsync` so the
 *   underlying `axios` instance is constructed with consumer-supplied
 *   `baseURL`, `timeout`, default `headers`, etc. Omit to pick up the
 *   axios defaults.
 * - `resilience` — optional resilience policy stack. When omitted, the
 *   module falls back to the CONSERVATIVE preset inside the {@link RestClient}
 *   provider factory (matching the documented {@link RestClient} default).
 *
 * @example
 * ```ts
 * import { ConfigModule, ConfigService } from '@nestjs/config'
 * import { RestModule, ResilencePresets } from 'nestjs-http-client'
 * import type { RestModuleOptions } from 'nestjs-http-client'
 *
 * RestModule.forRootAsync({
 *   imports: [ConfigModule],
 *   inject: [ConfigService],
 *   useFactory: (config: ConfigService): RestModuleOptions => ({
 *     axios: {
 *       baseURL: config.get('API_BASE_URL'),
 *       timeout: 5_000,
 *     },
 *     resilience: ResilencePresets.RESTFULL,
 *   }),
 * })
 * ```
 */
export interface RestModuleOptions {
  /**
   * Axios configuration forwarded to the internally-managed `HttpModule`.
   * Type alias `HttpModuleOptions` is `AxiosRequestConfig & { global?: boolean }`
   * — exactly what `HttpModule.register({ ... })` accepts.
   */
  axios?: HttpModuleOptions
  /** Optional resilience policy stack; defaults to the CONSERVATIVE preset when absent. */
  resilience?: ResilanceConfig<unknown>
}

/**
 * DI token under which the resolved {@link RestModuleOptions} are registered.
 * Defined as a unique `Symbol` (not a magic string) so consumers cannot
 * accidentally shadow it from another module and so the type system can flag
 * mismatches at the provider boundary.
 *
 * Exported for advanced consumers that need to inject the raw options object
 * into their own providers (e.g. for diagnostics or test fixtures).
 *
 * @example
 * ```ts
 * import { Inject, Injectable } from '@nestjs/common'
 * import { REST_MODULE_OPTIONS, type RestModuleOptions } from 'nestjs-http-client'
 *
 * @Injectable()
 * export class DiagnosticsService {
 *   constructor(
 *     @Inject(REST_MODULE_OPTIONS) private readonly opts: RestModuleOptions,
 *   ) {}
 *
 *   getBaseUrl(): string {
 *     return this.opts.axios?.baseURL ?? '(none)'
 *   }
 * }
 * ```
 */
export const REST_MODULE_OPTIONS: unique symbol = Symbol('REST_MODULE_OPTIONS')

/**
 * NestJS dynamic module that wires the unauthenticated, resilient HTTP client
 * stack with a single factory call:
 *
 * 1. {@link REST_MODULE_OPTIONS} — resolved from the consumer-supplied async
 *    factory; carries optional `axiosConfig` and `resilience`.
 * 2. `HttpModule` — registered asynchronously with the consumer's `axios`
 *    config, so the underlying axios instance is created exactly once with the
 *    configured `baseURL`, `timeout`, default headers, etc.
 * 3. {@link RestClient} — built from the `HttpService` provided by the
 *    internally-registered `HttpModule` and `opts.resilience`, falling
 *    back to the CONSERVATIVE preset when the consumer omits the field.
 *
 * Removes the manual `HttpModule.register({...})` + `useFactory: (http) =>
 * new RestClient(http)` boilerplate every consumer otherwise needs to repeat.
 *
 * **Single-source-of-truth invariant:** This module is the canonical place to
 * construct {@link RestClient} for the unauthenticated stack. Re-registering
 * {@link RestClient} elsewhere will produce a second, unrelated instance and
 * break shared circuit-breaker / bulkhead state.
 *
 * @example
 * ```ts
 * import { Module } from '@nestjs/common'
 * import { RestModule } from 'nestjs-http-client'
 *
 * @Module({
 *   imports: [
 *     RestModule.forRootAsync({
 *       useFactory: () => ({
 *         axios: { baseURL: 'https://api.example.com' },
 *       }),
 *     }),
 *   ],
 *   exports: [RestModule],
 * })
 * export class CatalogModule {}
 * ```
 */
@Module({})
export class RestModule {
  /**
   * Builds a minimal {@link DynamicModule} that provides and exports a single
   * {@link RestClient} built from a pre-resolved `HttpService`. Unlike
   * {@link forRootAsync}, this method does **not** register an internal
   * `HttpModule` — it expects the caller to supply the `HttpService` instance
   * directly via the `useFactory` return value.
   *
   * Intended for modules that already manage their own `HttpService` lifecycle
   * (for example {@link AuthRestModule}). Both modules call this method so the
   * `new RestClient(httpService, resilience)` construction logic lives in
   * exactly one place.
   *
   * `imports` and `inject` from `options` are forwarded into the provider
   * factory so the caller's dependencies (e.g. `ConfigService`) are available
   * inside `useFactory`.
   *
   * @param options - Async factory descriptor with a `useFactory` that returns {@link RestFromHttpServiceOptions}.
   * @returns DynamicModule providing and exporting {@link RestClient}.
   *
   * @example
   * ```ts
   * import { HttpModule, HttpService } from '@nestjs/axios'
   * import { Module } from '@nestjs/common'
   * import { RestModule, ResilencePresets } from 'nestjs-http-client'
   *
   * @Module({
   *   imports: [
   *     HttpModule,
   *     RestModule.forHttpService({
   *       imports: [HttpModule],
   *       inject: [HttpService],
   *       useFactory: (httpService: HttpService) => ({
   *         httpService,
   *         resilience: ResilencePresets.RESTFULL,
   *       }),
   *     }),
   *   ],
   * })
   * export class CatalogModule {}
   * ```
   */
  static forHttpService(options: {
    useFactory: (
      ...args: unknown[]
    ) => Promise<RestFromHttpServiceOptions> | RestFromHttpServiceOptions
    inject?: unknown[]
    imports?: unknown[]
  }): DynamicModule {
    const inject = (options.inject ?? []) as Array<
      InjectionToken | OptionalFactoryDependency
    >
    const userImports = (options.imports ?? []) as NonNullable<
      DynamicModule['imports']
    >

    return {
      module: RestModule,
      imports: userImports,
      providers: [
        {
          provide: RestClient,
          useFactory: async (...args: unknown[]): Promise<RestClient> => {
            const { httpService, resilience } = await options.useFactory(...args)
            return new RestClient(httpService, resilience)
          },
          inject,
        },
      ],
      exports: [RestClient],
    }
  }

  /**
   * Builds a fully wired {@link DynamicModule} from a consumer-supplied async
   * factory. Mirrors the standard NestJS `forRootAsync` shape: the factory
   * receives whatever providers are listed in `inject` and returns (or
   * resolves to) a {@link RestModuleOptions} object.
   *
   * Internally registers `HttpModule.registerAsync(...)` against the same
   * options factory so the resulting `HttpService` carries the consumer's
   * axios configuration. This keeps the call site to a single factory rather
   * than forcing consumers to wire `HttpModule` and `RestClient` separately.
   *
   * The default-preset fallback lives inside the {@link RestClient} factory
   * (not at options-resolution time) so consumers explicitly passing
   * `resilience: undefined` and consumers omitting the field both
   * receive the documented CONSERVATIVE preset.
   *
   * @param options - Async factory descriptor. Matches the NestJS dynamic-module idiom.
   * @returns DynamicModule wiring REST_MODULE_OPTIONS, HttpModule, and RestClient.
   *
   * @example
   * ```ts
   * import { Module, Injectable } from '@nestjs/common'
   * import { ConfigModule, ConfigService } from '@nestjs/config'
   * import { RestModule, RestClient, ResilencePresets } from 'nestjs-http-client'
   *
   * @Module({
   *   imports: [
   *     RestModule.forRootAsync({
   *       imports: [ConfigModule],
   *       inject: [ConfigService],
   *       useFactory: (config: ConfigService) => ({
   *         axios: { baseURL: config.get('API_BASE_URL') },
   *         resilience: ResilencePresets.CONSERVATIVE,
   *       }),
   *     }),
   *   ],
   *   exports: [RestModule],
   * })
   * export class CatalogModule {}
   *
   * // Then inject RestClient anywhere in the module
   * @Injectable()
   * export class CatalogService {
   *   constructor(private readonly client: RestClient) {}
   *   async getProduct(id: string) {
   *     const response = await this.client.get<{ id: string; name: string }>(`/products/${id}`)
   *     return response.data
   *   }
   * }
   * ```
   */
  static forRootAsync(options: {
    useFactory: (
      ...args: unknown[]
    ) => Promise<RestModuleOptions> | RestModuleOptions
    inject?: unknown[]
    imports?: unknown[]
  }): DynamicModule {
    const inject = (options.inject ?? []) as Array<
      InjectionToken | OptionalFactoryDependency
    >
    const userImports = (options.imports ?? []) as NonNullable<
      DynamicModule['imports']
    >

    return {
      module: RestModule,
      imports: [
        // HttpModule.registerAsync is resolved against the consumer's own
        // factory so the axios instance is built from `opts.axios`.
        // The `?? {}` fallback keeps `HttpModule` happy when the consumer
        // omits `axios` entirely (axios.create({}) === axios defaults).
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
        // 1. Resolve the consumer's async options once — RestClient reads
        //    `resilience` from this token. Sharing the factory between
        //    REST_MODULE_OPTIONS and HttpModule.registerAsync would invoke the
        //    consumer's factory twice; we accept that cost for symmetry with
        //    AuthRestModule and because user factories are expected to be
        //    referentially transparent (NestJS docs require it).
        {
          provide: REST_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject,
        },
        // 2. RestClient: composed from the HttpService provided by the
        //    internally-registered HttpModule plus the consumer's resilience
        //    config. Default-preset fallback applied here so explicit-undefined
        //    and omitted both yield CONSERVATIVE.
        {
          provide: RestClient,
          useFactory: (
            httpService: HttpService,
            opts: RestModuleOptions,
          ): RestClient => new RestClient(httpService, opts.resilience),
          inject: [HttpService, REST_MODULE_OPTIONS],
        },
      ],
      exports: [RestClient],
    }
  }
}
