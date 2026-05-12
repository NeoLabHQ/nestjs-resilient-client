import type { AxiosRequestConfig } from "axios";
import type { RestClient } from "../client/rest.client";
import { DeduplicateInflight } from "../deduplicate-inflight.decorator";
import type { AuthStrategy } from "./auth.config";

/**
 * Constant deduplication key used by `@DeduplicateInflight` on
 * {@link AuthProcessor.performAuthenticate}. Returning the same string
 * regardless of arguments guarantees that any number of concurrent
 * `authenticateIfNeeded()` callers coalesce into a single underlying
 * `strategy.authenticate(client)` invocation (single-flight semantics).
 */
const AUTHENTICATE_DEDUP_KEY = "authenticate";

/**
 * Orchestrates the per-request authentication lifecycle for an
 * {@link AuthRestClient} by delegating every session-state query to the
 * injected {@link AuthStrategy} class instance. Holds **no** cached
 * `authResult`: the strategy itself owns its session state, while the
 * processor only enforces the cross-cutting concerns that cannot live on
 * an arbitrary user-supplied strategy.
 *
 * Responsibilities:
 * - **Pre-flight gating** via {@link authenticateIfNeeded}: short-circuits
 *   when {@link AuthStrategy.isAuthenticated} reports a still-valid session,
 *   otherwise triggers a fresh handshake.
 * - **Single-flight handshake** via the deduplicated
 *   {@link performAuthenticate}: any number of concurrent callers that pass
 *   the `isAuthenticated()` guard before either has run collapse into one
 *   underlying `strategy.authenticate(client)` call. The invariant is
 *   enforced by `@DeduplicateInflight(() => 'authenticate')`, which uses a
 *   constant key so deduplication is independent of method arguments.
 * - **Per-request credential injection** via {@link extendRequest}, which
 *   forwards to {@link AuthStrategy.extendRequest}.
 * - **Session invalidation** via {@link clearAuth}, which delegates to
 *   {@link AuthStrategy.invalidate} so the next pre-flight triggers a fresh
 *   handshake. Used by `AuthRestClient`'s 401 retry path.
 *
 * **No cached state contract:** the processor never stores an `authResult`
 * field. Every session query (`isAuthenticated`, `extendRequest`) routes
 * directly to the injected strategy, and `clearAuth` is a thin pass-through
 * to `strategy.invalidate()`. This keeps the lifecycle authoritative on the
 * strategy and removes a source of stale-state bugs.
 *
 * @example
 * ```ts
 * import { AuthProcessor } from 'nestjs-resilient-client'
 * import type { AuthStrategy, RestClient } from 'nestjs-resilient-client'
 *
 * // Strategy is a user-supplied class implementing AuthStrategy.
 * // The processor is constructed by AuthRestModule with both collaborators
 * // resolved from the DI container.
 * declare const strategy: AuthStrategy
 * declare const restClient: RestClient
 *
 * const processor = new AuthProcessor(strategy, restClient)
 *
 * // Single-flight: concurrent callers share one underlying handshake.
 * await Promise.all([
 *   processor.authenticateIfNeeded(),
 *   processor.authenticateIfNeeded(),
 *   processor.authenticateIfNeeded(),
 * ]) // -> exactly one strategy.authenticate(restClient) invocation
 *
 * const extended = processor.extendRequest({ url: '/orders' })
 * // -> { url: '/orders', headers: { Authorization: 'Bearer ...' } }
 *
 * await processor.clearAuth() // -> strategy.invalidate(); next call re-authenticates
 * ```
 */
export class AuthProcessor {
    /**
     * Public-readable inflight map required by `@DeduplicateInflight` —
     * the decorator reads `context.target.inflightMap` to coalesce
     * concurrent invocations of {@link performAuthenticate}. Must remain
     * public for the decorator's reflection-free access pattern.
     *
     * @example
     * ```ts
     * declare const processor: AuthProcessor
     *
     * // Diagnostics-only: peek at currently coalesced handshake promises.
     * // The map is keyed by AUTHENTICATE_DEDUP_KEY, so size is 0 or 1.
     * console.log('inflight handshakes:', processor.inflightMap.size)
     * ```
     */
    readonly inflightMap: Map<string, Promise<unknown>> = new Map();

    /**
     * Composes a user-supplied {@link AuthStrategy} with the resilient
     * {@link RestClient} so the strategy's handshake reuses the same
     * resilience policy stack as application requests. Typically invoked by
     * {@link AuthRestModule}; direct construction is reserved for tests or
     * advanced wiring.
     *
     * @param strategy - User-supplied authentication strategy instance,
     * resolved by the NestJS DI container. Owns the full session lifecycle
     * (handshake, expiry tracking, request augmentation, invalidation).
     * @param client - Resilient HTTP client passed to
     * `strategy.authenticate(client)`. Reuses the same resilience policy
     * stack as the consuming `AuthRestClient`, so auth requests are subject
     * to the same retry/circuit-breaker/timeout guarantees as application
     * requests.
     *
     * @example
     * ```ts
     * import { AuthProcessor, RestClient } from 'nestjs-resilient-client'
     * import type { AuthStrategy } from 'nestjs-resilient-client'
     *
     * declare const strategy: AuthStrategy
     * declare const restClient: RestClient
     *
     * const processor = new AuthProcessor(strategy, restClient)
     * await processor.authenticateIfNeeded()
     * ```
     */
    constructor(
        private readonly strategy: AuthStrategy,
        private readonly client: RestClient,
    ) {}

    /**
     * Resolves with whatever the injected strategy reports about its current
     * session validity. The processor caches nothing of its own — the
     * strategy is the single source of truth. Asynchronous because
     * {@link AuthStrategy.isAuthenticated} is asynchronous (implementations
     * may consult persisted credential stores or remote introspection
     * endpoints).
     *
     * @example
     * ```ts
     * const processor = new AuthProcessor(strategy, restClient)
     *
     * if (!(await processor.isAuthenticated())) {
     *   await processor.authenticateIfNeeded()
     * }
     * // -> resolves to true once a successful handshake has completed
     * ```
     */
    async isAuthenticated(): Promise<boolean> {
        return await this.strategy.isAuthenticated();
    }

    /**
     * Ensures a valid authentication session exists. Short-circuits when
     * {@link isAuthenticated} resolves with `true`; otherwise delegates to the
     * deduplicated {@link performAuthenticate} so concurrent callers share
     * a single underlying handshake.
     *
     * Race-safety note: even when two concurrent callers both observe
     * `await isAuthenticated() === false` and proceed to
     * `performAuthenticate()`, `@DeduplicateInflight` collapses them into one
     * `strategy.authenticate` invocation (single-flight invariant).
     *
     * @example
     * ```ts
     * const processor = new AuthProcessor(strategy, restClient)
     *
     * // Multiple concurrent callers coalesce into one handshake.
     * await Promise.all([
     *   processor.authenticateIfNeeded(),
     *   processor.authenticateIfNeeded(),
     *   processor.authenticateIfNeeded(),
     * ])
     * // strategy.authenticate(restClient) was invoked exactly once.
     * ```
     */
    async authenticateIfNeeded(): Promise<void> {
        if (await this.isAuthenticated()) {
            return;
        }

        await this.performAuthenticate();
    }

    /**
     * Returns a new {@link AxiosRequestConfig} with the strategy's
     * credentials applied. Pure delegation to
     * {@link AuthStrategy.extendRequest}; the strategy contract forbids
     * mutating the input config.
     *
     * @example
     * ```ts
     * const processor = new AuthProcessor(strategy, restClient)
     * await processor.authenticateIfNeeded()
     *
     * const authed = processor.extendRequest({ url: '/orders' })
     * // -> { url: '/orders', headers: { Authorization: 'Bearer eyJ...' } }
     * ```
     */
    extendRequest(config: AxiosRequestConfig): AxiosRequestConfig {
        return this.strategy.extendRequest(config);
    }

    /**
     * Invalidates the strategy's session by delegating to
     * {@link AuthStrategy.invalidate}. Resolves once the strategy has
     * finished dropping its session state; awaiting is required because
     * {@link AuthStrategy.invalidate} is asynchronous (implementations may
     * flush persisted credentials, hit a remote sign-out endpoint, etc.).
     * After the returned promise resolves, {@link isAuthenticated} resolves
     * with `false` and the next {@link authenticateIfNeeded} triggers a fresh
     * handshake. Used by `AuthRestClient`'s 401 retry path.
     *
     * @example
     * ```ts
     * const processor = new AuthProcessor(strategy, restClient)
     * await processor.authenticateIfNeeded()
     * // await processor.isAuthenticated() === true
     *
     * await processor.clearAuth()
     * // await processor.isAuthenticated() === false
     * // Next authenticateIfNeeded() call triggers a fresh handshake.
     * ```
     */
    async clearAuth(): Promise<void> {
        await this.strategy.invalidate();
    }

    /**
     * Private deduplicated authentication primitive. Delegates the actual
     * handshake to {@link AuthStrategy.authenticate}.
     *
     * Decorated with `@DeduplicateInflight(() => 'authenticate')` so any
     * number of concurrent invocations collapse into one underlying
     * `strategy.authenticate(client)` call. The key is the constant
     * {@link AUTHENTICATE_DEDUP_KEY} regardless of arguments, which is
     * essential for single-flight correctness.
     */
    @DeduplicateInflight(() => AUTHENTICATE_DEDUP_KEY)
    private async performAuthenticate(): Promise<void> {
        await this.strategy.authenticate(this.client);
    }
}
