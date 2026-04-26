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
} from "cockatiel";

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
 * */
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
 * Attempting to exceed the capacity will cause execute() to throw a BulkheadRejectedError.
 * */
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
 * Creates a policy that returns the valueOrFactory if an executed function fails. 
 * As the name suggests, valueOrFactory either be a value, 
 * or a function we'll call when a failure happens to create a value. 
 * */
export interface FallbackConfig<R = unknown> {
    shouldFallback?: (error: Error) => boolean;
    valueOrFactory: (() => Promise<R> | R) | R;

    onSuccess?: (data: ISuccessEvent) => void;
    onFailure?: (data: IFailureEvent) => void;
}

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
}
