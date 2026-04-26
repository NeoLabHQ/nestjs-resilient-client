import type { AxiosRequestConfig } from "axios";
import type { RestClient } from "../client/rest.client";

/**
 * Strategy returned by {@link AuthConfig.authenticate}. Encapsulates the
 * runtime concerns of an active authentication session: how to know if the
 * session is still valid, and how to attach credentials to outgoing requests.
 *
 * Implementations are produced by user-supplied {@link AuthConfig} factories
 * and consumed by `AuthStrategyService` and the `@Authenticate` decorator.
 */
export interface AuthStrategy {
    /**
     * Returns `true` while the current credentials are still considered valid.
     * Implementations typically compare a token expiry timestamp against the
     * current time, optionally with a safety margin.
     */
    isAuthenticated(): boolean;

    /**
     * Returns a new {@link AxiosRequestConfig} with authentication material
     * (headers, query params, body fields, etc.) applied to the given config.
     * Must not mutate the input — callers may reuse the original config.
     */
    extendRequest(config: AxiosRequestConfig): AxiosRequestConfig;
}

/**
 * User-supplied authentication factory consumed by `AuthRestModule` and
 * `AuthStrategyService`. A single asynchronous `authenticate` call drives the
 * full auth handshake: it receives a fully resilient {@link RestClient} for
 * making the auth request(s) and resolves to an {@link AuthStrategy} that
 * represents the resulting session.
 *
 * The {@link RestClient} is forward-referenced via `import type` to avoid a
 * runtime circular import — `RestClient` is a transport primitive that does
 * not (and must not) depend on auth types.
 */
export interface AuthConfig {
    /**
     * Performs the authentication handshake and resolves to an
     * {@link AuthStrategy} representing the active session.
     *
     * @param client - Resilient HTTP client to use for any auth-related
     * requests (token endpoints, refresh calls, etc.). Reuses the same
     * resilience policy stack as the consuming `AuthRestClient`.
     */
    authenticate(client: RestClient): Promise<AuthStrategy>;
}
