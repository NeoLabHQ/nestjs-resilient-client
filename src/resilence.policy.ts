import { ExponentialBackoff } from "cockatiel";
import type { CircuitBreakerConfig, ResilanceConfig, RetryConfig } from "./client/resilance.config";
import { isRetryableError, SAFE_HTTP_METHODS } from "./shouldRetry";

export enum ResilencePresets {
    CONSERVATIVE = 'conservative',
    RESTFULL = 'restfull',
    LOW_QUALITY = 'low-quality',
}

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

export const resiliencePolicyPresets: Record<ResilencePresets, ResilanceConfig<number, void, number>> = {
    [ResilencePresets.CONSERVATIVE]: {
        retry: safeMethodsRetry,
        circuitBreaker: defaultCircutBreaker,
        timeout: CONSERVATIVE_TIMEOUT_MS,
    },
    [ResilencePresets.RESTFULL]: {
        retry: {
            ...safeMethodsRetry,
            shouldRetry: error => isRetryableError(error, IDEMPOTENT_HTTP_METHODS),
        },
        circuitBreaker: defaultCircutBreaker,
        timeout: RESTFULL_TIMEOUT_MS,
    },
    [ResilencePresets.LOW_QUALITY]: {
        retry: safeMethodsRetry,
        circuitBreaker: defaultCircutBreaker,
        timeout: LOW_QUALITY_TIMEOUT_MS,
    },
};