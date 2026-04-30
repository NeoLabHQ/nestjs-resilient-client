import type { AxiosRequestConfig } from "axios";
import { DeduplicateInflight } from "../deduplicate-inflight.decorator";
import type { AuthConfig, AuthStrategy } from "./auth.config";

/**
 * Constant deduplication key used by `@DeduplicateInflight` on
 * {@link AuthStrategyService.performAuthenticate}. Returning the same string
 * regardless of arguments guarantees that any number of concurrent
 * `authenticateIfNeeded()` callers coalesce into a single underlying
 * `authConfig.authenticate(client)` invocation (single-flight semantics).
 */
const AUTHENTICATE_DEDUP_KEY = "authenticate";

/**
 * Service that owns the authentication lifecycle for an {@link AuthRestClient}.
 *
 * Responsibilities:
 * - Caches the active {@link AuthStrategy} returned by {@link AuthConfig.authenticate}.
 * - Exposes lazy auth via {@link authenticateIfNeeded} (only re-auths when the
 *   cached strategy is missing or reports `isAuthenticated() === false`).
 * - Coalesces concurrent authentication attempts via `@DeduplicateInflight`
 *   on the private {@link performAuthenticate} method.
 * - Delegates per-request credential injection to the cached strategy via
 *   {@link extendRequest}.
 * - Allows external callers (e.g. the `AuthRestClient` 401-recovery path)
 *   to invalidate the cached strategy via {@link clearAuth}.
 *
 * **`extendRequest` semantics when no auth handle exists:** Returns the input
 * config untouched rather than throwing. Rationale: `AuthRestClient`'s
 * inline dispatch logic always calls `authenticateIfNeeded()` immediately
 * before `extendRequest()`, so a missing handle here can only happen if a
 * caller uses `extendRequest` without first authenticating — in which case
 * the safer behavior is to forward the unmodified config (the underlying
 * request will then 401 on its own and the dispatch retry path will
 * recover) rather than throwing a synchronous error that would short-circuit
 * the resilience pipeline.
 */
export class AuthStrategyService {
    /**
     * Public-readable inflight map required by `@DeduplicateInflight` —
     * the decorator reads `context.target.inflightMap` to coalesce
     * concurrent invocations of {@link performAuthenticate}. Must remain
     * public for the decorator's reflection-free access pattern.
     */
    readonly inflightMap: Map<string, Promise<unknown>> = new Map();

    /**
     * Cached authentication handle returned by the most recent successful
     * {@link AuthConfig.authenticate} call. `null` means "no active session"
     * — the next {@link authenticateIfNeeded} call will trigger a fresh
     * handshake.
     */
    private authResult: AuthStrategy | null = null;

    /**
     * @param authConfig - User-supplied authentication factory.
     * @param client - Resilient HTTP client passed to
     * `authConfig.authenticate(client)`. Typed as `unknown` here to avoid a
     * runtime circular import between this service and `RestClient`
     * (`RestClient` is built in a parallel step). The `AuthConfig.authenticate`
     * signature is the source of truth for the expected client shape.
     */
    constructor(
        private readonly authConfig: AuthConfig,
        // RestClient is forward-referenced; using `unknown` here keeps the
        // service decoupled from the transport layer until the module wires
        // them together at runtime.
        private readonly client: unknown,
    ) {}

    /**
     * Returns `true` only when a cached strategy exists AND its own
     * `isAuthenticated()` reports a still-valid session. Any other state
     * (no cached strategy, or a cached strategy that has expired) returns
     * `false` and signals the next {@link authenticateIfNeeded} call to
     * re-authenticate.
     */
    isAuthenticated(): boolean {
        if (this.authResult === null) {
            return false;
        }

        return this.authResult.isAuthenticated();
    }

    /**
     * Ensures a valid authentication session exists. Short-circuits when
     * {@link isAuthenticated} returns `true`; otherwise delegates to the
     * deduplicated {@link performAuthenticate} so concurrent callers share
     * a single underlying handshake.
     */
    async authenticateIfNeeded(): Promise<void> {
        if (this.isAuthenticated()) {
            return;
        }

        await this.performAuthenticate();
    }

    /**
     * Returns a new {@link AxiosRequestConfig} extended with credentials
     * from the cached strategy. When no strategy is cached, returns the
     * input config untouched (see class-level JSDoc for rationale).
     */
    extendRequest(config: AxiosRequestConfig): AxiosRequestConfig {
        if (this.authResult === null) {
            return config;
        }

        return this.authResult.extendRequest(config);
    }

    /**
     * Invalidates the cached strategy. After this call, {@link isAuthenticated}
     * returns `false` and the next {@link authenticateIfNeeded} triggers a
     * fresh handshake. Used by `AuthRestClient`'s 401 retry path.
     */
    clearAuth(): void {
        this.authResult = null;
    }

    /**
     * Private deduplicated authentication primitive. Delegates the actual
     * handshake to {@link AuthConfig.authenticate} and stores the resolved
     * strategy in {@link authResult}.
     *
     * Decorated with `@DeduplicateInflight(() => 'authenticate')` so any
     * number of concurrent invocations collapse into one underlying
     * `authConfig.authenticate(client)` call. The key is the constant
     * {@link AUTHENTICATE_DEDUP_KEY} regardless of arguments, which is
     * essential for single-flight correctness.
     */
    @DeduplicateInflight(() => AUTHENTICATE_DEDUP_KEY)
    private async performAuthenticate(): Promise<void> {
        this.authResult = await this.authConfig.authenticate(
            this.client as Parameters<AuthConfig["authenticate"]>[0],
        );
    }
}
