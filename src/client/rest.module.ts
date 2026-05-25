import { HttpModule, HttpService } from '@nestjs/axios'
import type { HttpModuleOptions } from '@nestjs/axios'
import { type DynamicModule, Module, type Type } from '@nestjs/common'
import type { Abstract, InjectionToken, OptionalFactoryDependency } from '@nestjs/common/interfaces'
import axios from 'axios'

import { ResiliencePresets } from '../resilience.policy'
import type { HooksConfig } from './hookable-http.service'
import type { ResilanceConfig } from './resilance.config'
import { RestClient } from './rest.client'

/**
 * Union of every shape NestJS DI accepts as an element of a factory provider's
 * `inject` array. Mirrors the runtime type that `@nestjs/common`'s
 * `FactoryProvider.inject` carries, but kept as a local alias so the helper
 * types below can be expressed without re-importing the union at every call
 * site.
 *
 * See {@link InjectionToken} and {@link OptionalFactoryDependency} for the
 * upstream definitions.
 */
export type FactoryInjectToken = InjectionToken | OptionalFactoryDependency

/**
 * Resolves a single {@link FactoryInjectToken} element to the type the NestJS
 * DI container will hand to the factory at that position.
 *
 * Resolution rules (matching the runtime behaviour of NestJS DI):
 *
 * - `Type<U>` (class constructor) → `U` — the resolved class instance.
 * - `Abstract<U>` (abstract class) → `U` — the resolved abstract-class subtype.
 * - `{ token: InjectionToken<U>; optional: boolean }` → `U | undefined` — an
 *   optional dependency may legitimately resolve to `undefined`.
 * - Anything else (bare `string` / `symbol` / `Function` injection tokens) →
 *   `unknown`. These erase to `unknown` rather than `any` so consumers cannot
 *   accidentally smuggle untyped values through the factory boundary; if
 *   precise typing is required, callers can supply a manual parameter
 *   annotation on `useFactory` to widen / narrow as needed.
 *
 * @template T - A single element of an `inject` tuple.
 */
export type ResolveInjectedDep<T>
  = T extends Type<infer U>
    ? U
    : T extends Abstract<infer U>
      ? U
      : T extends { token: InjectionToken<infer U>, optional: boolean }
        ? U | undefined
        : unknown

/**
 * Maps an `inject` tuple to the parameter tuple the NestJS DI container will
 * spread into the factory function. Preserves element order — position 0 in
 * the `inject` array maps to parameter 0 in `useFactory`, and so on.
 *
 * Used to type the variadic parameters of {@link RestModule.registerAsync}'s
 * (and friends') `useFactory` so consumers writing
 * `inject: [ConfigService], useFactory: (config) => ...` get `config` typed
 * as `ConfigService` without a manual annotation.
 *
 * @template TInject - The `inject` tuple type (typically inferred via the
 *   `const` modifier on the surrounding generic so the elements are kept as
 *   exact class references rather than widened to `Type<unknown>`).
 */
export type ResolveInjectedDeps<TInject extends readonly FactoryInjectToken[]> = {
  [K in keyof TInject]: ResolveInjectedDep<TInject[K]>
}

/**
 * Minimal options for {@link RestModule.fromHttpService} — the caller supplies a
 * pre-resolved `HttpService` so the sub-module does not need to spin up its own
 * `HttpModule`. Used by {@link AuthRestModule} to delegate `RestClient` construction
 * to `RestModule`, eliminating the duplicated `new RestClient(httpService, config)`
 * call that would otherwise exist in both modules.
 *
 * @example
 * ```ts
 * import { HttpModule, HttpService } from '@nestjs/axios'
 * import { Module } from '@nestjs/common'
 * import { RestModule, ResiliencePresets } from 'nestjs-resilient-client'
 *
 * @Module({
 *   imports: [
 *     HttpModule,
 *     RestModule.forHttpService({
 *       imports: [HttpModule],
 *       inject: [HttpService],
 *       useFactory: (httpService: HttpService) => ({
 *         httpService,
 *         resilience: ResiliencePresets.RESTFULL,
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
  /**
   * Optional {@link HooksConfig} lifecycle forwarded verbatim to the
   * constructed {@link RestClient}. Hooks (`onInvoke` / `onReturn` / `onError`)
   * run INSIDE the resilience pipeline so retries observe hook-transformed
   * args (AC-13, AC-21).
   */
  hooks?: HooksConfig
}

/**
 * Options object resolved by the consumer-supplied async factory passed to
 * {@link RestModule.registerAsync}. Carries the two collaborating concerns the
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
 * import { RestModule, ResiliencePresets } from 'nestjs-resilient-client'
 * import type { RestModuleOptions } from 'nestjs-resilient-client'
 *
 * RestModule.forRootAsync({
 *   imports: [ConfigModule],
 *   inject: [ConfigService],
 *   useFactory: (config: ConfigService): RestModuleOptions => ({
 *     axios: {
 *       baseURL: config.get('API_BASE_URL'),
 *       timeout: 5_000,
 *     },
 *     resilience: ResiliencePresets.RESTFULL,
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
  /**
   * Optional {@link HooksConfig} lifecycle forwarded verbatim to the
   * constructed {@link RestClient}. Hooks (`onInvoke` / `onReturn` / `onError`)
   * run INSIDE the resilience pipeline so retries observe hook-transformed
   * args (AC-13, AC-21).
   */
  hooks?: HooksConfig
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
 * import { REST_MODULE_OPTIONS, type RestModuleOptions } from 'nestjs-resilient-client'
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
 * Reconciles axios-level and resilience-level timeout configuration so the two
 * channels never silently shadow each other. The truth table this helper
 * implements:
 *
 * | `axios.timeout` | `opts.resilience` | Returned `resilience`                                  |
 * | --------------- | ----------------- | ------------------------------------------------------ |
 * | `undefined`     | any               | `opts.resilience` unchanged (caller had no opinion)    |
 * | `0`             | any               | `opts.resilience` unchanged (axios `0` means disabled) |
 * | `> 0`           | `undefined`       | `{ ...CONSERVATIVE, timeout: undefined }` (preset's    |
 * |                 |                   | per-attempt timeout stripped so axios wins)            |
 * | `> 0`           | defined           | `opts.resilience` unchanged (user override preserved)  |
 *
 * The "axios wins" case strips the CONSERVATIVE preset's per-attempt timeout
 * from the merged config so the cockatiel pipeline does not also enforce a
 * deadline — otherwise an axios `timeout: 5000` would be silently overridden
 * by the preset's `60_000`. When the consumer supplies their own `resilience`,
 * we honour it as-is: the user has explicitly chosen the resilience timeout
 * (or its absence) and the helper does not second-guess that decision.
 *
 * Returns `undefined` for the "no opinion" cases so the call site can fall
 * back to {@link RestClient}'s built-in CONSERVATIVE default via `?? CONSERVATIVE`
 * — keeping the documented zero-config behaviour intact.
 *
 * @param opts - The resolved {@link RestModuleOptions} from the consumer factory.
 * @returns The resilience config to hand to {@link RestClient}, or `undefined`
 *   to defer to {@link RestClient}'s constructor default.
 *
 * @example
 * ```ts
 * // axios.timeout drives the deadline; preset timeout stripped.
 * resolveResilience({ axios: { timeout: 5_000 } })
 * // -> { retry: ..., circuitBreaker: ..., timeout: undefined }
 *
 * // User resilience wins regardless of axios.timeout.
 * resolveResilience({ axios: { timeout: 5_000 }, resilience: { timeout: 1_000 } })
 * // -> { timeout: 1_000 }
 *
 * // axios.timeout=0 means "disabled", not "I want axios to win".
 * resolveResilience({ axios: { timeout: 0 } })
 * // -> undefined (caller falls back to CONSERVATIVE)
 * ```
 */
export function resolveResilience(
  opts: RestModuleOptions,
): ResilanceConfig<unknown> | undefined {
  const axiosTimeout = opts.axios?.timeout

  // No axios timeout opinion: caller's resilience (defined or not) is final.
  if (axiosTimeout === undefined) {
    return opts.resilience
  }

  // axios `timeout: 0` is the documented "disabled" sentinel — it does NOT
  // express a preference for axios-driven cancellation, so we do not strip
  // the preset timeout. The caller's resilience (defined or not) is final.
  if (axiosTimeout === 0) {
    return opts.resilience
  }

  // axios.timeout > 0 with no user resilience: strip the CONSERVATIVE preset's
  // per-attempt timeout so axios's deadline is the only one in effect.
  // Object spread with `timeout: undefined` is sufficient because
  // `resiliencePolicyBuilder` checks `config.timeout !== undefined` before
  // attaching a `TimeoutPolicy`.
  if (opts.resilience === undefined) {
    return { ...ResiliencePresets.CONSERVATIVE, timeout: undefined }
  }

  // axios.timeout > 0 with user resilience: user opinion is preserved.
  return opts.resilience
}

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
 * import { RestModule } from 'nestjs-resilient-client'
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
@Module({
  // Zero-config wiring: `imports: [RestModule]` (no factory call) yields a
  // usable `RestClient` with the documented CONSERVATIVE-preset defaults
  // (AC-15). `HttpModule` is intentionally NOT listed as an `imports` entry
  // here — doing so would clash with the consumer-supplied
  // `HttpModule.registerAsync(...)` that `forRootAsync` registers (NestJS
  // deduplicates modules by class identity, so the bare static import would
  // silently shadow the dynamic axios configuration). Instead, `HttpService`
  // is provided directly via a factory that builds it from a default
  // `axios.create({})` instance — same shape as `HttpModule.register({})`
  // would produce, but scoped to `RestModule` itself so the dynamic-module
  // path is free to register its own `HttpService` without interference.
  providers: [
    {
      provide: HttpService,
      // axios.create({}) returns an instance carrying the global axios
      // defaults (no `baseURL`, no `timeout`); equivalent to what
      // `HttpModule` would yield if imported as a bare class. Consumers that
      // need a configured axios instance must use `RestModule.forRootAsync`
      // (which registers `HttpModule.registerAsync(...)` and overrides this
      // provider via the same `HttpService` token).
      useFactory: (): HttpService => new HttpService(axios.create({})),
    },
    {
      provide: RestClient,
      // Constructor-only path: omits both `config` and `hooks` so the client
      // falls back to the CONSERVATIVE preset (per RestClient.constructor).
      // Consumers that need a different preset, hooks, or axios configuration
      // should call `RestModule.forRootAsync(...)` instead.
      useFactory: (httpService: HttpService): RestClient => new RestClient(httpService),
      inject: [HttpService],
    },
  ],
  exports: [RestClient],
})
export class RestModule {
  /**
   * Builds a minimal {@link DynamicModule} that provides and exports a single
   * {@link RestClient} built from a pre-resolved `HttpService`. Unlike
   * {@link registerAsync}, this method does **not** register an internal
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
   * import { RestModule, ResiliencePresets } from 'nestjs-resilient-client'
   *
   * @Module({
   *   imports: [
   *     HttpModule,
   *     RestModule.forHttpService({
   *       imports: [HttpModule],
   *       inject: [HttpService],
   *       useFactory: (httpService: HttpService) => ({
   *         httpService,
   *         resilience: ResiliencePresets.RESTFULL,
   *       }),
   *     }),
   *   ],
   * })
   * export class CatalogModule {}
   * ```
   */
  static fromHttpService<
    const TInject extends readonly FactoryInjectToken[] = readonly [],
  >(options: {
    useFactory: (
      ...args: ResolveInjectedDeps<TInject>
    ) => Promise<RestFromHttpServiceOptions> | RestFromHttpServiceOptions
    inject?: TInject
    imports?: unknown[]
  }): DynamicModule {
    // Internal forwarding to NestJS DI still uses the wider runtime type —
    // the generic only narrows the consumer-facing surface. Casting back at
    // the boundary keeps the public type tuple-precise while letting the
    // private wiring stay structurally identical to the pre-generic shape.
    const inject = (options.inject ?? []) as Array<
      InjectionToken | OptionalFactoryDependency
    >
    const userImports = (options.imports ?? []) as NonNullable<
      DynamicModule['imports']
    >

    // Cast through the wider runtime signature so the internal call sites,
    // which receive the DI-resolved values as `unknown[]`, can invoke the
    // consumer's narrowly-typed factory without each call site needing its
    // own per-position cast. This is a purely structural cast — the runtime
    // arity / order is identical.
    const useFactory = options.useFactory as (
      ...args: unknown[]
    ) => Promise<RestFromHttpServiceOptions> | RestFromHttpServiceOptions

    return {
      module: RestModule,
      imports: userImports,
      providers: [
        {
          provide: RestClient,
          useFactory: async (...args: unknown[]): Promise<RestClient> => {
            const { httpService, resilience, hooks } = await useFactory(...args)
            // `fromHttpService` receives an explicit `httpService` and trusts
            // the caller's resilience verbatim (no `resolveResilience` here —
            // there is no `axios.timeout` to reconcile against, since axios
            // configuration is the caller's concern in this delegation path).
            return new RestClient(httpService, resilience, hooks)
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
   * import { RestModule, RestClient, ResiliencePresets } from 'nestjs-resilient-client'
   *
   * @Module({
   *   imports: [
   *     RestModule.registerAsync({
   *       imports: [ConfigModule],
   *       inject: [ConfigService],
   *       useFactory: (config: ConfigService) => ({
   *         axios: { baseURL: config.get('API_BASE_URL') },
   *         resilience: ResiliencePresets.CONSERVATIVE,
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
  static registerAsync<
    const TInject extends readonly FactoryInjectToken[] = readonly [],
  >(options: {
    useFactory: (
      ...args: ResolveInjectedDeps<TInject>
    ) => Promise<RestModuleOptions> | RestModuleOptions
    inject?: TInject
    imports?: unknown[]
  }): DynamicModule {
    // Internal forwarding to NestJS DI still uses the wider runtime type —
    // the generic only narrows the consumer-facing surface. Casting back at
    // the boundary keeps the public type tuple-precise while letting the
    // private wiring stay structurally identical to the pre-generic shape.
    const inject = (options.inject ?? []) as Array<
      InjectionToken | OptionalFactoryDependency
    >
    const userImports = (options.imports ?? []) as NonNullable<
      DynamicModule['imports']
    >
    // Cast through the wider runtime signature so the internal call sites,
    // which receive the DI-resolved values as `unknown[]`, can invoke the
    // consumer's narrowly-typed factory without each call site needing its
    // own per-position cast. Runtime arity / order is identical.
    const useFactory = options.useFactory as (
      ...args: unknown[]
    ) => Promise<RestModuleOptions> | RestModuleOptions

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
            const opts = await useFactory(...args)
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
          useFactory,
          inject,
        },
        // 2. HttpService re-binding. CRITICAL: the class-level `@Module({...})`
        //    on `RestModule` registers a default `HttpService` (`axios.create({})`,
        //    no consumer config) so the zero-config `imports: [RestModule]` path
        //    (AC-15) yields a usable client and so {@link RestModule.forHttpService}
        //    can resolve `HttpService` inside `RestModule`'s scope. NestJS DI
        //    resolves provider tokens from the LOCAL providers list before
        //    consulting imported modules, so without this re-binding the
        //    static-decorator default would silently shadow the configured
        //    `HttpService` exported by `HttpModule.registerAsync(...)` in the
        //    `imports` block above — and the consumer-supplied axios
        //    configuration (`baseURL`, `timeout`, default headers, …) would
        //    never reach the resolved `RestClient` (verified via debugging:
        //    `restClient.axiosRef.defaults.baseURL` was `undefined` despite
        //    `useFactory: () => ({ axios: { baseURL: ... } })` returning a
        //    populated config).
        //
        //    The re-bind reconstructs a fresh `HttpService` from the
        //    consumer-supplied axios config (read out of `REST_MODULE_OPTIONS`)
        //    using the same `axios.create(config)` call `HttpModule.registerAsync`
        //    performs internally. Side-by-side with the imported `HttpModule`,
        //    this means the underlying axios instance is built twice for the
        //    same config — a small price for keeping the static decorator's
        //    zero-config providers list independent of `forRootAsync`'s
        //    dynamic registration.
        {
          provide: HttpService,
          useFactory: (opts: RestModuleOptions): HttpService =>
            new HttpService(axios.create(opts.axios ?? {})),
          inject: [REST_MODULE_OPTIONS],
        },
        // 3. RestClient: composed from the re-bound `HttpService` (which now
        //    carries the consumer's axios configuration) plus the consumer's
        //    resilience config (run through `resolveResilience` to reconcile
        //    the axios-vs-resilience timeout precedence — see helper docstring).
        //    Default-preset fallback applied here so explicit-undefined
        //    and omitted both yield CONSERVATIVE.
        //    `opts.hooks` is forwarded as the third positional arg so the
        //    HookableHttpService lifecycle is wired through DI (AC-13).
        {
          provide: RestClient,
          useFactory: (
            httpService: HttpService,
            opts: RestModuleOptions,
          ): RestClient => new RestClient(
            httpService,
            resolveResilience(opts) ?? ResiliencePresets.CONSERVATIVE,
            opts.hooks,
          ),
          inject: [HttpService, REST_MODULE_OPTIONS],
        },
      ],
      exports: [RestClient],
    }
  }
}
