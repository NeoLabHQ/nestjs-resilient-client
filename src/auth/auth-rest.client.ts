import { isAxiosError, type AxiosResponse } from 'axios'

import { HookableHttpService, type HooksConfig, type HttpVerb, type InvokeArgs } from '../client/hookable-http.service'
import { RestClient } from '../client/rest.client'
import type { AuthProcessor } from './auth-processor'

/**
 * Authenticated HTTP client. Composes a {@link RestClient} (which owns the
 * resilience policy stack) with an {@link AuthProcessor} (which owns
 * the authentication lifecycle) and threads each verb through the same
 * {@link HookableHttpService} surface as {@link RestClient}.
 *
 * Lifecycle for every request (implemented inline in {@link dispatch}):
 *
 * 1. {@link AuthProcessor.authenticateIfNeeded} runs before the call so
 *    the cached strategy is fresh (single-flight via the underlying
 *    `@DeduplicateInflight`).
 * 2. The request `config` is augmented via
 *    {@link AuthProcessor.extendRequest} into a fresh
 *    {@link InvokeArgs} carrier.
 * 3. The augmented carrier is forwarded to {@link HookableHttpService.dispatch}
 *    (i.e. `super.dispatch`), which applies the user-supplied
 *    {@link HooksConfig} lifecycle around the underlying
 *    {@link RestClient} verb call. The {@link RestClient} itself runs through
 *    the resilience pipeline, so hooks defined on the auth layer wrap the
 *    auth lifecycle, which in turn wraps the resilience pipeline.
 * 4. On a single HTTP 401 axios error,
 *    {@link AuthProcessor.clearAuth} is called, the strategy is
 *    re-authenticated, and the *original* (pre-extension) config is
 *    re-extended and replayed against the underlying client. This guarantees
 *    the new credentials replace the stale `Authorization` header from the
 *    failed attempt rather than being merged on top of it.
 *
 * **NFR — zero `rxjs` and zero `p-retry` imports anywhere in `src/auth/`.**
 * `rxjs` is consumed inside {@link HookableHttpService}'s base only when the
 * underlying transport returns an `Observable`; {@link RestClient} returns a
 * `Promise`, so this client never observes the reactive path. `p-retry` is
 * not used anywhere in the auth layer — the resilience pipeline owns retry
 * semantics. The same reasoning applies to the `rxjsPipeline` slot:
 * {@link AuthRestClient} never forwards one to `super(...)` because the
 * upstream {@link RestClient} transport already returns a `Promise`, so the
 * pipeline would silently no-op on the auth layer.
 *
 * @example
 * ```ts
 * import { AuthRestClient, AuthProcessor, RestClient } from 'nestjs-http-client'
 *
 * declare const restClient: RestClient
 * declare const authProcessor: AuthProcessor
 *
 * // Typically wired by AuthRestModule; shown here for illustration.
 * const client = new AuthRestClient(restClient, authProcessor)
 *
 * // Each call runs through the auth lifecycle:
 * //   authenticateIfNeeded -> extendRequest -> dispatch -> (on 401) reauth + replay
 * const response = await client.get<Order[]>('/orders')
 * ```
 */
export class AuthRestClient extends HookableHttpService {
  /**
   * Public-readable authentication processor. Public because module wiring,
   * tests, and adapters (e.g. middleware that inspects auth state) read the
   * cached strategy directly off the client.
   *
   * @example
   * ```ts
   * declare const authRestClient: AuthRestClient
   *
   * // Inspect the current authentication session without triggering a request.
   * if (!authRestClient.authProcessor.isAuthenticated()) {
   *   await authRestClient.authProcessor.authenticateIfNeeded()
   * }
   * ```
   */
  readonly authProcessor: AuthProcessor

  /**
   * Composes the resilient transport with the authentication lifecycle. Both
   * collaborators are typically resolved by {@link AuthRestModule}; constructing
   * directly is reserved for tests and advanced consumers wiring the stack
   * manually.
   *
   * @param restClient - Resilient HTTP client owning the cockatiel policy stack.
   * @param authProcessor - Processor coordinating the per-request auth lifecycle.
   * @param hooks - Optional {@link HooksConfig} forwarded to
   *   {@link HookableHttpService}. Hooks wrap the entire auth lifecycle (and
   *   therefore the resilience pipeline owned by {@link RestClient}). No
   *   `rxjsPipeline` is forwarded to `super(...)` because the underlying
   *   transport here is a {@link RestClient} (returns `Promise`), so the
   *   reactive pipeline would silently no-op at this layer.
   *
   * @example
   * ```ts
   * import { AuthRestClient, AuthProcessor, RestClient } from 'nestjs-http-client'
   *
   * declare const restClient: RestClient
   * declare const authProcessor: AuthProcessor
   *
   * const client = new AuthRestClient(restClient, authProcessor, {
   *   onError: (verb, args, error) => {
   *     console.error(`[auth-http] ${verb.toUpperCase()} ${args.url ?? ''}`, error)
   *     return undefined // passthrough — rethrow the original error
   *   },
   * })
   * const response = await client.get<{ ok: boolean }>('/orders')
   * ```
   */
  constructor(
    restClient: RestClient,
    authProcessor: AuthProcessor,
    hooks?: HooksConfig,
  ) {
    // No rxjsPipeline forwarded — the underlying RestClient already exposes
    // Promise-returning verbs, so the pipeline contract (defined over
    // Observable) would be a no-op at the auth layer.
    super(restClient, hooks)
    this.authProcessor = authProcessor
  }

  /**
   * Returns the wrapped {@link RestClient} that owns the resilience policy
   * stack. Exposed so module wiring (notably the single-source-of-truth
   * invariant test on {@link AuthRestModule}) and adapters can recover the
   * exact instance the {@link AuthRestClient} was constructed with — without
   * widening the inherited `httpService` field's structural type
   * (declared on {@link HookableHttpService}'s base).
   *
   * @example
   * ```ts
   * declare const authRestClient: AuthRestClient
   *
   * // Recover the underlying RestClient to use it directly (e.g. for
   * // un-authenticated requests that still benefit from the resilience pipeline).
   * const restClient = authRestClient.restClient
   * const response = await restClient.get('/public/health')
   * ```
   */
  get restClient(): RestClient {
    return this.httpService as RestClient
  }

  /**
   * Runs the auth lifecycle inline around the parent dispatch:
   *
   * 1. Pre-flight {@link AuthProcessor.authenticateIfNeeded} so the
   *    cached strategy is valid before the request is built.
   * 2. Re-extend the caller's config via
   *    {@link AuthProcessor.extendRequest} into a fresh carrier — the
   *    original {@link InvokeArgs} is treated as immutable so the 401 retry
   *    path can re-extend the same pristine config.
   * 3. Delegate to {@link HookableHttpService.dispatch} on the augmented
   *    carrier, which applies the {@link HooksConfig} lifecycle and forwards
   *    to the underlying {@link RestClient} verb. Hooks therefore wrap the
   *    auth lifecycle (which itself wraps the resilience pipeline).
   *
   * On a single HTTP 401 response:
   *
   * 1. {@link AuthProcessor.clearAuth} drops the cached strategy.
   * 2. {@link AuthProcessor.authenticateIfNeeded} acquires a fresh
   *    strategy (single-flight via the underlying `@DeduplicateInflight`).
   * 3. The *original* (pre-extension) `initialArgs.config` is re-extended so
   *    the new credentials replace the stale `Authorization` header instead
   *    of being layered on top of it.
   * 4. A single replay against the underlying transport via
   *    `callUnderlying`, bypassing both the auth pre-flight AND the hook
   *    lifecycle so authentication is not double-applied and hooks do not
   *    double-fire on the same logical attempt. Any error on the replay
   *    (including a second 401) propagates as-is.
   *
   * Non-401 axios errors and non-axios errors propagate untouched so the
   * resilience pipeline owned by the wrapped {@link RestClient} retains full
   * control of retry semantics for transient transport failures.
   */
  protected override async dispatch<T = unknown>(
    verb: HttpVerb,
    initialArgs: InvokeArgs,
  ): Promise<AxiosResponse<T>> {
    try {
      await this.authProcessor.authenticateIfNeeded()
      const authedArgs: InvokeArgs = {
        ...initialArgs,
        config: this.authProcessor.extendRequest(initialArgs.config),
      }
      return await super.dispatch<T>(verb, authedArgs)
    }
    catch (error) {
      if (!isAxiosError(error) || error.response?.status !== 401) {
        throw error
      }

      this.authProcessor.clearAuth()
      await this.authProcessor.authenticateIfNeeded()
      const retryArgs: InvokeArgs = {
        ...initialArgs,
        config: this.authProcessor.extendRequest(initialArgs.config),
      }
      return await this.callUnderlying<T>(verb, retryArgs)
    }
  }
}
