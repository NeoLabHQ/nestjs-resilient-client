import type { HttpService } from '@nestjs/axios'
import { Logger } from '@nestjs/common'
import type {
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
} from 'axios'
import type {
  IDefaultPolicyContext,
  IPolicy,
} from 'cockatiel'
import type { Loggable } from 'nestjs-log-decorator'

import { resiliencePolicyPresets, ResilencePresets } from '../resilence.policy'
import { ExecuteWithPolicy } from './execute-with-policy.decorator'
import { resiliencePolicyBuilder } from './resailencePolicyBuilder'
import type { ResilanceConfig } from './resilance.config'

/**
 * Resilient HTTP client that wraps `@nestjs/axios`'s `HttpService` and runs
 * every request through a composed cockatiel `IPolicy`.
 *
 * Each verb method delegates to the underlying `HttpService` (which returns an
 * `Observable<AxiosResponse>`); the `@ExecuteWithPolicy` decorator wraps that
 * Observable in `policy.execute` and unwraps it via `firstValueFrom`, so the
 * publicly observable return type is `Promise<AxiosResponse<...>>`.
 *
 * The `policy` field is public (read-only) because `@ExecuteWithPolicy` reads
 * it from the instance at call time via `context.target.policy`.
 */
export class RestClient implements Loggable {
  /** NestJS logger; required by `Loggable` from `nestjs-log-decorator`. */
  readonly logger: Logger = new Logger(RestClient.name)

  /**
   * Composed resilience policy used by `@ExecuteWithPolicy` to wrap every
   * request. Public so the decorator can read it from the instance via
   * `context.target.policy` on each invocation. The `any` result-type on
   * `IPolicy` mirrors the heterogeneous `AxiosResponse<T, D>` shapes that flow
   * through every verb.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPolicy result type must be `any` because per-verb response shapes vary across calls
  readonly policy: IPolicy<IDefaultPolicyContext, any>

  constructor(
    private readonly httpService: HttpService,
    config: ResilanceConfig<unknown> = resiliencePolicyPresets[ResilencePresets.CONSERVATIVE],
  ) {
    this.policy = resiliencePolicyBuilder(config)
  }

  /** Underlying axios instance — exposed for adapter-level interop. */
  get axiosRef(): AxiosInstance {
    return this.httpService.axiosRef
  }

  // Each verb below returns the Observable from `HttpService`; the decorator
  // unwraps it via `firstValueFrom` and wraps the call in `policy.execute`,
  // so the *runtime* return value is a `Promise<AxiosResponse<...>>`.
  // The cast to `Promise<...>` aligns the *declared* type with that runtime
  // contract (matching the RestClient Contract in the task spec).
  // The `request` propertyKey is special-cased by the decorator to inject
  // `policyCtx.signal` into args[0] so axios receives a cancellable signal.

  @ExecuteWithPolicy()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors HttpService.request<T = any>; restructuring to `unknown` would force every consumer to narrow `response.data` even when calling without an explicit type arg, breaking API parity with @nestjs/axios
  request<T = any>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.httpService.request<T>(config) as unknown as Promise<AxiosResponse<T>>
  }

  @ExecuteWithPolicy()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors HttpService.get<T = any, D = any>; see `request` for rationale
  get<T = any, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.httpService.get<T, D>(url, config) as unknown as Promise<AxiosResponse<T, D>>
  }

  @ExecuteWithPolicy()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors HttpService.delete<T = any, D = any>; see `request` for rationale
  delete<T = any, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.httpService.delete<T, D>(url, config) as unknown as Promise<AxiosResponse<T, D>>
  }

  @ExecuteWithPolicy()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors HttpService.head<T = any, D = any>; see `request` for rationale
  head<T = any, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.httpService.head<T, D>(url, config) as unknown as Promise<AxiosResponse<T, D>>
  }

  @ExecuteWithPolicy()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors HttpService.post<T = any, D = any>; see `request` for rationale
  post<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.httpService.post<T, D>(url, data, config) as unknown as Promise<AxiosResponse<T, D>>
  }

  @ExecuteWithPolicy()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors HttpService.put<T = any, D = any>; see `request` for rationale
  put<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.httpService.put<T, D>(url, data, config) as unknown as Promise<AxiosResponse<T, D>>
  }

  @ExecuteWithPolicy()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors HttpService.patch<T = any, D = any>; see `request` for rationale
  patch<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.httpService.patch<T, D>(url, data, config) as unknown as Promise<AxiosResponse<T, D>>
  }

  @ExecuteWithPolicy()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors HttpService.postForm<T = any, D = any>; see `request` for rationale
  postForm<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.httpService.postForm<T, D>(url, data, config) as unknown as Promise<AxiosResponse<T, D>>
  }

  @ExecuteWithPolicy()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors HttpService.putForm<T = any, D = any>; see `request` for rationale
  putForm<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.httpService.putForm<T, D>(url, data, config) as unknown as Promise<AxiosResponse<T, D>>
  }

  @ExecuteWithPolicy()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors HttpService.patchForm<T = any, D = any>; see `request` for rationale
  patchForm<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return this.httpService.patchForm<T, D>(url, data, config) as unknown as Promise<AxiosResponse<T, D>>
  }
}
