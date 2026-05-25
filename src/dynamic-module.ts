import type { DynamicModule, Type } from '@nestjs/common'
import type { Abstract, InjectionToken, OptionalFactoryDependency } from '@nestjs/common/interfaces'

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
 * Used to type the variadic parameters of the dynamic-module `registerAsync`
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
 * Normalises the consumer-facing `{ inject?, imports?, useFactory }` argument
 * accepted by every dynamic-module `registerAsync` / `fromHttpService` entry
 * point into the wider runtime shapes the internal NestJS DI wiring consumes.
 *
 * Two concerns are bundled here so each call site stays a single destructure
 * rather than re-pasting the same six lines of casts plus their justification
 * comments:
 *
 * 1. **Defaulting & widening for `inject` / `imports`.** The public surface
 *    keeps `inject` tuple-precise (so {@link ResolveInjectedDeps} can infer
 *    factory parameter types) and lets `imports` stay `unknown[]` so consumers
 *    don't need to import NestJS module-import-union types. The internal
 *    forwarding to NestJS DI still uses the wider runtime types — casting back
 *    at this boundary keeps the public type tuple-precise while letting the
 *    private wiring stay structurally identical to the pre-generic shape.
 * 2. **Widening for `useFactory`.** Internal call sites receive the
 *    DI-resolved values as `unknown[]` (NestJS hands the spread tuple in
 *    untyped at runtime). Casting the consumer's narrowly-typed factory to
 *    `(...args: unknown[]) => …` once here means each internal invocation
 *    site does not need its own per-position cast. This is a purely
 *    structural cast — the runtime arity / order is identical.
 *
 * Generic over both `TInject` (so the consumer-facing factory inference
 * survives) and `TOptions` (so the returned `useFactory`'s resolved return
 * type stays accurate for each module's distinct options shape —
 * `RestModuleOptions`, `RestFromHttpServiceOptions`, `AuthRestModuleOptions`).
 *
 * @template TInject - The `inject` tuple type carried by the consumer's
 *   options argument; passed straight through to {@link ResolveInjectedDeps}.
 * @template TOptions - The options shape the consumer's `useFactory` returns.
 *
 * @param options - The `{ inject?, imports?, useFactory }` argument the
 *   consumer passed to the dynamic-module entry point.
 * @returns The three widened values each `registerAsync` / `fromHttpService`
 *   implementation forwards into NestJS DI verbatim.
 */
export function resolveFactoryOptions<
  TInject extends readonly FactoryInjectToken[],
  TOptions,
>(options: {
  useFactory: (...args: ResolveInjectedDeps<TInject>) => Promise<TOptions> | TOptions
  inject?: TInject
  imports?: unknown[]
}): {
  inject: Array<InjectionToken | OptionalFactoryDependency>
  userImports: NonNullable<DynamicModule['imports']>
  useFactory: (...args: unknown[]) => Promise<TOptions> | TOptions
} {
  const inject = (options.inject ?? []) as Array<
    InjectionToken | OptionalFactoryDependency
  >
  const userImports = (options.imports ?? []) as NonNullable<
    DynamicModule['imports']
  >
  const useFactory = options.useFactory as (
    ...args: unknown[]
  ) => Promise<TOptions> | TOptions

  return { inject, userImports, useFactory }
}
