import type { HttpService } from '@nestjs/axios'
import { Logger } from '@nestjs/common'
import type { AxiosRequestConfig, AxiosResponse } from 'axios'
import type {
  IDefaultPolicyContext,
  IPolicy,
} from 'cockatiel'
import type { Loggable } from 'nestjs-log-decorator'

import { ResilencePresets } from '../resilence.policy'
import type { HttpVerb, InvokeArgs } from './base-http.service'
import { HookableHttpService, type HooksConfig } from './hookable-http.service'
import { resiliencePolicyBuilder } from './resailencePolicyBuilder'
import type { ResilanceConfig } from './resilance.config'
import { buildRxjsPipeline } from './rxjs-pipeline'

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
 * `RestClient` extends {@link HookableHttpService} for the verb surface plus
 * the {@link HooksConfig} lifecycle (`onInvoke` / `onReturn` / `onError`), and
 * overrides `dispatch` to wrap every invocation in `policy.execute(...)`. The
 * `signal` from cockatiel's policy context is forwarded into the verb's
 * `AxiosRequestConfig` slot so retries, timeouts, and circuit-breakers can
 * cancel in-flight axios requests cooperatively.
 *
 * Because the override calls `super.dispatch(verb, args)` from inside
 * `policy.execute(...)`, the hook lifecycle runs INSIDE the resilience
 * pipeline — every retry attempt re-invokes `onInvoke`, observes the
 * (possibly hook-transformed) args, and routes the response through `onReturn`
 * (or `onError`). This is the contract pinned by AC-21.
 *
 * The {@link policy} field is `public readonly` so external consumers can
 * inspect or instrument the composed policy (e.g. for circuit-breaker state
 * snapshots). The field is initialised once in the constructor — there is no
 * supported runtime mutation path.
 *
 * @example
 * ```ts
 * import { Module } from '@nestjs/common'
 * import { RestModule, RestClient, ResilencePresets } from 'nestjs-http-client'
 *
 * // Inject RestClient via RestModule (recommended).
 * // RestModule.forRootAsync handles HttpModule registration and wiring.
 * @Module({
 *   imports: [
 *     RestModule.forRootAsync({
 *       useFactory: () => ({
 *         axios: { baseURL: 'https://api.example.com' },
 *         resilience: ResilencePresets.RESTFULL,
 *       }),
 *     }),
 *   ],
 * })
 * export class AppModule {}
 *
 * // Or construct directly when you already have an HttpService.
 * // The response type parameter narrows `response.data` to `{ id: number; name: string }`.
 * const client = new RestClient(httpService, ResilencePresets.CONSERVATIVE)
 * const response = await client.get<{ id: number; name: string }>('/products/42')
 * console.log(response.data.name) // 'Widget'
 * ```
 */
export class RestClient extends HookableHttpService implements Loggable {
  /** NestJS logger; required by `Loggable` from `nestjs-log-decorator`. */
  readonly logger: Logger = new Logger(RestClient.name)

  /**
   * Composed resilience policy used by {@link dispatch} to wrap every
   * request. The `any` result-type on `IPolicy` mirrors the heterogeneous
   * `AxiosResponse<T, D>` shapes that flow through every verb.
   *
   * The field is `public readonly` so external consumers can introspect the
   * composed policy — for example, to read circuit-breaker state or attach
   * event listeners for observability.
   *
   * @example
   * ```ts
   * import { CircuitBreakerPolicy } from 'cockatiel'
   * import { RestClient, ResilencePresets } from 'nestjs-http-client'
   *
   * const client = new RestClient(httpService, ResilencePresets.CONSERVATIVE)
   *
   * // Inspect the composed policy at runtime.
   * // CircuitBreakerPolicy exposes a `.state` getter for diagnostics.
   * if (client.policy instanceof CircuitBreakerPolicy) {
   *   console.log('circuit state:', client.policy.state)
   * }
   * ```
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPolicy result type must be `any` because per-verb response shapes vary across calls
  readonly policy: IPolicy<IDefaultPolicyContext, any>

  /**
   * @param httpService Upstream `@nestjs/axios` HTTP transport.
   * @param config Resilience pipeline configuration. Defaults to
   *   {@link ResilencePresets.CONSERVATIVE}. Both the cockatiel policy stack
   *   AND the RxJS pipeline (deduplication / rate-limiter / throttling) are
   *   derived from this object — the latter is built once via
   *   {@link buildRxjsPipeline} and forwarded to {@link HookableHttpService}'s
   *   constructor so the reactive stages are applied inside `callUnderlying`.
   * @param hooks Optional {@link HooksConfig} lifecycle. Forwarded verbatim to
   *   {@link HookableHttpService} so `onInvoke` / `onReturn` / `onError`
   *   bracket every `super.dispatch(...)` call. Because the dispatch override
   *   wraps `super.dispatch` in `policy.execute(...)`, the hooks run INSIDE
   *   the resilience pipeline — every retry attempt re-invokes `onInvoke`
   *   with the carrier args (AC-21).
   */
  constructor(
    httpService: HttpService,
    config: ResilanceConfig<unknown> = ResilencePresets.CONSERVATIVE,
    hooks?: HooksConfig,
  ) {
    // Forward hooks AND the composed RxJS pipeline to HookableHttpService.
    // `buildRxjsPipeline` returns `undefined` when none of the reactive fields
    // (deduplication / rateLimiter / throttling) is set, so the dispatch
    // fast-path stays branch-light for the common (cockatiel-only) case.
    super(httpService, hooks, buildRxjsPipeline(config))
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
   *
   * @example
   * ```ts
   * import { RestClient } from 'nestjs-http-client'
   *
   * // RestClient.dispatch is called automatically on every public verb call.
   * // The policy wraps the request transparently — no special call-site needed.
   * const client = new RestClient(httpService)
   * const response = await client.get('/health')
   * // If the upstream is slow or returns 5xx, the policy retries automatically.
   * console.log(response.status) // 200 after retries succeed
   * ```
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
