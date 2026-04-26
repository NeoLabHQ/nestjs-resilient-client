import { Wrap } from 'base-decorators'
import { firstValueFrom, isObservable } from 'rxjs'
import type { IDefaultPolicyContext, IPolicy } from 'cockatiel'

/**
 * Unique exclusion key for the `@ExecuteWithPolicy` decorator.
 *
 * Distinct symbols are required when multiple `Wrap`-based decorators may be
 * applied to the same class (e.g. `@ExecuteWithPolicy`, `@DeduplicateInflight`,
 * `@Authenticate`) to prevent base-decorators' double-wrapping detection from
 * conflating them.
 */
const EXECUTE_WITH_POLICY_KEY: unique symbol = Symbol('executeWithPolicy')

/** Minimal shape required of the host class — base-decorators reads `context.target.policy` on every invocation. */
interface ExecuteWithPolicyHost {
  policy: IPolicy<IDefaultPolicyContext, unknown>
}

/**
 * Method decorator that runs the decorated request method through a cockatiel
 * resilience policy and unwraps the resulting Observable to a Promise.
 *
 * Behavior:
 * - Reads `this.policy` from the class instance at **call time** via
 *   `context.target.policy`, so the policy may be replaced between calls.
 * - Invokes the original method inside `policy.execute(async (policyCtx) => ...)`,
 *   then awaits `firstValueFrom(...)` on the returned Observable.
 * - When the decorated method's `propertyKey === 'request'`, spreads
 *   `signal: policyCtx.signal` into the first argument before invoking the
 *   wrapped method, so retries / circuit-breakers can cancel in-flight axios
 *   requests via the abort controller propagated by cockatiel.
 *
 * The wrapped `method` reference is auto-bound to the current `this` by
 * `Wrap` from `base-decorators` — never call `.bind`, `.call`, or `.apply`
 * on it.
 *
 * @returns A method decorator usable on any request method that returns an
 *          `Observable<AxiosResponse>` and whose host class exposes a
 *          `policy: IPolicy<IDefaultPolicyContext, unknown>` field.
 *
 * @example
 * ```ts
 * class RestClient {
 *   readonly policy: IPolicy<IDefaultPolicyContext>
 *
 *   @ExecuteWithPolicy()
 *   get<T>(url: string, config?: AxiosRequestConfig): Observable<AxiosResponse<T>> {
 *     return this.httpService.get<T>(url, config)
 *   }
 * }
 * ```
 */
// `any[]` for TArgs and `any` for TReturn intentionally widens the
// `TypedPropertyDescriptor` so the decorator can attach to methods of any
// signature (e.g. `(url: string, config?) => Observable<AxiosResponse>`).
// `TypedPropertyDescriptor` is invariant over its function type's params and
// return, so a stricter generic (e.g. `unknown[]` / `Promise<AxiosResponse>`)
// rejects every concrete method signature at decoration time. `any` is the
// only escape hatch that works with TypeScript's invariant descriptor check
// and matches the SKILL guidance for this decorator.
function ExecuteWithPolicy() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above comment block: TypedPropertyDescriptor invariance forces `any[]` / `any` here; restructuring with `unknown[]` / `unknown` rejects every concrete method signature at decoration time
  return Wrap<ExecuteWithPolicyHost, any[], any>(
    (method, context) => (...args: unknown[]) => {
      return context.target.policy.execute(async (policyCtx) => {
        // Forward cockatiel's abort signal into axios on the generic `request`
        // path so retries/circuit-breakers can cancel in-flight requests. Other
        // verb helpers do not currently forward the signal: their config arg
        // position differs and would require per-method handling.
        const finalArgs = context.propertyKey === 'request'
          ? [{ ...((args[0] as object | undefined) ?? {}), signal: policyCtx.signal }, ...args.slice(1)]
          : args

        const result = method(...finalArgs)

        // The original method always returns an Observable<AxiosResponse>; the
        // `any` return type exists only to satisfy the decorator's variance
        // check on `TypedPropertyDescriptor`.
        return isObservable(result) ? await firstValueFrom(result) : await result
      })
    },
    EXECUTE_WITH_POLICY_KEY,
  )
}

export { EXECUTE_WITH_POLICY_KEY, ExecuteWithPolicy }
