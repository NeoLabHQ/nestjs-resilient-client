import type { HttpService } from "@nestjs/axios";
import { Logger } from "@nestjs/common";
import type { Loggable } from "nestjs-log-decorator";
import { isAxiosError, type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from "axios";
import { firstValueFrom, Observable } from "rxjs";
import { bulkhead, circuitBreaker, ExponentialBackoff, fallback, handleAll, handleWhen, retry, SamplingBreaker, wrap, type IDefaultPolicyContext } from "cockatiel";


export class HttpClient implements Loggable {
  readonly logger: Logger;

  constructor(private readonly httpService: HttpService, apiName: string) {
    this.logger = new Logger(`${apiName}:API`);
  }

  async request<T = any>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return await this.executeRequest(({signal}) => this.httpService.request<T>({
        ...config,
        signal,
    }));
  }

  async get<T = any, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return await this.executeRequest(() => this.httpService.get<T, D>(url, config));
  }

  async delete<T = any, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return await this.executeRequest(() => this.httpService.delete<T, D>(url, config));
  }

  async head<T = any, D = any>(url: string, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return await this.executeRequest(() => this.httpService.head<T, D>(url, config));
  }

  async post<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return await this.executeRequest(() => this.httpService.post<T, D>(url, data, config));
  }

  async put<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return await this.executeRequest(() => this.httpService.put<T, D>(url, data, config));
  }

  async patch<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return await this.executeRequest(() => this.httpService.patch<T, D>(url, data, config));
  }
  
  async postForm<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return await this.executeRequest(() => this.httpService.postForm<T, D>(url, data, config));
  }

  async putForm<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return await this.executeRequest(() => this.httpService.putForm<T, D>(url, data, config));
  }

  async patchForm<T = any, D = any>(url: string, data?: D, config?: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>> {
    return await this.executeRequest(() => this.httpService.patchForm<T, D>(url, data, config));
  }

  get axiosRef(): AxiosInstance {
    return this.httpService.axiosRef;
  }

  private async executeRequest<T>(requestFactory: (ctx: IDefaultPolicyContext) => Observable<AxiosResponse<T>>): Promise<AxiosResponse<T>> {
    // Create a retry policy that'll try whatever function we execute 3
    // times with a randomized exponential backoff.
    const retryPolicy = retry(handleWhen(isRetryableError), { maxAttempts: 3, backoff: new ExponentialBackoff() });

    const circuitBreakerPolicy = circuitBreaker(handleAll, {
        // Create a circuit breaker that'll stop calling the executed function
        // for 60 seconds
        halfOpenAfter: 60 * 1000,
        // if all requests fail in a 60 second time window, with at least 100 requests per second:
        breaker: new SamplingBreaker({ threshold: 1, duration: 60 * 1000, minimumRps: 100 }),
    });
    // This can give time another service
    // to recover without getting tons of traffic.

    // Combine policies in reverse order: circuit breaker will be executed on each retry attempt
    const retryWithBreaker = wrap(retryPolicy, circuitBreakerPolicy);

    return await retryWithBreaker.execute(async (ctx) => 
        await firstValueFrom(requestFactory(ctx))
    );
  }
}

// Censervativly idempotent methods (not fully RESTfull)
const RETRYABLE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

export function isRetryableError(error: Error): boolean {
    // Not an axios error - retry (network/timeout errors)
    if (!isAxiosError(error)) {
        return true;
    }

    // Retry only for idempotent methods
    const method = error.config?.method?.toUpperCase() ?? '';
    if (!method || !RETRYABLE_METHODS.includes(method)) {
        return false;
    }
  
    // Network/timeout errors (no response)
    if (!error.response) {
        return true;
    }

    // 5xx server errors
    const status = error.response.status;
    return status >= 500 && status < 600;
}