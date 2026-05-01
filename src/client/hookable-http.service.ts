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
import { firstValueFrom, isObservable } from 'rxjs'

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
 * satisfy this shape, so {@link HookableHttpService} can wrap either without
 * importing one from the other.
 *
 * The verb returns are typed as `unknown` because the upstream transports use
 * incompatible reactive-vs-promise wrappers; {@link HookableHttpService}
 * normalises the result via `firstValueFrom` when the value is an `Observable`.
 * Consumers of {@link HookableHttpService.callUnderlying} never see the raw
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
 * {@link HookableHttpService.dispatch}. `url` and `data` are optional because
 * not every verb owns those slots (`request` carries everything in `config`;
 * verbs in the `(url, config?)` family own `url` but not `data`).
 *
 * Subclasses that override {@link HookableHttpService.dispatch} treat this
 * carrier as immutable — produce a new object when any field needs to change
 * before forwarding to {@link HookableHttpService.callUnderlying}.
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
 * import { HookableHttpService, type HttpVerb, type InvokeArgs } from 'nestjs-http-client'
 *
 * // Logging facade: records every verb invocation and the resulting status
 * @Injectable()
 * export class LoggingRestClient extends HookableHttpService {
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
export abstract class HookableHttpService {
  /**
   * Underlying transport this facade wraps. Stored as the structural
   * {@link HttpServiceLike} so the same dispatcher works for `HttpService`
   * (returns `Observable`) and for {@link RestClient} (returns `Promise`).
   */
  protected readonly httpService: HttpServiceLike

  constructor(httpService: HttpServiceLike) {
    this.httpService = httpService
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
   * import { HookableHttpService, type HttpVerb, type InvokeArgs } from 'nestjs-http-client'
   *
   * class TimingClient extends HookableHttpService {
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
   * import { HookableHttpService, type HttpVerb, type InvokeArgs } from 'nestjs-http-client'
   *
   * class RetryOnceClient extends HookableHttpService {
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
      return await firstValueFrom(result as never) as AxiosResponse<T>
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
