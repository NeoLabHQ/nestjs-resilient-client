import type { HttpService } from '@nestjs/axios'
import { Logger } from '@nestjs/common'
import type { AxiosRequestConfig, AxiosResponse } from 'axios'
import type {
  IDefaultPolicyContext,
  IPolicy,
} from 'cockatiel'
import type { Loggable } from 'nestjs-log-decorator'

import { ResilencePresets } from '../resilence.policy'
import { HookableHttpService, type HttpVerb, type InvokeArgs } from './hookable-http.service'
import { resiliencePolicyBuilder } from './resailencePolicyBuilder'
import type { ResilanceConfig } from './resilance.config'

/**
 * Composes the user-supplied `AbortSignal` (if any) with cockatiel's policy
 * signal so that BOTH abort sources can cancel the in-flight axios request:
 * cockatiel's retries/timeouts/circuit-breakers, AND any external cancellation
 * the caller wired into their config.
 *
 * Composition uses `AbortSignal.any([userSignal, policySignal])` (Node 20+)
 * when available. On older runtimes that lack `AbortSignal.any`, the policy
 * signal is preferred — cockatiel owns the resilience contract and consumers
 * who pass their own signal explicitly are expected to be on a runtime that
 * supports composition.
 *
 * The user's `AxiosRequestConfig` is treated as immutable: the merge always
 * produces a NEW object via spread (`{ ...userConfig, signal: ... }`) so retry
 * paths can re-merge from the original config without seeing the previous
 * attempt's signal.
 */
function mergeSignal(
  userConfig: AxiosRequestConfig,
  policySignal: AbortSignal,
): AxiosRequestConfig {
  const userSignal = userConfig.signal as AbortSignal | undefined

  if (userSignal === undefined) {
    return { ...userConfig, signal: policySignal }
  }

  // `AbortSignal.any` is Node 20+ / modern browsers. The runtime check keeps
  // the merge defensive against environments without it: in that (vanishingly
  // rare) case the policy signal wins, since cockatiel's
  // retry/timeout/circuit-breaker contract is the load-bearing one.
  const composer = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  if (typeof composer === 'function') {
    return { ...userConfig, signal: composer.call(AbortSignal, [userSignal, policySignal]) }
  }

  return { ...userConfig, signal: policySignal }
}

/**
 * Resilient HTTP client that wraps `@nestjs/axios`'s `HttpService` and runs
 * every request through a composed cockatiel `IPolicy`.
 *
 * `RestClient` extends {@link HookableHttpService} for the verb surface and
 * overrides {@link HookableHttpService.dispatch} to wrap every dispatch in
 * `policy.execute(...)`. The `signal` from cockatiel's policy context is
 * forwarded into the verb's `AxiosRequestConfig` slot so retries, timeouts,
 * and circuit-breakers can cancel in-flight axios requests cooperatively.
 *
 * The {@link policy} field is `public readonly` so external consumers can
 * inspect or instrument the composed policy (e.g. for circuit-breaker state
 * snapshots). The field is initialised once in the constructor — there is no
 * supported runtime mutation path.
 */
export class RestClient extends HookableHttpService implements Loggable {
  /** NestJS logger; required by `Loggable` from `nestjs-log-decorator`. */
  readonly logger: Logger = new Logger(RestClient.name)

  /**
   * Composed resilience policy used by {@link dispatch} to wrap every
   * request. The `any` result-type on `IPolicy` mirrors the heterogeneous
   * `AxiosResponse<T, D>` shapes that flow through every verb.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPolicy result type must be `any` because per-verb response shapes vary across calls
  readonly policy: IPolicy<IDefaultPolicyContext, any>

  constructor(
    httpService: HttpService,
    config: ResilanceConfig<unknown> = ResilencePresets.CONSERVATIVE,
  ) {
    super(httpService)
    this.policy = resiliencePolicyBuilder(config)
  }

  /**
   * Wraps the base dispatch in `policy.execute(...)`. The policy's
   * `signal` is merged into `args.config` for each (re-)attempt so axios
   * observes a fresh signal on every retry — cockatiel issues a new context
   * (and therefore a new signal) per attempt, which is exactly what
   * cooperative cancellation requires.
   *
   * Caller-supplied signals are composed with the policy signal via
   * `AbortSignal.any` so external cancellation continues to abort the request
   * alongside cockatiel-driven aborts.
   */
  protected override async dispatch<T = unknown>(
    verb: HttpVerb,
    initialArgs: InvokeArgs,
  ): Promise<AxiosResponse<T>> {
    return await this.policy.execute(async (policyCtx) => {
      const argsWithSignal: InvokeArgs = {
        ...initialArgs,
        config: mergeSignal(initialArgs.config, policyCtx.signal),
      }
      return await super.dispatch<T>(verb, argsWithSignal)
    }) as AxiosResponse<T>
  }
}
