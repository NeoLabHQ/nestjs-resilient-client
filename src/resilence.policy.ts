import { ExponentialBackoff } from "cockatiel";
import type { CircuitBreakerConfig, ResilanceConfig, RetryConfig } from "./client/resilance.config";
import { isRetryableError, SAFE_HTTP_METHODS } from "./shouldRetry";

// Method names MUST be uppercased to match `isMethodInList`, which uppercases
// the request's `error.config.method` before lookup. Mixing case here silently
// disables retries for the extended verbs and breaks the RESTFULL preset.
const IDEMPOTENT_HTTP_METHODS = SAFE_HTTP_METHODS.concat(['PUT', 'DELETE']);

export const safeMethodsRetry: RetryConfig<unknown> = {
    maxAttempts: 3,
    backoff: new ExponentialBackoff(),
    shouldRetry: error => isRetryableError(error, SAFE_HTTP_METHODS),
}

// cockatiel's `SamplingBreaker` validates `threshold` strictly within `(0, 1)`
// — i.e. `0 < threshold < 1`. The previous value `1` triggered a `RangeError`
// at construction time, so any consumer building this preset (including
// `RestClient`'s default config path) crashed before serving a single request.
// `0.99` keeps the original "trip on near-total failure" intent while
// satisfying the breaker's contract.
export const defaultCircutBreaker: CircuitBreakerConfig = {
    halfOpenAfter: 60 * 1000,
    breaker: {
        threshold: 0.99,
        duration: 60 * 1000,
        minimumRps: 100
    },
}

// Timeout budget is set at policy level, rather at axios level. As a result, axios timeout can override the policy timeout,  but cannot exceed it.
export const CONSERVATIVE_TIMEOUT_MS = 60_000;
export const RESTFULL_TIMEOUT_MS = 10_000;
export const LOW_QUALITY_TIMEOUT_MS = 180_000;

/**
 * Ready-made resilience presets exposed as a `const` object whose values are
 * the {@link ResilanceConfig} payloads themselves. This shape lets consumers
 * pass a preset directly to {@link RestClient}'s constructor or to
 * `RestModule.forRootAsync` without an extra lookup step:
 *
 * ```ts
 * new RestClient(http, ResilencePresets.RESTFULL)
 * ```
 *
 * The `as const` annotation preserves the literal types of the inner config
 * objects so the {@link ResilencePresets} type alias produces a narrowed
 * `ResilanceConfig<...>` union (rather than the widened `ResilanceConfig`
 * surface that a plain `Record` lookup would return).
 *
 * Consumers building configuration tables keyed by preset *name* can read
 * `Object.keys(ResilencePresets)` — the keys are stable identifiers documented
 * in the README's "Configuration Strategies" section.
 */
export const ResilencePresets = {
    CONSERVATIVE: {
        retry: safeMethodsRetry,
        circuitBreaker: defaultCircutBreaker,
        timeout: CONSERVATIVE_TIMEOUT_MS,
    },
    RESTFULL: {
        retry: {
            ...safeMethodsRetry,
            shouldRetry: error => isRetryableError(error, IDEMPOTENT_HTTP_METHODS),
        },
        circuitBreaker: defaultCircutBreaker,
        timeout: RESTFULL_TIMEOUT_MS,
    },
    LOW_QUALITY: {
        retry: safeMethodsRetry,
        circuitBreaker: defaultCircutBreaker,
        timeout: LOW_QUALITY_TIMEOUT_MS,
    },
} as const satisfies Record<string, ResilanceConfig<number, void, number>>;

/**
 * Type alias for the union of all preset {@link ResilanceConfig} payload
 * shapes. Use this when a consumer-facing API needs to accept "any preset
 * value" without coupling to one specific preset.
 *
 * The TypeScript pattern of declaring a `const` value and a `type` alias under
 * the same identifier is intentional — it preserves the original ergonomics
 * (`function foo(p: ResilencePresets)` and `ResilencePresets.CONSERVATIVE`)
 * while letting the runtime value be the configuration table itself.
 */
export type ResilencePresets =
    typeof ResilencePresets[keyof typeof ResilencePresets];

/**
 * Backward-compatible alias of {@link ResilencePresets}. Older consumer code
 * may still reference `resiliencePolicyPresets.CONSERVATIVE` — the alias keeps
 * those call sites working without the `[ResilencePresets.X]` lookup, since
 * the new `ResilencePresets` object IS the lookup table.
 *
 * New code should prefer {@link ResilencePresets} directly.
 *
 * @deprecated Use {@link ResilencePresets} directly — the const object's
 *   values are the {@link ResilanceConfig} payloads, so the old
 *   `resiliencePolicyPresets[ResilencePresets.CONSERVATIVE]` indirection is no
 *   longer required.
 */
export const resiliencePolicyPresets = ResilencePresets;
