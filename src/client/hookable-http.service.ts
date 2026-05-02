import type { AxiosResponse } from 'axios'

import {
  BaseHttpService,
  type HttpServiceLike,
  type HttpVerb,
  type InvokeArgs,
} from './base-http.service'
import type { RxjsPipeline } from './rxjs-pipeline'

/**
 * Lifecycle hooks that wrap a single verb invocation on the
 * {@link HookableHttpService} surface. Each hook is optional, and every hook
 * uses an `undefined` (or `Promise<undefined>`) return value as the
 * passthrough sentinel — the caller continues with the value it already had.
 *
 * Hooks are invoked INSIDE the resilience pipeline, so retries observe
 * hook-transformed args (i.e. an `onInvoke` substitution applies to every
 * attempt of the same logical request).
 *
 * - `onInvoke` runs before the underlying transport call. Returning a new
 *   {@link InvokeArgs} replaces the carrier used for dispatch; returning
 *   `undefined` (or `Promise<undefined>`) means "use the args unchanged".
 *   Use this hook to mutate headers, rewrite URLs, or attach correlation IDs.
 * - `onReturn` runs after a successful response. Returning a new
 *   `AxiosResponse` replaces the response handed back to the caller;
 *   returning `undefined` (or `Promise<undefined>`) means "use the response
 *   unchanged". Use this hook to redact bodies, decorate metadata, or emit
 *   instrumentation events.
 * - `onError` runs when the transport (or any inner policy) throws.
 *   Returning an `AxiosResponse` substitutes a synthetic success and
 *   suppresses the error; returning `undefined`, `Promise<undefined>`, or
 *   `void` rethrows the original error. Use this hook to surface fallback
 *   responses or normalise error envelopes.
 *
 * @example
 * ```ts
 * import type { HooksConfig } from 'nestjs-http-client'
 *
 * const hooks: HooksConfig = {
 *   // Attach a correlation ID to every outgoing request
 *   onInvoke(_verb, args) {
 *     return {
 *       ...args,
 *       config: {
 *         ...args.config,
 *         headers: { ...(args.config.headers ?? {}), 'X-Correlation-Id': crypto.randomUUID() },
 *       },
 *     }
 *   },
 *   // Redact a sensitive field before the response leaves the client
 *   onReturn(_verb, _args, response) {
 *     if (typeof response.data === 'object' && response.data !== null && 'secret' in response.data) {
 *       return { ...response, data: { ...(response.data as object), secret: '[REDACTED]' } }
 *     }
 *     return undefined
 *   },
 *   // Suppress 404 errors by returning an empty payload
 *   onError(_verb, _args, error) {
 *     if (isAxiosError(error) && error.response?.status === 404) {
 *       return { ...error.response, data: null }
 *     }
 *     return undefined
 *   },
 * }
 * ```
 */
export interface HooksConfig {
  /**
   * Pre-call hook: transform `args` before the transport invocation.
   *
   * Return a new {@link InvokeArgs} carrier to replace the args used for
   * dispatch, or return `undefined` (or `Promise<undefined>`) to use the
   * incoming args unchanged (passthrough). Implementations MUST NOT mutate
   * the input — return a new object instead.
   */
  onInvoke?: (
    verb: HttpVerb,
    args: InvokeArgs,
  ) => InvokeArgs | Promise<InvokeArgs> | undefined | Promise<undefined>

  /**
   * Post-call hook: transform or observe the successful response.
   *
   * Return a new `AxiosResponse` to replace the response handed back to the
   * caller, or return `undefined` (or `Promise<undefined>`) to use the
   * response unchanged (passthrough). Implementations MUST NOT mutate the
   * input — return a new object instead.
   */
  onReturn?: (
    verb: HttpVerb,
    args: InvokeArgs,
    response: AxiosResponse,
  ) => AxiosResponse | Promise<AxiosResponse> | undefined | Promise<undefined>

  /**
   * Error hook: substitute a synthetic response (suppressing the error) or
   * rethrow the original error.
   *
   * Return an `AxiosResponse` to suppress the error and resolve with the
   * substituted response, or return `undefined` / `Promise<undefined>` /
   * `void` to rethrow the original error (passthrough).
   */
  onError?: (
    verb: HttpVerb,
    args: InvokeArgs,
    error: unknown,
  ) => AxiosResponse | Promise<AxiosResponse> | undefined | Promise<undefined> | void
}

/**
 * Concrete {@link BaseHttpService} subclass that applies a {@link HooksConfig}
 * lifecycle around every dispatched verb invocation. The dispatch override
 * wraps `super.dispatch(...)` with three optional hooks:
 *
 * - `onInvoke` runs BEFORE `super.dispatch` and may transform the
 *   {@link InvokeArgs} carrier (e.g. attach a correlation header).
 * - `onReturn` runs AFTER a successful `super.dispatch` and may substitute
 *   the resolved {@link AxiosResponse} (e.g. redact a sensitive field).
 * - `onError` runs WHEN `super.dispatch` throws and may either suppress the
 *   error by returning a synthetic response, or rethrow by returning
 *   `undefined` / `void`.
 *
 * Each hook treats `undefined` (or `Promise<undefined>`) as the "passthrough"
 * sentinel — the caller continues with the value it already had. Any other
 * return (including `null` or any other falsy non-undefined value) is treated
 * as a substitute. Hook return values are awaited so async transformations
 * (token lookups, instrumentation flushes, …) integrate naturally.
 *
 * Hooks run INSIDE any subclass `dispatch` override that wraps
 * `super.dispatch(...)`. Concretely, when {@link RestClient} (which extends
 * `HookableHttpService`) wraps `super.dispatch` in `policy.execute(...)`,
 * every retry attempt re-invokes the hook lifecycle — guaranteeing retries
 * observe hook-transformed args rather than running once before the resilience
 * pipeline.
 *
 * @example
 * ```ts
 * import { HookableHttpService } from 'nestjs-http-client'
 *
 * // Attach a correlation ID and log every successful response.
 * const client = new HookableHttpService(httpService, {
 *   onInvoke(_verb, args) {
 *     return {
 *       ...args,
 *       config: {
 *         ...args.config,
 *         headers: { ...(args.config.headers ?? {}), 'X-Correlation-Id': crypto.randomUUID() },
 *       },
 *     }
 *   },
 *   onReturn(verb, _args, response) {
 *     console.log(`${verb.toUpperCase()} -> ${response.status}`)
 *     return undefined // passthrough — keep the original response
 *   },
 * })
 * ```
 */
export class HookableHttpService extends BaseHttpService {
  constructor(
    httpService: HttpServiceLike,
    /**
     * User-supplied hook configuration. Stored as `protected readonly` so
     * subclasses (or test doubles) can introspect the configuration without
     * dropping back to a wider cast, but the field is never re-assigned after
     * construction.
     */
    // Default to an empty object so the dispatch override can read
    // `this.hooks.onInvoke` without a separate undefined-guard on every call.
    protected readonly hooks: HooksConfig = {},
    rxjsPipeline?: RxjsPipeline,
  ) {
    // Forward the rxjsPipeline to BaseHttpService so the reactive pipeline
    // (deduplication / rate limiting / throttling) is applied inside
    // `callUnderlying`. Hooks live one layer above — they wrap the entire
    // dispatch (including the pipeline-aware call into the transport).
    super(httpService, rxjsPipeline)
  }

  /**
   * Wraps `super.dispatch(...)` with the {@link HooksConfig} lifecycle:
   *
   * 1. `onInvoke(verb, args)` — awaited; the resolved value (when not
   *    `undefined`) replaces `args` for the inner dispatch. `undefined` is the
   *    passthrough sentinel; any other value (including `null` or a falsy
   *    non-undefined) is treated as a substitute.
   * 2. `super.dispatch(verb, args)` — the inner transport call.
   * 3. `onReturn(verb, args, response)` — awaited; the resolved value (when
   *    not `undefined`) replaces the response handed to the caller. Same
   *    passthrough semantics as `onInvoke`.
   * 4. If `super.dispatch` throws, `onError(verb, args, error)` is awaited;
   *    if the resolved value is an `AxiosResponse`, the error is suppressed
   *    and the substituted response is returned. `undefined` / `void`
   *    rethrows the original error.
   *
   * Note that `onError` does NOT receive the (possibly hook-transformed) args
   * directly — it sees the same `args` that were passed into the inner
   * dispatch (i.e. the `onInvoke` substitute, when one was returned). This
   * keeps `onError` aligned with what the transport actually saw, which is
   * what fallback-construction logic typically needs (e.g. echoing the
   * request URL into the synthetic response config).
   */
  protected override async dispatch<T = unknown>(
    verb: HttpVerb,
    args: InvokeArgs,
  ): Promise<AxiosResponse<T>> {
    // `?? args` implements the documented passthrough sentinel: only
    // `undefined` (or `Promise<undefined>`) means "use args unchanged"; any
    // other return value — including `null` — is treated as a substitute.
    const nextArgs = (await this.hooks.onInvoke?.(verb, args)) ?? args

    try {
      const response = await super.dispatch<T>(verb, nextArgs)
      // Same passthrough sentinel as onInvoke. Cast to `AxiosResponse<T>`
      // because the hook signature carries the unparameterised `AxiosResponse`
      // shape — the caller's `T` is preserved across the substitution.
      const substituted = await this.hooks.onReturn?.(verb, nextArgs, response)
      return (substituted ?? response) as AxiosResponse<T>
    }
    catch (error) {
      const recovered = await this.hooks.onError?.(verb, nextArgs, error)
      if (recovered === undefined) {
        // Passthrough: rethrow the original error so resilience policies above
        // (retry / circuit-breaker / fallback) and the caller's catch handler
        // see the same failure the transport produced.
        throw error
      }
      return recovered as AxiosResponse<T>
    }
  }
}
