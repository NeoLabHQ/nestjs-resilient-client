import type { AxiosRequestConfig } from "axios";
import type { RestClient } from "../client/rest.client";

/**
 * Strategy that owns the full lifecycle of an authentication session:
 * performing the initial handshake, reporting whether the cached credentials
 * are still valid, attaching them to outgoing requests, and invalidating the
 * session when it has been rejected by the upstream service.
 *
 * Implementations are user-supplied. A single instance is constructed once and
 * passed to `AuthRestModule` (or directly to `AuthRestClient` collaborators);
 * the consuming infrastructure is responsible for invoking the methods at the
 * appropriate points in the request pipeline:
 *
 * - {@link authenticate} is called inside a single-flight wrapper, so concurrent
 *   callers share one in-flight handshake.
 * - {@link isAuthenticated} gates whether `authenticate` needs to run before the
 *   next request.
 * - {@link extendRequest} is invoked once per request, immediately before the
 *   call is dispatched to the underlying transport.
 * - {@link invalidate} is invoked after a 401 response so the next request
 *   triggers a fresh handshake.
 *
 * The {@link RestClient} parameter on {@link authenticate} is forward-referenced
 * via `import type` to avoid a runtime circular import — `RestClient` is a
 * transport primitive that does not (and must not) depend on auth types.
 *
 * @example
 * ```ts
 * import { Injectable } from '@nestjs/common'
 * import { ConfigService } from '@nestjs/config'
 * import type { AxiosRequestConfig } from 'axios'
 * import type { AuthStrategy, RestClient } from 'nestjs-resilient-client'
 *
 * // A concrete implementation that fetches a Bearer token from an OAuth2
 * // token endpoint and refreshes it 60 s before it expires.
 * @Injectable()
 * class BearerTokenStrategy implements AuthStrategy {
 *   private token?: string
 *   private expiresAt = 0
 *
 *   constructor(private readonly config: ConfigService) {}
 *
 *   async authenticate(client: RestClient): Promise<void> {
 *     const response = await client.post<{ access_token: string; expires_in: number }>(
 *       this.config.getOrThrow('AUTH_TOKEN_URL'),
 *       { grant_type: 'client_credentials' },
 *     )
 *     this.token = response.data.access_token
 *     // Subtract 60 s so the session is refreshed before it actually expires.
 *     this.expiresAt = Date.now() + response.data.expires_in * 1_000 - 60_000
 *   }
 *
 *   async isAuthenticated(): Promise<boolean> {
 *     return this.token !== undefined && Date.now() < this.expiresAt
 *   }
 *
 *   extendRequest(config: AxiosRequestConfig): AxiosRequestConfig {
 *     return {
 *       ...config,
 *       headers: { ...(config.headers ?? {}), Authorization: `Bearer ${this.token}` },
 *     }
 *   }
 *
 *   async invalidate(): Promise<void> {
 *     this.token = undefined
 *     this.expiresAt = 0
 *   }
 * }
 * ```
 */
export interface AuthStrategy {
    /**
     * Performs the authentication handshake and stores the resulting session
     * state on the implementation instance itself. Resolves once the session
     * is ready to authorize requests; subsequent {@link isAuthenticated} calls
     * must return `true` until the session expires or is invalidated.
     *
     * Called inside a single-flight wrapper, so implementations do not need to
     * deduplicate concurrent invocations themselves.
     *
     * @param client - Resilient HTTP client to use for any auth-related
     * requests (token endpoints, refresh calls, etc.). Reuses the same
     * resilience policy stack as the consuming `AuthRestClient`.
     */
    authenticate(client: RestClient): Promise<void>;

    /**
     * Resolves with `true` while the current credentials are still considered
     * valid. Implementations typically compare a token expiry timestamp
     * against the current time, optionally with a safety margin. Must resolve
     * with `false` when no session has been established yet or after
     * {@link invalidate} has been called.
     *
     * Asynchronous so implementations can consult persisted credential stores
     * (filesystem, keychain, remote token-introspection endpoints, etc.)
     * without blocking the dispatch path on synchronous I/O.
     */
    isAuthenticated(): Promise<boolean>;

    /**
     * Returns a new {@link AxiosRequestConfig} with authentication material
     * (headers, query params, body fields, etc.) applied to the given config.
     * Must not mutate the input — callers may reuse the original config.
     */
    extendRequest(config: AxiosRequestConfig): AxiosRequestConfig;

    /**
     * Drops the current session so that the next request triggers a fresh
     * {@link authenticate} call. Resolves once the session has been dropped
     * (asynchronous so implementations can flush persisted credentials, await
     * remote sign-out endpoints, etc.). After the returned promise resolves,
     * {@link isAuthenticated} must report `false` until a successful handshake
     * re-establishes the session. Typically invoked by the consuming
     * infrastructure after the upstream service rejects a request with HTTP
     * 401.
     */
    invalidate(): Promise<void>;
}
