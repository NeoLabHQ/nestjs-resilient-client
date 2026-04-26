import type {
  AxiosRequestConfig,
  AxiosResponse,
} from 'axios'

import type { RestClient } from '../client/rest.client'
import type { AuthStrategyService } from './auth-strategy.service'
import { Authenticate } from './authenticate.decorator'

/**
 * Authenticated HTTP client. Composes a {@link RestClient} (which owns the
 * resilience policy stack) with an {@link AuthStrategyService} (which owns
 * the authentication lifecycle) and decorates every request method with
 * `@Authenticate` so that:
 *
 * 1. `authStrategy.authenticateIfNeeded()` runs before each request.
 * 2. The request config is augmented via `authStrategy.extendRequest(config)`.
 * 3. A single HTTP 401 response triggers `authStrategy.clearAuth()`,
 *    a forced re-authentication, and a single retry of the underlying
 *    {@link RestClient} call.
 *
 * Each verb is a thin forwarder to the corresponding {@link RestClient}
 * method. The class intentionally introduces NO new resilience logic — it
 * only layers authentication on top of the existing resilient transport.
 *
 * **NFR — zero `rxjs` and zero `p-retry` imports anywhere in `src/auth/`.**
 * This class does not import either: `rxjs` is consumed inside `RestClient`
 * via the `@ExecuteWithPolicy` decorator, and `p-retry` is no longer used
 * anywhere in the auth layer (the resilience pipeline owns retry semantics).
 *
 * The {@link authStrategy} field is `public readonly` because the
 * `@Authenticate` decorator reads it from the instance at call time via
 * `context.target.authStrategy` (no reflection, no DI metadata).
 */
export class AuthRestClient {
  /**
   * Public-readable authentication strategy. Required public so the
   * `@Authenticate` decorator can read it from the instance at invocation
   * time via `context.target.authStrategy`.
   */
  readonly authStrategy: AuthStrategyService

  constructor(
    private readonly restClient: RestClient,
    authStrategy: AuthStrategyService,
  ) {
    this.authStrategy = authStrategy
  }

  // Each verb is a thin forwarder to `this.restClient.<verb>(...)` decorated
  // with `@Authenticate()`. The same generic signatures as `RestClient` are
  // used so that the public surface is interchangeable from a caller's
  // perspective. The `@Authenticate` decorator handles config-arg extension
  // and 401 retry; this class adds nothing beyond delegation.

  @Authenticate()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors RestClient.request<T = any>; switching to `unknown` would force callers to narrow `response.data` and would break API parity with the wrapped RestClient
  request<T = any>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.restClient.request<T>(config)
  }

  @Authenticate()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors RestClient.get<T = any, D = any>; see `request` for rationale
  get<T = any, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.restClient.get<T, D>(url, config)
  }

  @Authenticate()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors RestClient.delete<T = any, D = any>; see `request` for rationale
  delete<T = any, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.restClient.delete<T, D>(url, config)
  }

  @Authenticate()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors RestClient.head<T = any, D = any>; see `request` for rationale
  head<T = any, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.restClient.head<T, D>(url, config)
  }

  @Authenticate()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors RestClient.post<T = any, D = any>; see `request` for rationale
  post<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.restClient.post<T, D>(url, data, config)
  }

  @Authenticate()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors RestClient.put<T = any, D = any>; see `request` for rationale
  put<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.restClient.put<T, D>(url, data, config)
  }

  @Authenticate()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors RestClient.patch<T = any, D = any>; see `request` for rationale
  patch<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.restClient.patch<T, D>(url, data, config)
  }

  @Authenticate()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors RestClient.postForm<T = any, D = any>; see `request` for rationale
  postForm<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.restClient.postForm<T, D>(url, data, config)
  }

  @Authenticate()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors RestClient.putForm<T = any, D = any>; see `request` for rationale
  putForm<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.restClient.putForm<T, D>(url, data, config)
  }

  @Authenticate()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors RestClient.patchForm<T = any, D = any>; see `request` for rationale
  patchForm<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.restClient.patchForm<T, D>(url, data, config)
  }
}
