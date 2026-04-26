import { Wrap } from 'base-decorators'
import { KeyBuilder } from './cache.decorator'

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

    const existing = context.target.inflightMap.get(key)
    if (existing) {
      return existing
    }

    const promise = method(...args)

    context.target.inflightMap.set(key, promise)

    try {
      return await promise
    }
    finally {
      context.target.inflightMap.delete(key)
    }
  }, INFLIGHT_EXCLUSION_KEY)
}

export { DeduplicateInflight }
