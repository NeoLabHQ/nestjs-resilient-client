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

  /** Underlying axios instance — exposed for adapter-level interop. */
  get axiosRef(): AxiosInstance {
    return this.httpService.axiosRef
  }

  request<T = any>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.dispatch<T>('request', { config })
  }

  get<T = any, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.dispatch<T>('get', { url, config: (config ?? {}) as AxiosRequestConfig }) as Promise<AxiosResponse<T, D>>
  }

  delete<T = any, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.dispatch<T>('delete', { url, config: (config ?? {}) as AxiosRequestConfig }) as Promise<AxiosResponse<T, D>>
  }

  head<T = any, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.dispatch<T>('head', { url, config: (config ?? {}) as AxiosRequestConfig }) as Promise<AxiosResponse<T, D>>
  }

  post<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.dispatch<T>('post', { url, data, config: (config ?? {}) as AxiosRequestConfig }) as Promise<AxiosResponse<T, D>>
  }

  put<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.dispatch<T>('put', { url, data, config: (config ?? {}) as AxiosRequestConfig }) as Promise<AxiosResponse<T, D>>
  }

  patch<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.dispatch<T>('patch', { url, data, config: (config ?? {}) as AxiosRequestConfig }) as Promise<AxiosResponse<T, D>>
  }

  postForm<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.dispatch<T>('postForm', { url, data, config: (config ?? {}) as AxiosRequestConfig }) as Promise<AxiosResponse<T, D>>
  }

  putForm<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.dispatch<T>('putForm', { url, data, config: (config ?? {}) as AxiosRequestConfig }) as Promise<AxiosResponse<T, D>>
  }

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
