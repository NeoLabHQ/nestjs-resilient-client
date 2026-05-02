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
import type { HttpVerb, InvokeArgs } from "./base-http.service";

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
export interface RetryConfig<T> {
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
 * Configuration for the deduplication RxJS operator. When enabled, concurrent
 * subscribers that resolve to the same key share a single in-flight source
 * Observable subscription — i.e. ten concurrent identical `GET /users/42`
 * calls hit the network exactly once and every caller receives the same
 * response. The cache entry is removed after the source completes or errors,
 * so sequential calls always trigger a fresh network request.
 *
 * Default key derivation is `${verb}:${args.url ?? args.config.url ?? ''}`.
 * Provide `keyBuilder` to customise (e.g. include a query parameter or a
 * tenant header in the cache key).
 *
 * @example
 * ```ts
 * import type { DeduplicationConfig } from 'nestjs-http-client'
 *
 * // Use default key derivation
 * const defaultDedup: DeduplicationConfig = {}
 *
 * // Include a tenant header in the cache key so requests for different
 * // tenants do not collide
 * const tenantAwareDedup: DeduplicationConfig = {
 *   keyBuilder: (verb, args) => {
 *     const tenant = (args.config.headers as Record<string, string> | undefined)?.['X-Tenant'] ?? ''
 *     return `${tenant}:${verb}:${args.url ?? args.config.url ?? ''}`
 *   },
 * }
 * ```
 */
export interface DeduplicationConfig {
    /**
     * Derives the cache key for a verb invocation. When omitted, the default
     * key is `${verb}:${args.url ?? args.config.url ?? ''}`. Two requests
     * that resolve to the same key share a single in-flight subscription.
     */
    key?: (verb: HttpVerb, args: InvokeArgs) => string;
}

/**
 * Configuration for the rate-limiter RxJS operator. Bounds the long-run rate
 * at which requests are emitted to the underlying transport, smoothing
 * outbound traffic so the upstream service is not overwhelmed by bursts.
 *
 * Two strategies are supported:
 *
 * - `'token-bucket'` — maintains a counter of available tokens (initial =
 *   `capacity`). Each emission consumes one token; tokens refill at
 *   `refillRatePerSec` per second. Bursts up to `capacity` are allowed; once
 *   the bucket is empty, subsequent emissions wait for the next refill.
 * - `'leaky-bucket'` — emits at a fixed rate of `refillRatePerSec` per
 *   second regardless of arrival burst. Smooths traffic to a constant rate.
 *
 * @example
 * ```ts
 * import type { RateLimiterConfig } from 'nestjs-http-client'
 *
 * // Allow short bursts of up to 10 requests, then sustain 5 requests/sec
 * const tokenBucket: RateLimiterConfig = {
 *   strategy: 'token-bucket',
 *   capacity: 10,
 *   refillRatePerSec: 5,
 * }
 *
 * // Strict 2 requests/sec regardless of arrival pattern
 * const leakyBucket: RateLimiterConfig = {
 *   strategy: 'leaky-bucket',
 *   capacity: 1,
 *   refillRatePerSec: 2,
 * }
 * ```
 */
export interface RateLimiterConfig {
    /**
     * Algorithm used to schedule emissions. `'token-bucket'` allows bursts
     * up to `capacity`; `'leaky-bucket'` enforces a strictly constant rate.
     */
    strategy: "token-bucket" | "leaky-bucket";
    /**
     * Maximum burst size for `'token-bucket'` (initial token count). For
     * `'leaky-bucket'` this caps the in-flight queue depth before back-pressure.
     */
    capacity: number;
    /**
     * Sustained emission rate, in emissions per second. Tokens refill at this
     * rate for `'token-bucket'`; `'leaky-bucket'` emits at exactly this rate.
     */
    refillRatePerSec: number;
}

/**
 * Configuration for the throttling RxJS operator. Caps the number of
 * emissions that may pass through within a fixed sliding window. Excess
 * emissions wait until a slot in the next window becomes available.
 *
 * Throttling differs from rate-limiting in that it enforces a hard ceiling
 * over a fixed-duration window (e.g. "no more than 100 requests per minute"),
 * whereas rate-limiting smooths emission cadence over time.
 *
 * @example
 * ```ts
 * import type { ThrottlingConfig } from 'nestjs-http-client'
 *
 * // No more than 100 requests per minute
 * const throttling: ThrottlingConfig = {
 *   requestsPerInterval: 100,
 *   intervalMs: 60_000,
 * }
 * ```
 */
export interface ThrottlingConfig {
    /** Maximum number of emissions allowed within a single window. */
    requestsPerInterval: number;
    /** Length of the throttling window, in milliseconds. */
    intervalMs: number;
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
    retry?: RetryConfig<T>;
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
    /**
     * Shares one in-flight subscription across concurrent identical
     * requests. When set, callers that resolve to the same cache key (default
     * `${verb}:${url}`) hit the network exactly once and every caller
     * receives the same response. Cache entries are evicted on completion or
     * error of the source Observable, so sequential calls always trigger a
     * fresh request. Implemented as the outermost RxJS operator so cached
     * results bypass `rateLimiter` and `throttling` for subsequent callers.
     */
    deduplication?: DeduplicationConfig;
    /**
     * Smooths the outbound emission rate using either a token-bucket
     * (burstable) or leaky-bucket (constant rate) strategy. Applied after
     * {@link deduplication} and before {@link throttling} in the RxJS
     * pipeline so deduplicated calls do not consume rate-limit slots and
     * throttling sees the rate-limited stream.
     */
    rateLimiter?: RateLimiterConfig;
    /**
     * Caps the number of emissions allowed within a fixed sliding window
     * (e.g. "no more than N per minute"). Applied as the innermost RxJS
     * operator (after deduplication and rate-limiting), so throttling
     * enforces a hard ceiling on requests that have already passed the
     * earlier two stages.
     */
    throttling?: ThrottlingConfig;
}
