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
 * Lifecycle for every request:
 *
 * 1. {@link AuthStrategyService.authenticateIfNeeded} runs before the call
 *    (executed by the `onInvoke` hook supplied to the base class).
 * 2. The request `config` is augmented via
 *    {@link AuthStrategyService.extendRequest} (also inside `onInvoke`).
 * 3. The augmented args are forwarded to the wrapped {@link RestClient} verb,
 *    which itself runs through the resilience pipeline.
 * 4. On a single HTTP 401 axios error,
 *    {@link AuthStrategyService.clearAuth} is called, the strategy is
 *    re-authenticated, and the *original* (pre-`onInvoke`) config is
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
    super(restClient, {
      onInvoke: async (args) => {
        await authStrategy.authenticateIfNeeded()
        return { ...args, config: authStrategy.extendRequest(args.config) }
      },
    })
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
   * Adds the 401-recovery path on top of the base hook lifecycle. A single
   * HTTP 401 response triggers:
   *
   * 1. {@link AuthStrategyService.clearAuth} to drop the cached strategy.
   * 2. {@link AuthStrategyService.authenticateIfNeeded} to acquire a fresh
   *    strategy (single-flight via the underlying `@DeduplicateInflight`).
   * 3. A re-extension of the *original* (pre-`onInvoke`) `config` so the new
   *    credentials replace the stale `Authorization` header instead of being
   *    layered on top of it.
   * 4. A single replay against the underlying transport via
   *    {@link HookableHttpService.callUnderlying}, bypassing the `onInvoke`
   *    hook so authentication is not double-applied. Any error on the replay
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
      return await super.dispatch<T>(verb, initialArgs)
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
