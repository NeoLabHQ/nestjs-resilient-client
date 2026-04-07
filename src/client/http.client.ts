import type { HttpService } from "@nestjs/axios";
import { Logger } from "@nestjs/common";
import type { Loggable } from "nestjs-log-decorator";
import { isAxiosError, type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from "axios";
import { firstValueFrom, Observable } from "rxjs";
import { circuitBreaker, ExponentialBackoff, handleAll, handleWhen, retry, SamplingBreaker, wrap, type IDefaultPolicyContext, type IPolicy } from "cockatiel";
import { resiliencePolicyPresets } from "../resilence.policy";
import { resiliencePolicyBuilder } from "./resailencePolicyBuilder";
import type { ResilanceConfig } from "./resilance.config";


export class HttpClient implements Loggable {
  readonly logger: Logger;
  readonly policy: IPolicy<IDefaultPolicyContext, number>;

  constructor(private readonly httpService: HttpService, apiName: string, private readonly config: ResilanceConfig<number, void, number> = resiliencePolicyPresets[ResilencePresets.CONSERVATIVE]) {
    this.logger = new Logger(`${apiName}:API`);

    this.policy = resiliencePolicyBuilder(config);
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

  // TODO: make it decorator, instead of private method
  private async executeRequest<T>(requestFactory: (ctx: IDefaultPolicyContext) => Observable<AxiosResponse<T>>): Promise<AxiosResponse<T>> {
    return await this.policy.execute(async (ctx) => 
        await firstValueFrom(requestFactory(ctx))
    );
  }
}



