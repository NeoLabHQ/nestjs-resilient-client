import type {
    CircuitState,
    FailureReason,
    IBackoffFactory,
    ICountBreakerOptions,
    IExponentialBackoffOptions,
    IFailureEvent,
    IHalfOpenAfterBackoffContext,
    IRetryBackoffContext,
    ISamplingBreakerOptions,
    ISuccessEvent,
    TimeoutStrategy,
} from "cockatiel";

/**
 * Configuration for the retry policy. Controls how many attempts are made,
 * the delay strategy between attempts, and optional lifecycle callbacks.
 *
 * @example
 * ```ts
 * import { isAxiosError } from 'axios'
 * import { ExponentialBackoff } from 'cockatiel'
 * import type { RetryConfig } from 'nestjs-http-client'
 *
 * const retryConfig: RetryConfig<unknown> = {
 *   maxAttempts: 3,
 *   backoff: new ExponentialBackoff(),
 *   shouldRetry: (error) => !isAxiosError(error) || (error.response?.status ?? 0) >= 500,
 *   onRetry: ({ attempt, delay }) => console.log(`Retry attempt ${attempt} after ${delay}ms`),
 * }
 * ```
 */
export interface RetryConfig<T, S = void> {
    shouldRetry?: (error: Error) => boolean;
    maxAttempts: number;
    backoff:
    /** A backoff that backs off for a constant amount of time. */
    | number
    /** Takes in a list of delays, and goes through them one by one. 
     * When it reaches the end of the list, the backoff will continue to use the last value. 
     * */
    | Array<number>
    /** 
     * The crowd favorite. By default, it uses a decorrelated jitter algorithm, 
     * which is a good default for most applications. 
     * Takes in an options object, which can have any of these properties: */
    | Partial<IExponentialBackoffOptions<unknown>>
    /** A cockatiel backoff factory (for example `new DelegateBackoff()`). */
    | IBackoffFactory<IRetryBackoffContext<T>>;

    onSuccess?: (data: ISuccessEvent) => void;
    onFailure?: (data: IFailureEvent) => void;
    onRetry?: (data: FailureReason<unknown> & {
        delay: number;
        attempt: number;
    }) => void;
    onGiveUp?: (data: FailureReason<unknown>) => void;
}

/**
 * Circuit breakers stop execution for a period of time after a failure threshold has been reached.
 * This is very useful to allow faulting systems to recover without overloading them.
 *
 * @example
 * ```ts
 * import type { CircuitBreakerConfig } from 'nestjs-http-client'
 *
 * // Open after 5 consecutive failures; probe again after 30 s
 * const cbConfig: CircuitBreakerConfig = {
 *   breaker: 5,
 *   halfOpenAfter: 30_000,
 * }
 *
 * // Open when ≥ 50 % of requests over a 30 s sampling window fail
 * const samplingCbConfig: CircuitBreakerConfig = {
 *   breaker: { threshold: 0.5, duration: 30_000, minimumRps: 10 },
 *   halfOpenAfter: 60_000,
 * }
 * ```
 */
export interface CircuitBreakerConfig {
    shouldBreak?: (error: Error) => boolean;
    /**
     * When to (potentially) enter the {@link CircuitState.HalfOpen} state from
     * the {@link CircuitState.Open} state. Either a duration in milliseconds or a
     * backoff factory.
     */
    halfOpenAfter: number | IBackoffFactory<IHalfOpenAfterBackoffContext>;
    /**
     * Initial state from a previous call to {@link CircuitBreakerPolicy.toJSON}.
     */
    initialState?: unknown;
    breaker:
    /** The ConsecutiveBreaker breaks after n requests in a row fail. Simple, easy. */
    | number
    /** The CountBreaker breaks after a proportion of requests in a count based sliding window fail */
    | ICountBreakerOptions
    /** The SamplingBreaker breaks after a proportion of requests over a time period fail. */
    | ISamplingBreakerOptions;

    onBreak?: (data: FailureReason<unknown> | { isolated: true }) => void;
    onReset?: () => void;
    onHalfOpen?: () => void;
    onStateChange?: (state: CircuitState) => void;
    onSuccess?: (data: ISuccessEvent) => void;
    onFailure?: (data: IFailureEvent) => void;
}

/**
 * A Bulkhead is a simple structure that limits the number of concurrent calls.
 * Attempting to exceed the capacity will cause `execute()` to throw a `BulkheadRejectedError`.
 *
 * @example
 * ```ts
 * import type { BulkheadConfig } from 'nestjs-http-client'
 *
 * // Allow at most 10 concurrent requests; queue up to 20 more before rejecting
 * const bulkheadConfig: BulkheadConfig = {
 *   limit: 10,
 *   queue: 20,
 * }
 * ```
 */
export interface BulkheadConfig {
    /** The maximum number of concurrent calls allowed. */
    limit: number;
    /** 
     * You can optionally pass a second parameter to bulkhead(), 
     *  which will allow for events to be queued instead of rejected after capacity is exceeded. 
     * Once again, if this queue fills up, a BulkheadRejectedError will be thrown. 
     * */
    queue?: number;

    onSuccess?: (data: ISuccessEvent) => void;
    onFailure?: (data: IFailureEvent) => void;
    onReject?: () => void;
}

/**
 * Caps the wall-clock duration of a single attempt. When the timeout elapses,
 * cockatiel raises a `TaskCancelledError` (the `signal` it forwards on the
 * `request()` path is also aborted, so axios cancels the in-flight HTTP
 * call). The timeout is wrapped INSIDE retry in the resilience pipeline, so
 * each retry attempt receives its own independent deadline — a 60 s timeout
 * applies per attempt, allowing retry to recover from transient slowness.
 *
 * @example
 * ```ts
 * import { TimeoutStrategy } from 'cockatiel'
 * import type { TimeoutConfig } from 'nestjs-http-client'
 *
 * // 10 s per attempt with cooperative cancellation (axios honours the signal)
 * const timeoutConfig: TimeoutConfig = {
 *   duration: 10_000,
 *   strategy: TimeoutStrategy.Cooperative,
 * }
 * ```
 */
export interface TimeoutConfig {
    /** Maximum duration per attempt, in milliseconds. */
    duration: number;
    /**
     * Cooperative timeouts revoke the inner `AbortSignal` and let the wrapped
     * function observe cancellation; aggressive timeouts immediately reject
     * with `TaskCancelledError`. Defaults to {@link TimeoutStrategy.Cooperative}
     * — axios honours `signal`, so the cooperative path lets the in-flight
     * request short-circuit cleanly without leaving an orphaned promise.
     */
    strategy?: TimeoutStrategy;

    onSuccess?: (data: ISuccessEvent) => void;
    onFailure?: (data: IFailureEvent) => void;
    onTimeout?: () => void;
}

/**
 * Creates a policy that returns the `valueOrFactory` if an executed function fails.
 * `valueOrFactory` can be a static value or a factory function invoked on each
 * policy-handled failure to produce the degraded response.
 *
 * @example
 * ```ts
 * import type { FallbackConfig } from 'nestjs-http-client'
 *
 * // Return a static empty array when every retry attempt is exhausted
 * const fallbackConfig: FallbackConfig<string[]> = {
 *   valueOrFactory: [],
 * }
 *
 * // Produce a response dynamically using a factory function
 * const cache = new Map<string, string[]>([['items', ['a', 'b']]])
 * const dynamicFallback: FallbackConfig<string[]> = {
 *   valueOrFactory: () => cache.get('items') ?? [],
 * }
 * ```
 */
export interface FallbackConfig<R = unknown> {
    shouldFallback?: (error: Error) => boolean;
    valueOrFactory: (() => Promise<R> | R) | R;

    onSuccess?: (data: ISuccessEvent) => void;
    onFailure?: (data: IFailureEvent) => void;
}

/**
 * Composable resilience configuration. Each field is optional; an empty config
 * produces a `NoopPolicy`. Fields are composed in the order: retry → timeout →
 * circuitBreaker → bulkhead → fallback.
 *
 * @example
 * ```ts
 * import { ExponentialBackoff } from 'cockatiel'
 * import type { ResilanceConfig } from 'nestjs-http-client'
 *
 * // Retry-only configuration with exponential backoff
 * const retryOnly: ResilanceConfig<unknown> = {
 *   retry: {
 *     maxAttempts: 3,
 *     backoff: new ExponentialBackoff(),
 *   },
 * }
 *
 * // Full pipeline: retry + per-attempt timeout + sampling circuit breaker + bulkhead
 * const fullConfig: ResilanceConfig<unknown> = {
 *   retry: { maxAttempts: 3, backoff: [100, 500] },
 *   timeout: 10_000,
 *   circuitBreaker: {
 *     breaker: { threshold: 0.5, duration: 30_000, minimumRps: 10 },
 *     halfOpenAfter: 60_000,
 *   },
 *   bulkhead: { limit: 20, queue: 40 },
 * }
 * ```
 */
export interface ResilanceConfig<T, S = void, R = unknown> {
    /** Retry request multiple times if it fails. */
    retry?: RetryConfig<T, S>;
    /** 
     * Circuit breakers stop execution for a period of time after a failure threshold has been reached. 
     * This is very useful to allow faulting systems to recover without overloading them. 
     * */
    circuitBreaker?: CircuitBreakerConfig;
    /** 
     * A Bulkhead is a simple structure that limits the number of concurrent calls. 
     * Attempting to exceed the capacity will cause execute() to throw a BulkheadRejectedError.
     * */
    bulkhead?: BulkheadConfig;
    /**
     * Creates a policy that returns the valueOrFactory if an executed function fails.
     * As the name suggests, valueOrFactory either be a value,
     * or a function we'll call when a failure happens to create a value.
     * */
    fallback?: FallbackConfig<R>;
    /**
     * Caps the wall-clock duration of a single attempt. Accepts either a bare
     * duration in milliseconds (uses cooperative cancellation) or a full
     * {@link TimeoutConfig}. Wraps INSIDE retry so each attempt is bounded
     * independently — retries can recover from individual slow attempts.
     */
    timeout?: number | TimeoutConfig;
}
