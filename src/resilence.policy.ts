import { ExponentialBackoff } from "cockatiel";
import type { CircuitBreakerConfig, ResilanceConfig, RetryConfig } from "./client/resilance.config";
import { isRetryableError, SAFE_HTTP_METHODS } from "./shouldRetry";

export enum ResilencePresets {
    CONSERVATIVE = 'conservative',
    RESTFULL = 'restfull',
    LOW_QUALITY = 'low-quality',
}

const IDEMPOTENT_HTTP_METHODS = SAFE_HTTP_METHODS.concat(['put', 'delete']);

export const safeMethodsRetry: RetryConfig<unknown> = {
    maxAttempts: 3,
    backoff: new ExponentialBackoff(),
    shouldRetry: error => isRetryableError(error, SAFE_HTTP_METHODS),
}

export const defaultCircutBreaker: CircuitBreakerConfig = {
    halfOpenAfter: 60 * 1000,
    breaker: { 
        threshold: 1, 
        duration: 60 * 1000, 
        minimumRps: 100 
    },
}

export const resiliencePolicyPresets: Record<ResilencePresets, ResilanceConfig<number, void, number>> = {
    [ResilencePresets.CONSERVATIVE]: {
        retry: safeMethodsRetry,
        circuitBreaker: defaultCircutBreaker,
    },
    [ResilencePresets.RESTFULL]: {
        retry: {
            ...safeMethodsRetry,
            shouldRetry: error => isRetryableError(error, IDEMPOTENT_HTTP_METHODS),
        },
        circuitBreaker: defaultCircutBreaker
    },
    [ResilencePresets.LOW_QUALITY]: {
        retry: safeMethodsRetry,
        circuitBreaker: defaultCircutBreaker
    },
};