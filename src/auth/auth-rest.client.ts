import { isAxiosError, type AxiosResponse } from 'axios'

import { HookableHttpService, type HttpVerb, type InvokeArgs } from '../client/hookable-http.service'
import { RestClient } from '../client/rest.client'
import type { AuthStrategyService } from './auth-strategy.service'

/**
 * Authenticated HTTP client. Composes a {@link RestClient} (which owns the
 * resilience policy stack) with an {@link AuthStrategyService} (which owns
 * the authentication lifecycle) and threads each verb through the same
 * {@link HookableHttpService} surface as {@link RestClient}.
 *
 * Lifecycle for every request (implemented inline in {@link dispatch}):
 *
 * 1. {@link AuthStrategyService.authenticateIfNeeded} runs before the call so
 *    the cached strategy is fresh (single-flight via the underlying
 *    `@DeduplicateInflight`).
 * 2. The request `config` is augmented via
 *    {@link AuthStrategyService.extendRequest} into a fresh
 *    {@link InvokeArgs} carrier.
 * 3. The augmented carrier is forwarded to {@link HookableHttpService.dispatch}
 *    on the underlying {@link RestClient} verb, which itself runs through the
 *    resilience pipeline.
 * 4. On a single HTTP 401 axios error,
 *    {@link AuthStrategyService.clearAuth} is called, the strategy is
 *    re-authenticated, and the *original* (pre-extension) config is
 *    re-extended and replayed against the underlying client. This guarantees
 *    the new credentials replace the stale `Authorization` header from the
 *    failed attempt rather than being merged on top of it.
 *
 * **NFR — zero `rxjs` and zero `p-retry` imports anywhere in `src/auth/`.**
 * `rxjs` is consumed inside {@link HookableHttpService} only when the
 * underlying transport returns an `Observable`; {@link RestClient} returns a
 * `Promise`, so this client never observes the reactive path. `p-retry` is
 * not used anywhere in the auth layer — the resilience pipeline owns retry
 * semantics.
 */
export class AuthRestClient extends HookableHttpService {
  /**
   * Public-readable authentication strategy. Public because module wiring,
   * tests, and adapters (e.g. middleware that inspects auth state) read the
   * cached strategy directly off the client.
   */
  readonly authStrategy: AuthStrategyService

  constructor(restClient: RestClient, authStrategy: AuthStrategyService) {
    super(restClient)
    this.authStrategy = authStrategy
  }

  /**
   * Returns the wrapped {@link RestClient} that owns the resilience policy
   * stack. Exposed so module wiring (notably the single-source-of-truth
   * invariant test on {@link AuthRestModule}) and adapters can recover the
   * exact instance the {@link AuthRestClient} was constructed with — without
   * widening the {@link HookableHttpService.httpService} field's structural
   * type.
   */
  get restClient(): RestClient {
    return this.httpService as RestClient
  }

  /**
   * Runs the auth lifecycle inline around the base dispatch:
   *
   * 1. Pre-flight {@link AuthStrategyService.authenticateIfNeeded} so the
   *    cached strategy is valid before the request is built.
   * 2. Re-extend the caller's config via
   *    {@link AuthStrategyService.extendRequest} into a fresh carrier — the
   *    original {@link InvokeArgs} is treated as immutable so the 401 retry
   *    path can re-extend the same pristine config.
   * 3. Delegate to {@link HookableHttpService.dispatch} on the augmented
   *    carrier, which forwards to the underlying {@link RestClient} verb.
   *
   * On a single HTTP 401 response:
   *
   * 1. {@link AuthStrategyService.clearAuth} drops the cached strategy.
   * 2. {@link AuthStrategyService.authenticateIfNeeded} acquires a fresh
   *    strategy (single-flight via the underlying `@DeduplicateInflight`).
   * 3. The *original* (pre-extension) `initialArgs.config` is re-extended so
   *    the new credentials replace the stale `Authorization` header instead
   *    of being layered on top of it.
   * 4. A single replay against the underlying transport via
   *    {@link HookableHttpService.callUnderlying}, bypassing the auth pre-flight
   *    so authentication is not double-applied. Any error on the replay
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
      await this.authStrategy.authenticateIfNeeded()
      const authedArgs: InvokeArgs = {
        ...initialArgs,
        config: this.authStrategy.extendRequest(initialArgs.config),
      }
      return await super.dispatch<T>(verb, authedArgs)
    }
    catch (error) {
      if (!isAxiosError(error) || error.response?.status !== 401) {
        throw error
      }

      this.authStrategy.clearAuth()
      await this.authStrategy.authenticateIfNeeded()
      const retryArgs: InvokeArgs = {
        ...initialArgs,
        config: this.authStrategy.extendRequest(initialArgs.config),
      }
      return await this.callUnderlying<T>(verb, retryArgs)
    }
  }
}
