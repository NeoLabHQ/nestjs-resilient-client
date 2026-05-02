/**
 * File-level disable for `@typescript-eslint/no-explicit-any`.
 *
 * Every public verb signature on this class mirrors the corresponding
 * `HttpService.<verb><T = any, D = any>` signature from `@nestjs/axios`,
 * which itself mirrors axios's own declarations. Using `unknown` here would
 * force every consumer to narrow `response.data` and would break API parity
 * with `@nestjs/axios` — preventing this class from being a drop-in wrapper.
 *
 * The justification is identical for every verb (request, get, delete, head,
 * post, put, patch, postForm, putForm, patchForm), so a single file-level
 * disable replaces ten otherwise-identical per-line suppressions in line with
 * `.claude/rules/fix-lint-not-suppress.md` (no per-statement disable scaling).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import { firstValueFrom, isObservable, type Observable } from 'rxjs'

import type { RxjsPipeline } from './rxjs-pipeline'

/**
 * Names of every HTTP verb the hookable transport surface dispatches through.
 * Encoded as a literal-string union so the `dispatch` and `callUnderlying`
 * helpers can index the underlying transport without losing type information.
 *
 * @example
 * ```ts
 * import type { HttpVerb } from 'nestjs-http-client'
 *
 * function logVerb(verb: HttpVerb): void {
 *   console.log(`dispatching HTTP verb: ${verb}`)
 * }
 * ```
 */
export type HttpVerb =
  | 'request'
  | 'get'
  | 'delete'
  | 'head'
  | 'post'
  | 'put'
  | 'patch'
  | 'postForm'
  | 'putForm'
  | 'patchForm'

/**
 * Structural surface required of the underlying transport. Both
 * `@nestjs/axios`'s `HttpService` (which returns `Observable<AxiosResponse>`)
 * and the {@link RestClient} class (which returns `Promise<AxiosResponse>`)
 * satisfy this shape, so {@link BaseHttpService} can wrap either without
 * importing one from the other.
 *
 * The verb returns are typed as `unknown` because the upstream transports use
 * incompatible reactive-vs-promise wrappers; {@link BaseHttpService}
 * normalises the result via `firstValueFrom` when the value is an `Observable`.
 * Consumers of {@link BaseHttpService.callUnderlying} never see the raw
 * return value — it is funnelled through `firstValueFrom`/`await`, so a single
 * `unknown` return is sufficient (no narrowing burden propagates outward).
 *
 * @example
 * ```ts
 * import type { HttpServiceLike } from 'nestjs-http-client'
 * import type { AxiosInstance, AxiosRequestConfig } from 'axios'
 *
 * // Custom transport that forwards every verb to fetch-based implementation
 * class FetchTransport implements HttpServiceLike {
 *   axiosRef = {} as AxiosInstance
 *   request(config: AxiosRequestConfig) { return customFetch(config) }
 *   get(url: string, config?: AxiosRequestConfig) { return customFetch({ ...config, url, method: 'GET' }) }
 *   // … remaining verbs
 * }
 * ```
 */
export interface HttpServiceLike {
  request: (config: AxiosRequestConfig) => unknown
  get: (url: string, config?: AxiosRequestConfig) => unknown
  delete: (url: string, config?: AxiosRequestConfig) => unknown
  head: (url: string, config?: AxiosRequestConfig) => unknown
  post: (url: string, data?: unknown, config?: AxiosRequestConfig) => unknown
  put: (url: string, data?: unknown, config?: AxiosRequestConfig) => unknown
  patch: (url: string, data?: unknown, config?: AxiosRequestConfig) => unknown
  postForm: (url: string, data?: unknown, config?: AxiosRequestConfig) => unknown
  putForm: (url: string, data?: unknown, config?: AxiosRequestConfig) => unknown
  patchForm: (url: string, data?: unknown, config?: AxiosRequestConfig) => unknown
  /**
   * Underlying axios instance. Both `@nestjs/axios`'s `HttpService` and the
   * library's {@link RestClient} expose `axiosRef: AxiosInstance`, so
   * consumers reading `client.axiosRef.interceptors` (e.g. e2e tests that
   * register a request interceptor to count attempts) get the real
   * `AxiosInstance` typing rather than `unknown`.
   */
  axiosRef: AxiosInstance
}

/**
 * Carrier shape for the verb-invocation arguments threaded through
 * {@link BaseHttpService.dispatch}. `url` and `data` are optional because
 * not every verb owns those slots (`request` carries everything in `config`;
 * verbs in the `(url, config?)` family own `url` but not `data`).
 *
 * Subclasses that override {@link BaseHttpService.dispatch} treat this
 * carrier as immutable — produce a new object when any field needs to change
 * before forwarding to {@link BaseHttpService.callUnderlying}.
 *
 * @example
 * ```ts
 * import type { InvokeArgs } from 'nestjs-http-client'
 *
 * // Args for a GET request
 * const getArgs: InvokeArgs = {
 *   url: '/users/42',
 *   config: { headers: { Accept: 'application/json' } },
 * }
 *
 * // Args for a POST request with a body
 * const postArgs: InvokeArgs = {
 *   url: '/users',
 *   data: { name: 'Alice' },
 *   config: { headers: { 'Content-Type': 'application/json' } },
 * }
 * ```
 */
export interface InvokeArgs {
  config: AxiosRequestConfig
  url?: string
  data?: unknown
}

/**
 * Base class that exposes the {@link HttpServiceLike} verb surface and routes
 * every call through the protected {@link dispatch} template method.
 *
 * Subclasses layer cross-cutting concerns (resilience policies, authentication,
 * instrumentation, …) by overriding {@link dispatch} and adding their own
 * "around" semantics — e.g. wrapping the entire flow in `policy.execute(...)`
 * or recovering from a 401 by replaying the underlying transport call with
 * refreshed credentials.
 *
 * Each verb method materialises the canonical {@link InvokeArgs} carrier for
 * its argument shape (`request` → `{ config }`; `(url, config?)` verbs →
 * `{ url, config }`; data verbs → `{ url, data, config }`) and forwards to
 * {@link dispatch}, which calls the underlying transport via
 * {@link callUnderlying}.
 *
 * The `httpService` reference is `protected readonly` so subclasses (e.g. a
 * future logging facade) can read it without dropping back to a wider cast,
 * but the field is never re-assigned after construction.
 *
 * @example
 * ```ts
 * import { Injectable } from '@nestjs/common'
 * import type { AxiosResponse } from 'axios'
 * import { BaseHttpService, type HttpVerb, type InvokeArgs } from 'nestjs-http-client'
 *
 * // Logging facade: records every verb invocation and the resulting status
 * @Injectable()
 * export class LoggingRestClient extends BaseHttpService {
 *   protected override async dispatch<T = unknown>(
 *     verb: HttpVerb,
 *     args: InvokeArgs,
 *   ): Promise<AxiosResponse<T>> {
 *     const startedAt = Date.now()
 *     try {
 *       const response = await super.dispatch<T>(verb, args)
 *       console.log(`[http] ${verb.toUpperCase()} -> ${response.status} (${Date.now() - startedAt}ms)`)
 *       return response
 *     }
 *     catch (error) {
 *       console.error(`[http] ${verb.toUpperCase()} failed after ${Date.now() - startedAt}ms`, error)
 *       throw error
 *     }
 *   }
 * }
 * ```
 */
export abstract class BaseHttpService {
  /**
   * Underlying transport this facade wraps. Stored as the structural
   * {@link HttpServiceLike} so the same dispatcher works for `HttpService`
   * (returns `Observable`) and for {@link RestClient} (returns `Promise`).
   */
  protected readonly httpService: HttpServiceLike

  /**
   * Optional RxJS pipeline applied to `Observable<AxiosResponse>` results from
   * the underlying transport BEFORE they are normalised via `firstValueFrom`.
   *
   * The slot lets reactive resilience operators (deduplication, rate limiting,
   * throttling) interpose on the source stream without leaking those concerns
   * into {@link callUnderlying}. The pipeline is applied ONLY when the
   * underlying transport returns an `Observable`; transports that return a
   * `Promise` (e.g. {@link RestClient} when wrapped by {@link AuthRestClient})
   * skip the pipeline entirely.
   */
  protected readonly rxjsPipeline?: RxjsPipeline

  constructor(httpService: HttpServiceLike, rxjsPipeline?: RxjsPipeline) {
    this.httpService = httpService
    this.rxjsPipeline = rxjsPipeline
  }

  /**
   * Dispatches a verb to the underlying transport. The default implementation
   * delegates straight to {@link callUnderlying}; subclasses override this to
   * add "around" behaviour (e.g. wrapping the whole flow in
   * `policy.execute(...)` or recovering from a 401 by retrying with refreshed
   * credentials).
   *
   * @example
   * ```ts
   * import type { AxiosResponse } from 'axios'
   * import { BaseHttpService, type HttpVerb, type InvokeArgs } from 'nestjs-http-client'
   *
   * class TimingClient extends BaseHttpService {
   *   protected override async dispatch<T = unknown>(
   *     verb: HttpVerb,
   *     args: InvokeArgs,
   *   ): Promise<AxiosResponse<T>> {
   *     const start = Date.now()
   *     const response = await super.dispatch<T>(verb, args)
   *     console.log(`${verb} completed in ${Date.now() - start}ms with status ${response.status}`)
   *     return response
   *   }
   * }
   * ```
   */
  protected async dispatch<T = unknown>(
    verb: HttpVerb,
    args: InvokeArgs,
  ): Promise<AxiosResponse<T>> {
    return this.callUnderlying<T>(verb, args)
  }

  /**
   * Invokes the underlying transport for `verb` with the carrier args. Splits
   * the args into the verb-specific positional shape (`request(config)` vs
   * `get(url, config)` vs `post(url, data, config)`) and normalises the
   * return value: `Observable<AxiosResponse>` is awaited via `firstValueFrom`,
   * `Promise<AxiosResponse>` is awaited directly.
   *
   * Centralising the verb-shape mapping here keeps the {@link dispatch}
   * lifecycle agnostic of axios's call conventions and lets subclasses that
   * override `dispatch` reuse the same call resolution.
   *
   * @example
   * ```ts
   * import type { AxiosResponse } from 'axios'
   * import { BaseHttpService, type HttpVerb, type InvokeArgs } from 'nestjs-http-client'
   *
   * class RetryOnceClient extends BaseHttpService {
   *   protected override async dispatch<T = unknown>(
   *     verb: HttpVerb,
   *     args: InvokeArgs,
   *   ): Promise<AxiosResponse<T>> {
   *     try {
   *       return await this.callUnderlying<T>(verb, args)
   *     }
   *     catch {
   *       // Naive single-retry — call the underlying transport a second time
   *       return await this.callUnderlying<T>(verb, args)
   *     }
   *   }
   * }
   * ```
   */
  protected async callUnderlying<T = unknown>(
    verb: HttpVerb,
    args: InvokeArgs,
  ): Promise<AxiosResponse<T>> {
    const result = invokeVerb(this.httpService, verb, args)
    if (isObservable(result)) {
      // Apply the RxJS pipeline (deduplication / rate-limiting / throttling)
      // ONLY on the reactive path — Promise-returning transports (e.g. the
      // RestClient wrapped by AuthRestClient) keep their existing behaviour
      // because the pipeline contract is defined over `Observable`.
      const source = result as Observable<AxiosResponse<T>>
      const piped = this.rxjsPipeline
        ? (this.rxjsPipeline(verb, args, source as Observable<AxiosResponse>) as Observable<AxiosResponse<T>>)
        : source
      return await firstValueFrom(piped)
    }
    return await (result as Promise<AxiosResponse<T>>)
  }

  /**
   * Underlying axios instance — exposed for adapter-level interop (e.g.
   * registering interceptors or reading the adapter configuration in tests).
   *
   * @example
   * ```ts
   * import { RestClient } from 'nestjs-http-client'
   *
   * // Register a request interceptor on the underlying axios instance
   * const client = new RestClient(httpService)
   * client.axiosRef.interceptors.request.use((config) => {
   *   config.headers['X-Request-Id'] = crypto.randomUUID()
   *   return config
   * })
   * ```
   */
  get axiosRef(): AxiosInstance {
    return this.httpService.axiosRef
  }

  /**
   * Sends an HTTP request using a full `AxiosRequestConfig` object. Use this
   * when none of the convenience verb methods (`get`, `post`, …) fit — for
   * example when the method is determined at runtime or when you need to set
   * low-level axios options not exposed on the per-verb helpers.
   *
   * @example
   * ```ts
   * const response = await client.request<User>({
   *   method: 'GET',
   *   url: '/users/42',
   *   headers: { Accept: 'application/json' },
   * })
   * console.log(response.data.name)
   * ```
   */
  request<T = any>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.dispatch<T>('request', { config })
  }

  /**
   * Sends an HTTP `GET` request to `url`.
   *
   * @example
   * ```ts
   * interface Product { id: string; name: string }
   *
   * const response = await client.get<Product>('/products/42')
   * console.log(response.data.name) // 'Widget'
   * ```
   */
  get<T = any, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.dispatch<T>('get', { url, config: (config ?? {}) as AxiosRequestConfig }) as Promise<AxiosResponse<T, D>>
  }

  /**
   * Sends an HTTP `DELETE` request to `url`.
   *
   * @example
   * ```ts
   * await client.delete('/products/42')
   * // resource deleted; 204 No Content expected
   * ```
   */
  delete<T = any, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.dispatch<T>('delete', { url, config: (config ?? {}) as AxiosRequestConfig }) as Promise<AxiosResponse<T, D>>
  }

  /**
   * Sends an HTTP `HEAD` request to `url`. Useful for checking whether a
   * resource exists without downloading the response body.
   *
   * @example
   * ```ts
   * const response = await client.head('/products/42')
   * console.log(response.status) // 200 if the product exists
   * ```
   */
  head<T = any, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.dispatch<T>('head', { url, config: (config ?? {}) as AxiosRequestConfig }) as Promise<AxiosResponse<T, D>>
  }

  /**
   * Sends an HTTP `POST` request to `url` with an optional request body.
   *
   * @example
   * ```ts
   * interface CreateProductDto { name: string; price: number }
   * interface Product { id: string; name: string; price: number }
   *
   * const response = await client.post<Product, CreateProductDto>(
   *   '/products',
   *   { name: 'Widget', price: 9.99 },
   * )
   * console.log(response.data.id) // server-assigned ID
   * ```
   */
  post<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.dispatch<T>('post', { url, data, config: (config ?? {}) as AxiosRequestConfig }) as Promise<AxiosResponse<T, D>>
  }

  /**
   * Sends an HTTP `PUT` request to `url`, replacing the entire resource.
   *
   * @example
   * ```ts
   * await client.put('/products/42', { name: 'Widget v2', price: 12.99 })
   * ```
   */
  put<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.dispatch<T>('put', { url, data, config: (config ?? {}) as AxiosRequestConfig }) as Promise<AxiosResponse<T, D>>
  }

  /**
   * Sends an HTTP `PATCH` request to `url`, applying a partial update.
   *
   * @example
   * ```ts
   * await client.patch('/products/42', { price: 11.50 })
   * ```
   */
  patch<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.dispatch<T>('patch', { url, data, config: (config ?? {}) as AxiosRequestConfig }) as Promise<AxiosResponse<T, D>>
  }

  /**
   * Sends an HTTP `POST` request with the body serialised as
   * `application/x-www-form-urlencoded`. Useful for APIs that expect
   * form-encoded payloads rather than JSON.
   *
   * @example
   * ```ts
   * await client.postForm('/oauth/token', {
   *   grant_type: 'client_credentials',
   *   client_id: 'my-app',
   *   client_secret: 's3cr3t',
   * })
   * ```
   */
  postForm<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.dispatch<T>('postForm', { url, data, config: (config ?? {}) as AxiosRequestConfig }) as Promise<AxiosResponse<T, D>>
  }

  /**
   * Sends an HTTP `PUT` request with the body serialised as
   * `application/x-www-form-urlencoded`.
   *
   * @example
   * ```ts
   * await client.putForm('/settings/42', { theme: 'dark', language: 'en' })
   * ```
   */
  putForm<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.dispatch<T>('putForm', { url, data, config: (config ?? {}) as AxiosRequestConfig }) as Promise<AxiosResponse<T, D>>
  }

  /**
   * Sends an HTTP `PATCH` request with the body serialised as
   * `application/x-www-form-urlencoded`.
   *
   * @example
   * ```ts
   * await client.patchForm('/settings/42', { theme: 'light' })
   * ```
   */
  patchForm<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.dispatch<T>('patchForm', { url, data, config: (config ?? {}) as AxiosRequestConfig }) as Promise<AxiosResponse<T, D>>
  }
}

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
  /**
   * User-supplied hook configuration. Stored as `protected readonly` so
   * subclasses (or test doubles) can introspect the configuration without
   * dropping back to a wider cast, but the field is never re-assigned after
   * construction.
   */
  protected readonly hooks: HooksConfig

  constructor(
    httpService: HttpServiceLike,
    hooks?: HooksConfig,
    rxjsPipeline?: RxjsPipeline,
  ) {
    // Forward the rxjsPipeline to BaseHttpService so the reactive pipeline
    // (deduplication / rate limiting / throttling) is applied inside
    // `callUnderlying`. Hooks live one layer above — they wrap the entire
    // dispatch (including the pipeline-aware call into the transport).
    super(httpService, rxjsPipeline)
    // Default to an empty object so the dispatch override can read
    // `this.hooks.onInvoke` without a separate undefined-guard on every call.
    this.hooks = hooks ?? {}
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

/**
 * Dispatches a verb on the underlying transport with the verb-specific
 * positional argument shape. Extracted as a free function so the verb-shape
 * mapping lives in exactly one place — adding a new verb (e.g. `options`)
 * means extending the union and one switch arm here.
 *
 * Returns whatever the upstream transport returned (typically an
 * `Observable<AxiosResponse>` or a `Promise<AxiosResponse>`); the caller is
 * responsible for normalising the wrapper.
 */
function invokeVerb(
  http: HttpServiceLike,
  verb: HttpVerb,
  args: InvokeArgs,
): unknown {
  const { config, url, data } = args
  switch (verb) {
    case 'request':
      return http.request(config)
    case 'get':
      return http.get(url as string, config)
    case 'delete':
      return http.delete(url as string, config)
    case 'head':
      return http.head(url as string, config)
    case 'post':
      return http.post(url as string, data, config)
    case 'put':
      return http.put(url as string, data, config)
    case 'patch':
      return http.patch(url as string, data, config)
    case 'postForm':
      return http.postForm(url as string, data, config)
    case 'putForm':
      return http.putForm(url as string, data, config)
    case 'patchForm':
      return http.patchForm(url as string, data, config)
  }
}
