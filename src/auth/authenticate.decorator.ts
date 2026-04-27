import { Wrap } from 'base-decorators'
import { isAxiosError, type AxiosRequestConfig } from 'axios'

/**
 * Unique exclusion key for the `@Authenticate` decorator.
 *
 * Distinct symbols are required when multiple `Wrap`-based decorators may be
 * applied to the same class (e.g. `@ExecuteWithPolicy`, `@DeduplicateInflight`,
 * `@Authenticate`) to prevent base-decorators' double-wrapping detection from
 * conflating them.
 */
const AUTHENTICATE_KEY: unique symbol = Symbol('authenticate')

/**
 * Minimal structural contract the host class must expose on `this.authStrategy`.
 *
 * Defined inline here rather than imported from `auth-strategy.service.ts`
 * because that service is built in a sibling step; the decorator only needs
 * the public surface and intentionally does not couple to the concrete class.
 * The real `AuthStrategyService` satisfies this shape via duck-typing.
 */
interface AuthStrategyContract {
  /** Authenticates if no valid session is currently held. Idempotent when authed. */
  authenticateIfNeeded(): Promise<void>
  /** Returns a new config with auth material merged in (must not mutate input). */
  extendRequest(config: AxiosRequestConfig): AxiosRequestConfig
  /** Drops the cached auth result so the next `authenticateIfNeeded()` re-authenticates. */
  clearAuth(): void
}

/** Host class shape required by `@Authenticate` — read by `Wrap` via `context.target`. */
interface AuthenticateHost {
  authStrategy: AuthStrategyContract
}

/**
 * Method names whose `AxiosRequestConfig` parameter sits at args index 1.
 *
 * `request`, `get`, `delete`, `head`, and `options` follow the
 * `(url, config?)` (or `(config?)`) signature on `HttpService`, so the
 * config — when present — is always the second tuple element.
 */
const CONFIG_AT_INDEX_1: ReadonlySet<string> = new Set([
  'get',
  'delete',
  'head',
  'options',
  'request',
])

/**
 * Method names whose `AxiosRequestConfig` parameter sits at args index 2.
 *
 * `post`, `put`, `patch` and their `*Form` variants follow the
 * `(url, data, config?)` signature on `HttpService`.
 */
const CONFIG_AT_INDEX_2: ReadonlySet<string> = new Set([
  'post',
  'put',
  'patch',
  'postForm',
  'putForm',
  'patchForm',
])

/**
 * Resolves the position of the `AxiosRequestConfig` argument for the given
 * decorated method.
 *
 * The mapping is intentionally explicit (no fallthrough default) so a
 * misspelled or unsupported verb fails loudly during development rather than
 * silently writing auth headers into a `data` slot.
 *
 * @param propertyKey - The decorated method's property key.
 * @returns The zero-based index of the config argument.
 * @throws Error when `propertyKey` is not a recognised HTTP verb.
 */
function configArgIndex(propertyKey: string | symbol): number {
  const key = String(propertyKey)
  if (CONFIG_AT_INDEX_1.has(key)) {
    return 1
  }
  if (CONFIG_AT_INDEX_2.has(key)) {
    return 2
  }
  throw new Error(
    `@Authenticate: unsupported method "${key}". `
    + `Expected one of: ${[...CONFIG_AT_INDEX_1, ...CONFIG_AT_INDEX_2].join(', ')}.`,
  )
}

/**
 * Returns a fresh args tuple with `args[index]` replaced by the result of
 * `strategy.extendRequest(args[index] ?? {})`.
 *
 * Always operates on an immutable `[...args]` copy — the caller's args array
 * is never mutated, so retry paths can re-extend from the original config
 * without observing the previous attempt's headers.
 *
 * @param args - The original method arguments.
 * @param index - The position of the config argument (typically 1 or 2).
 * @param strategy - The auth strategy whose `extendRequest` builds the new config.
 * @returns A new array suitable to spread into the wrapped method.
 */
function extendConfigAtIndex(
  args: unknown[],
  index: number,
  strategy: AuthStrategyContract,
): unknown[] {
  const next = [...args]
  const current = (next[index] as AxiosRequestConfig | undefined) ?? {}
  next[index] = strategy.extendRequest(current)
  return next
}

/**
 * Method decorator that authenticates the host before the wrapped request
 * runs and recovers from a single HTTP 401 by re-authenticating once.
 *
 * Flow on every invocation:
 * 1. `await authStrategy.authenticateIfNeeded()` — runs before the wrapped call.
 * 2. Replace `args[configArgIndex(propertyKey)]` with
 *    `authStrategy.extendRequest(args[idx] ?? {})` (immutable copy).
 * 3. Call the wrapped method with the extended args.
 * 4. On `isAxiosError(err) && err.response?.status === 401`:
 *    - `authStrategy.clearAuth()`
 *    - `await authStrategy.authenticateIfNeeded()` (now forced to re-auth)
 *    - re-extend the original args (NOT the previously extended args)
 *    - retry the wrapped method exactly once; rethrow whatever it produces.
 * 5. Any non-401 axios error or non-axios error is rethrown as-is, with
 *    `clearAuth()` never called on those paths.
 *
 * The `method` reference passed by `Wrap` is auto-bound to the current `this`
 * — never call `.bind`, `.call`, or `.apply` on it.
 *
 * @returns A method decorator usable on any `AuthRestClient` request method
 *          whose host class exposes an `authStrategy` field satisfying
 *          {@link AuthStrategyContract}.
 *
 * @example
 * ```ts
 * class AuthRestClient {
 *   constructor(
 *     private readonly client: RestClient,
 *     readonly authStrategy: AuthStrategyService,
 *   ) {}
 *
 *   @Authenticate()
 *   get<T>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
 *     return this.client.get<T>(url, config)
 *   }
 * }
 * ```
 */
function Authenticate(): MethodDecorator {
  return Wrap<AuthenticateHost, unknown[], Promise<unknown>>(
    (method, {propertyKey, target}) => async (...args: unknown[]): Promise<unknown> => {
      const idx = configArgIndex(propertyKey) // TODO: this logic is too fragile and overcomplicated. Add extractConfig(...args): AxiosRequestConfig  function as param of this decorator, and set it per menthod instead of this hardcoded logic.
      const strategy = target.authStrategy

      await strategy.authenticateIfNeeded()
      const firstAttemptArgs = extendConfigAtIndex(args, idx, strategy)

      try {
        return await method(...firstAttemptArgs)
      }
      catch (error) {
        if (isAxiosError(error) && error.response?.status === 401) {
          // Single re-auth attempt: drop cached credentials, re-authenticate, and
          // re-extend the ORIGINAL args (not the first-attempt args) so the new
          // credentials replace any stale Authorization header from the prior try.
          strategy.clearAuth()
          await strategy.authenticateIfNeeded()
          const retryArgs = extendConfigAtIndex(args, idx, strategy)
          return await method(...retryArgs)
        }
        throw error
      }
    },
    AUTHENTICATE_KEY,
  )
}

export { AUTHENTICATE_KEY, Authenticate, configArgIndex, extendConfigAtIndex }
