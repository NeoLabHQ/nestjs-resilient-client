import { Wrap } from 'base-decorators'

/**
 * Local type alias for a function that derives a deduplication key from method arguments.
 *
 * Defined here (rather than imported from a shared `cache.decorator` module) because
 * `DeduplicateInflight` is the only consumer in the current codebase and the previously
 * referenced `./cache.decorator` module does not exist.
 */
type KeyBuilder<TArgs extends unknown[]> = (...args: TArgs) => string

/** Unique exclusion key for DeduplicateInflight decorators, preventing double-wrap detection conflicts with other Wrap-based decorators. */
const INFLIGHT_EXCLUSION_KEY: unique symbol = Symbol('inflight')

/**
 * Method decorator that coalesces concurrent in-flight requests for the same key.
 *
 * When two or more calls arrive with the same derived key before the first one
 * resolves, all subsequent callers receive the same promise (single method execution).
 * The inflight map entry is always cleaned up in a `finally` block on both
 * success and error, preventing memory leaks from orphaned entries.
 *
 * The decorated service must have an `inflightMap: Map<string, Promise<unknown>>`
 * property, typically injected via `@Inject(INFLIGHT_MAP)` from a module-level provider.
 *
 * @param keyBuilder - Function that derives a deduplication key from the method arguments
 * @returns A method decorator that wraps the target method with inflight deduplication
 *
 * @example
 * ```ts
 * @DeduplicateInflight((application) => buildCrifCacheKey('v2', application))
 * async fetchCreditHistory(application: ApplicationData): Promise<CreditBureauData> {
 *   // only one concurrent API call per key
 * }
 * ```
 */
function DeduplicateInflight<TArgs extends unknown[]>(keyBuilder: KeyBuilder<TArgs>): MethodDecorator {
  return Wrap<{ inflightMap: Map<string, Promise<unknown>> }, TArgs, Promise<unknown>>((method, context) => async (...args: TArgs): Promise<unknown> => {
    const key = keyBuilder(...args)

    // Capture this call's map synchronously, before any `await`. base-decorators
    // shares a single `context` across all instances of the decorated class and
    // reassigns `context.target` to the current `this` before every call, so
    // re-reading `context.target` after the `await` below can resolve to a
    // DIFFERENT instance (e.g. a second AuthProcessor authenticating concurrently)
    // — the cleanup would then delete from the wrong map and orphan this entry.
    const { inflightMap } = context.target

    const existing = inflightMap.get(key)
    if (existing) {
      return existing
    }

    const promise = method(...args)

    inflightMap.set(key, promise)

    try {
      return await promise
    }
    finally {
      inflightMap.delete(key)
    }
  }, INFLIGHT_EXCLUSION_KEY)
}

export { DeduplicateInflight }
