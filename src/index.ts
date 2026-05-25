// Barrel re-exports.
//
// Each source module is re-exported wholesale via `export *` (for modules that
// carry runtime values, optionally alongside types) or `export type *` (for
// modules that only declare types). Star re-exports keep the barrel in sync
// with each module's surface automatically — new exports in a source file
// flow through without an extra named-export edit here.
//
// Three modules carry internal helpers that MUST NOT join the public API. For
// those, the star re-export is replaced by an explicit named carve-out that
// re-exports only the documented public symbols. Each carve-out is annotated
// with the helper it intentionally omits so future maintainers can audit the
// public surface at a glance.

// Runtime + type — verb surface and hook lifecycle infrastructure.
export * from './client/base-http.service'
export * from './client/hookable-http.service'
export * from './client/rest.client'
export * from './auth/auth-rest.client'
export * from './auth/auth-processor'

// Type-only — no runtime values declared in these modules.
export type * from './auth/auth.config'
export type * from './client/resilance.config'

// Runtime + type — resilience presets and retry-eligibility predicates.
export * from './resilience.policy'
export * from './shouldRetry'

// Named carve-out: `./client/rest.module` also exports `resolveResilience`,
// which is internal plumbing used by `RestModule` / `AuthRestModule` to
// reconcile the axios vs resilience timeout channels. Keeping it out of the
// public surface preserves the previously documented API; re-export only the
// symbols that were already public.
export {
  REST_MODULE_OPTIONS,
  RestModule,
} from './client/rest.module'
export type {
  RestFromHttpServiceOptions,
  RestModuleOptions,
} from './client/rest.module'

// Named carve-out: `./auth/auth-rest.module` also exports `AUTH_MODULE_OPTIONS`,
// a DI token symbol that the prior barrel did NOT re-export. Although its
// JSDoc documents it as an "advanced consumer" symbol (mirroring the already-
// public `REST_MODULE_OPTIONS` from `RestModule`), this refactor's contract
// forbids silently widening the public surface — so the named carve-out
// preserves the exact set of symbols the prior `index.ts` exposed. Promoting
// `AUTH_MODULE_OPTIONS` is a separate, intentional decision that should land
// on its own commit if/when desired.
export { AuthRestModule } from './auth/auth-rest.module'
export type { AuthRestModuleOptions } from './auth/auth-rest.module'

// Named carve-out: `./dynamic-module` also exports `resolveFactoryOptions`,
// an internal helper used by the `registerAsync` / `fromHttpService` factories
// to normalise their `{ inject?, imports?, useFactory }` argument. The helper
// is plumbing, not a stable API; re-export only the public type aliases.
export type {
  FactoryInjectToken,
  ResolveInjectedDep,
  ResolveInjectedDeps,
} from './dynamic-module'
