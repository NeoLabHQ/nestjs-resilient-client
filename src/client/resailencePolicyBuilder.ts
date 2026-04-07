import type { RetryConfig, ResilanceConfig, CircuitBreakerConfig, BulkheadConfig, FallbackConfig } from "./resilance.config";
import { 
    type IPolicy, 
    type IDefaultPolicyContext, 
    retry, 
    handleWhen, 
    handleAll, 
    RetryPolicy, 
    IterableBackoff, 
    DelegateBackoff, 
    ExponentialBackoff, 
    ConstantBackoff, 
    circuitBreaker, 
    type IBackoffFactory, 
    type IRetryBackoffContext, 
    SamplingBreaker,
    ConsecutiveBreaker,
    CountBreaker,
    wrap, 
    NoopPolicy,
    bulkhead,
    fallback,
    CircuitBreakerPolicy,
    BulkheadPolicy,
    FallbackPolicy,
    type ICountBreakerOptions,
    type ISamplingBreakerOptions,
} from "cockatiel";

export const resiliencePolicyBuilder = <
    T, 
    S = void, 
    R = unknown, 
    A extends IPolicy<IDefaultPolicyContext, R> = IPolicy<IDefaultPolicyContext, R>
>(config: ResilanceConfig<T, S, R>): A => {
    const policies: Array<IPolicy<IDefaultPolicyContext, R> | undefined> = [
        config.retry && buildRetryPolicy(config.retry),
        config.circuitBreaker && buildCircuitBreakerPolicy(config.circuitBreaker),
        config.bulkhead && buildBulkheadPolicy(config.bulkhead),
        config.fallback && buildFallbackPolicy(config.fallback),
    ];

    const filteredPolicies = policies.filter(Boolean) as Array<IPolicy<IDefaultPolicyContext, R>>;
    
    if (filteredPolicies.length === 0) {
        return new NoopPolicy() as unknown as A;
    }

    return wrap(...filteredPolicies) as unknown as A;
}

const isBackoffFactory = (value: unknown): value is IBackoffFactory<IRetryBackoffContext<unknown>> =>
    typeof value === 'object' &&
    value !== null &&
    'next' in value &&
    typeof (value as { next: unknown }).next === 'function';

export const buildRetryPolicy = <T, S = void, R = unknown>(config: RetryConfig<T, S>): RetryPolicy => {
    const backoff: IBackoffFactory<IRetryBackoffContext<T>> = 
        typeof config.backoff === 'number' ? new ConstantBackoff(config.backoff)
        : config.backoff instanceof Array ? new IterableBackoff(config.backoff) 
        : isBackoffFactory(config.backoff) ? config.backoff  
        : new ExponentialBackoff(config.backoff)

    const policy = retry(
        config.shouldRetry ? handleWhen(config.shouldRetry) : handleAll, 
        { 
            maxAttempts: config.maxAttempts, 
            backoff
        }
    );

    if (config.onSuccess) {
        policy.onSuccess(config.onSuccess);
    }
    if (config.onFailure) {
        policy.onFailure(config.onFailure);
    }
    if (config.onRetry) {
        policy.onRetry(config.onRetry);
    }
    if (config.onGiveUp) {
        policy.onGiveUp(config.onGiveUp);
    }

    return policy;
}

const isCountBreakerOptions = (breaker: number | ICountBreakerOptions | ISamplingBreakerOptions): breaker is ICountBreakerOptions =>
    typeof breaker === 'object' && 'size' in breaker;

export const buildCircuitBreakerPolicy = (config: CircuitBreakerConfig): CircuitBreakerPolicy => {
    const breaker = 
        typeof config.breaker === 'number' 
            ? new ConsecutiveBreaker(config.breaker)
            : isCountBreakerOptions(config.breaker)
                ? new CountBreaker(config.breaker)
                : new SamplingBreaker(config.breaker);

    const policy = circuitBreaker(
        config.shouldBreak ? handleWhen(config.shouldBreak) : handleAll,
        {
            breaker,
            halfOpenAfter: config.halfOpenAfter,
            initialState: config.initialState,
        }
    );

    if (config.onBreak) {
        policy.onBreak(config.onBreak);
    }
    if (config.onReset) {
        policy.onReset(config.onReset);
    }
    if (config.onHalfOpen) {
        policy.onHalfOpen(config.onHalfOpen);
    }
    if (config.onStateChange) {
        policy.onStateChange(config.onStateChange);
    }
    if (config.onSuccess) {
        policy.onSuccess(config.onSuccess);
    }
    if (config.onFailure) {
        policy.onFailure(config.onFailure);
    }

    return policy;
}

export const buildBulkheadPolicy = (config: BulkheadConfig): BulkheadPolicy => {
    const policy = bulkhead(config.limit, config.queue);

    if (config.onSuccess) {
        policy.onSuccess(config.onSuccess);
    }
    if (config.onFailure) {
        policy.onFailure(config.onFailure);
    }
    if (config.onReject) {
        policy.onReject(config.onReject);
    }

    return policy;
}

export const buildFallbackPolicy = <R = unknown>(config: FallbackConfig<R>): FallbackPolicy<R> => {
    const valueOrFactory = typeof config.valueOrFactory === 'function'
        ? config.valueOrFactory as () => Promise<R> | R
        : () => config.valueOrFactory as R;

    const policy = fallback(
        config.shouldFallback ? handleWhen(config.shouldFallback) : handleAll,
        valueOrFactory
    );

    if (config.onSuccess) {
        policy.onSuccess(config.onSuccess);
    }
    if (config.onFailure) {
        policy.onFailure(config.onFailure);
    }

    return policy;
}