import type { AxiosResponse } from 'axios'
import type { Subscription } from 'rxjs'
import { BehaviorSubject, Observable, concatMap, delay, filter, finalize, interval, map, of, shareReplay, take, tap } from 'rxjs'
import type { HttpVerb, InvokeArgs } from './hookable-http.service'
import type { DeduplicationConfig, RateLimiterConfig, ResilanceConfig, ThrottlingConfig } from './resilance.config'

/**
 * Closure that wraps a source `Observable<AxiosResponse>` with one stage of
 * the RxJS resilience pipeline (deduplication, rate-limiting, or throttling).
 *
 * Each operator in the pipeline accepts the verb and args of the originating
 * call so that closures over them — the dedup key, the rate-limiter
 * partition, etc. — can be derived without leaking those concerns into
 * {@link BaseHttpService.callUnderlying}. The composite pipeline built
 * from `ResilanceConfig.deduplication / rateLimiter / throttling` exposes the
 * same shape, so callers compose stages by chaining `RxjsPipeline` values
 * with no special-case wiring.
 *
 * Operators MUST return an Observable that emits exactly the same
 * `AxiosResponse` values as the source unless they intentionally suppress,
 * delay, or share emissions — they MUST NOT mutate response objects in place.
 *
 * @example
 * ```ts
 * import type { RxjsPipeline } from 'nestjs-http-client'
 *
 * // Trivial passthrough pipeline (acts as a no-op)
 * const passthrough: RxjsPipeline = (_verb, _args, source) => source
 * ```
 */
export type RxjsPipeline = (
  verb: HttpVerb,
  args: InvokeArgs,
  source: Observable<AxiosResponse>,
) => Observable<AxiosResponse>

/**
 * Derives the default cache key for a verb invocation when the user has not
 * supplied a custom `keyBuilder`. Mirrors the documented contract on
 * {@link DeduplicationConfig}: `${verb}:${args.url ?? args.config.url ?? ''}`.
 *
 * Extracted as a named function so the dedup operator's closure body remains
 * a single statement and the key-derivation rule lives in one auditable
 * location (rather than being scattered through every test fixture).
 */
function defaultDeduplicationKey(verb: HttpVerb, args: InvokeArgs): string {
  return `${verb}:${args.url ?? args.config?.url ?? ''}`
}

/**
 * Builds an {@link RxjsPipeline} stage that shares one in-flight source
 * subscription across concurrent subscribers that resolve to the same cache
 * key. Backed by `shareReplay({ bufferSize: 1, refCount: true })` so:
 *
 * - Concurrent subscribers see exactly one network call (the source is
 *   subscribed once; subsequent subscribers replay the buffered emission).
 * - Sequential subscribers (the second attaches AFTER the first completes)
 *   each trigger a fresh subscription — the cache entry is evicted by the
 *   `finalize` operator when the source completes OR errors.
 *
 * The cache itself is a plain `Map` captured in the closure: enclosing the
 * map inside the returned operator means each `deduplicationOperator(config)`
 * call produces an independent cache (no global state, safe to use multiple
 * dedup stages with different `keyBuilder`s in the same process).
 *
 * @example
 * ```ts
 * import { deduplicationOperator } from 'nestjs-http-client'
 *
 * const dedup = deduplicationOperator({})
 *
 * // Two concurrent identical GET /users/42 calls share one source
 * // subscription; both subscribers receive the same AxiosResponse.
 * const a$ = dedup('get', { url: '/users/42', config: {} }, source$)
 * const b$ = dedup('get', { url: '/users/42', config: {} }, source$)
 * ```
 */
export function deduplicationOperator(config: DeduplicationConfig): RxjsPipeline {
  // Per-operator cache keyed by the user-provided (or default) key builder.
  // Keeping the Map inside the closure makes every operator instance
  // independent — important when a process composes multiple dedup stages
  // with different keying strategies (e.g. tenant-scoped + global).
  const cache = new Map<string, Observable<AxiosResponse>>()
  const buildKey = config.keyBuilder ?? defaultDeduplicationKey

  return (verb, args, source) => {
    const key = buildKey(verb, args)

    const cached = cache.get(key)
    if (cached !== undefined) {
      return cached
    }

    // `shareReplay({ bufferSize: 1, refCount: true })` shares ONE source
    // subscription across every concurrent subscriber and replays the last
    // emitted value to late attachers. `refCount: true` means the inner
    // subscription is torn down when the last subscriber unsubscribes —
    // combined with `finalize`, this evicts the cache entry on completion,
    // error, AND zero-subscriber teardown (so retries see a fresh source).
    const shared = source.pipe(
      shareReplay({ bufferSize: 1, refCount: true }),
      finalize(() => {
        cache.delete(key)
      }),
    )

    cache.set(key, shared)
    return shared
  }
}

/**
 * Computes the millisecond interval between refill ticks for a rate-limiter
 * configured at `refillRatePerSec` emissions per second. Floored at 1 ms so a
 * pathological caller passing a huge rate (e.g. 1e9/sec) still yields a valid
 * timer interval rather than `0` — RxJS's `interval(0)` would degenerate into
 * a tight microtask loop and starve the event queue.
 */
function refillIntervalMs(refillRatePerSec: number): number {
  return Math.max(1, Math.round(1000 / refillRatePerSec))
}

/**
 * Builds a leaky-bucket {@link RxjsPipeline} stage. Every source emission is
 * delayed by exactly `1000 / refillRatePerSec` ms before reaching the
 * subscriber, smoothing arbitrary arrival bursts into a constant-rate
 * downstream stream. The `concatMap` ensures emissions are released in
 * arrival order — a fast burst is queued, not collapsed.
 *
 * Extracted from the dispatch closure so the strategy branch in
 * {@link rateLimiterOperator} is a single statement and the leaky-bucket
 * algorithm lives in one auditable location.
 */
function leakyBucketPipeline(config: RateLimiterConfig): RxjsPipeline {
  const delayMs = refillIntervalMs(config.refillRatePerSec)
  return (_verb, _args, source) =>
    source.pipe(concatMap(item => of(item).pipe(delay(delayMs))))
}

/**
 * Builds a token-bucket {@link RxjsPipeline} stage. The bucket starts at
 * `capacity` tokens and refills one token every `1000 / refillRatePerSec` ms
 * (capped at `capacity` so an idle period cannot let the bucket overflow).
 * Each source emission consumes one token; when the bucket is empty,
 * subsequent emissions are queued and released in arrival order as fresh
 * tokens drip in.
 *
 * The token state and refill timer are scoped to the SUBSCRIPTION rather than
 * the operator instance — wrapping the gating logic in a custom Observable
 * lets the teardown function unsubscribe both the refill `interval` and the
 * gated source pipeline so no timers leak when a downstream subscriber
 * unsubscribes early.
 */
function tokenBucketPipeline(config: RateLimiterConfig): RxjsPipeline {
  // Shared state is captured in the FACTORY closure — outside the
  // per-subscription Observable constructor — so a single token bucket and
  // a single refill timer span every pipeline invocation produced by this
  // factory. HTTP rate-limiting requires this scoping: each `client.get()`
  // call produces a NEW source observable, and every such source must
  // contend for the SAME bucket of tokens. Scoping state inside the inner
  // `new Observable(...)` would give every call its own fresh bucket,
  // collapsing the rate limiter into a no-op for sequential HTTP requests.
  //
  // BehaviorSubject<number> caches the latest token count and replays it to
  // every late attacher — required because the gate (filter + take(1))
  // attaches AFTER `tokens.next(...)` may have already fired.
  const tokens = new BehaviorSubject<number>(config.capacity)

  // Live subscription on the refill `interval(...)`. Lazily started on the
  // first pipeline subscription so an idle limiter does not hold a
  // recurring scheduler reference, and reference-counted across active
  // subscriptions so the timer only stops when the last subscriber leaves.
  let refillSub: Subscription | null = null
  let activeSubscriptions = 0

  // Lazily starts the refill timer when the first subscription attaches.
  // `Math.min` enforces the capacity ceiling so an idle period cannot
  // accumulate more tokens than the burst budget allows.
  const ensureRefill = (): void => {
    if (refillSub !== null) {
      return
    }
    refillSub = interval(refillIntervalMs(config.refillRatePerSec)).subscribe(() => {
      const current = tokens.getValue()
      if (current < config.capacity) {
        tokens.next(Math.min(config.capacity, current + 1))
      }
    })
  }

  // Stops the refill timer when the last subscription tears down. Keeping
  // the predicate in one place avoids leaks where one of the two
  // teardown paths (unsubscribe vs. source completion) forgets to check.
  const releaseRefill = (): void => {
    if (activeSubscriptions === 0 && refillSub !== null) {
      refillSub.unsubscribe()
      refillSub = null
    }
  }

  return (_verb, _args, source) => {
    return new Observable<AxiosResponse>((subscriber) => {
      activeSubscriptions += 1
      ensureRefill()

      // Gate every source emission on token availability. `concatMap`
      // preserves arrival order — a burst that exceeds capacity is queued,
      // never dropped. `filter(t => t > 0) + take(1)` waits for the first
      // positive count and then `tap` decrements before forwarding.
      const sourceSub = source
        .pipe(
          concatMap(value =>
            tokens.pipe(
              filter(t => t > 0),
              take(1),
              tap(() => tokens.next(tokens.getValue() - 1)),
              map(() => value),
            ),
          ),
        )
        .subscribe(subscriber)

      // Teardown: stop the gated source pipeline; release the shared
      // refill timer when no subscriptions remain.
      return () => {
        sourceSub.unsubscribe()
        activeSubscriptions = Math.max(0, activeSubscriptions - 1)
        releaseRefill()
      }
    })
  }
}

/**
 * Builds an {@link RxjsPipeline} stage that smooths the outbound emission
 * rate using either a token-bucket (burstable) or leaky-bucket (constant
 * rate) algorithm. The strategy is selected by `config.strategy`; both
 * variants use only RxJS operators (no `setInterval`, no lodash) so timing
 * is deterministic under jest fake timers.
 *
 * Token state and refill timing are scoped to each subscription so the
 * pipeline can be reused across independent calls without cross-talk and so
 * the refill timer is stopped automatically when the subscriber unsubscribes.
 *
 * @example
 * ```ts
 * import { rateLimiterOperator } from 'nestjs-http-client'
 *
 * // Allow short bursts of up to 10 requests, then sustain 5 emissions/sec.
 * const limiter = rateLimiterOperator({
 *   strategy: 'token-bucket',
 *   capacity: 10,
 *   refillRatePerSec: 5,
 * })
 *
 * // Strict 2 emissions/sec regardless of arrival pattern.
 * const strict = rateLimiterOperator({
 *   strategy: 'leaky-bucket',
 *   capacity: 1,
 *   refillRatePerSec: 2,
 * })
 * ```
 */
export function rateLimiterOperator(config: RateLimiterConfig): RxjsPipeline {
  if (config.strategy === 'leaky-bucket') {
    return leakyBucketPipeline(config)
  }
  return tokenBucketPipeline(config)
}

/**
 * Internal carrier used by {@link throttlingOperator} to track a pending
 * subscription request on the shared admission queue. Each entry pairs the
 * source Observable provided by the upstream stages with the downstream
 * subscriber that is waiting for an admission slot, plus a cancellation flag
 * so a downstream unsubscribe never fires the upstream HTTP call.
 */
interface ThrottleQueueEntry {
  /** The upstream `Observable<AxiosResponse>` provided to the operator. */
  readonly source: Observable<AxiosResponse>
  /** Downstream subscriber waiting for the admission slot. */
  readonly subscriber: {
    next: (value: AxiosResponse) => void
    error: (err: unknown) => void
    complete: () => void
  }
  /** Set to `true` when the downstream subscription tears down before admission. */
  cancelled: boolean
}

/**
 * Builds an {@link RxjsPipeline} stage that enforces an invocation-boundary
 * rate limit: at most `requestsPerInterval` source subscriptions are admitted
 * per fixed `intervalMs` window. Distinct from rate-limiting (token-bucket /
 * leaky-bucket) — throttling enforces a HARD CEILING per fixed window without
 * any per-item delay calculation. Excess requests are queued and admitted in
 * subsequent windows in arrival order; no request is dropped.
 *
 * The returned closure is intended to be installed once per `RestClient`. The
 * factory captures a single shared admission queue and a single window counter
 * in its closure, so every per-call invocation of the returned `RxjsPipeline`
 * enqueues against the SAME state — that is what makes the "≤ N per window"
 * guarantee hold across concurrent callers.
 *
 * Implementation strategy: a window counter is reset every `intervalMs` by an
 * RxJS `interval` timer (no `setInterval` / `setTimeout`, so jest fake timers
 * exercise the same deterministic path as production). When the counter is
 * below `requestsPerInterval`, queued entries are admitted in FIFO order;
 * otherwise they wait until the next tick. The refill timer is started lazily
 * on the first enqueue and torn down when the queue fully drains, so an idle
 * client does not hold a recurring scheduler reference.
 *
 * @example
 * ```ts
 * import { throttlingOperator } from 'nestjs-http-client'
 *
 * // Allow at most 1 request per 100 ms (≈ 10 req/s).
 * const throttle = throttlingOperator({ requestsPerInterval: 1, intervalMs: 100 })
 * ```
 *
 * @param config Throttling configuration: `requestsPerInterval` and `intervalMs`.
 * @returns An {@link RxjsPipeline} closure that throttles its source observables.
 */
export function throttlingOperator(config: ThrottlingConfig): RxjsPipeline {
  // FIFO queue shared across every invocation of the returned pipeline. A
  // per-source `bufferTime` would only throttle within a single source — not
  // what HTTP throttling needs. The shared queue is what enforces "≤ N per
  // window" ACROSS callers.
  const queue: ThrottleQueueEntry[] = []

  // How many entries have been admitted in the current window. Reset to 0
  // every `intervalMs` tick of the refill timer.
  let countInWindow = 0

  // Live subscription on the refill `interval(intervalMs)`. Lazily started on
  // the first enqueue and torn down when the queue drains, so an idle throttle
  // does not hold a recurring scheduler reference.
  let refillSubscription: Subscription | null = null

  // Drains the queue until either the window cap is hit or the queue empties.
  // Cancelled entries are dropped WITHOUT consuming a window slot — a caller
  // that aborts before its slot opens MUST NOT cost the next live caller its
  // turn.
  const drainWindow = (): void => {
    while (countInWindow < config.requestsPerInterval && queue.length > 0) {
      const entry = queue.shift() as ThrottleQueueEntry
      if (entry.cancelled) {
        continue
      }
      countInWindow += 1
      // Subscribing to `source` is the moment the wrapped HTTP request fires.
      // The throttle guarantees at most N such subscriptions per `intervalMs`
      // window across all callers sharing this operator.
      entry.source.subscribe(entry.subscriber)
    }
  }

  // Stops the refill timer when both the queue and the current window have
  // settled. Keeping the predicate in one place avoids leaks where one of the
  // two reset paths forgets to check before tearing down.
  const stopRefillIfIdle = (): void => {
    if (queue.length === 0 && countInWindow === 0 && refillSubscription !== null) {
      refillSubscription.unsubscribe()
      refillSubscription = null
    }
  }

  // Lazily starts the refill timer on the first enqueue. RxJS's `interval`
  // is backed by `asyncScheduler`, so jest fake timers exercise the same
  // deterministic path as production scheduling.
  const ensureRefillTimer = (): void => {
    if (refillSubscription !== null) {
      return
    }
    refillSubscription = interval(config.intervalMs).subscribe(() => {
      countInWindow = 0
      drainWindow()
      stopRefillIfIdle()
    })
  }

  return (_verb, _args, source) => {
    return new Observable<AxiosResponse>((downstream) => {
      const entry: ThrottleQueueEntry = {
        source,
        subscriber: {
          next: value => downstream.next(value),
          error: err => downstream.error(err),
          complete: () => downstream.complete(),
        },
        cancelled: false,
      }
      queue.push(entry)
      // Order matters: ensure the refill timer is running BEFORE the synchronous
      // drain so that, even if `drainWindow` admits this entry and the source
      // completes synchronously, subsequent enqueues observe a live refill timer
      // rather than a torn-down one.
      ensureRefillTimer()
      drainWindow()
      stopRefillIfIdle()
      return () => {
        // Mark the entry cancelled so the drain loop never subscribes to the
        // upstream source for a downstream that has already torn down. This
        // prevents leaking HTTP requests when a caller aborts before its
        // admission slot opens.
        entry.cancelled = true
      }
    })
  }
}

/**
 * Indirection map that resolves each `ResilanceConfig` field name to the
 * factory that produces its `RxjsPipeline` stage. The map is referenced by
 * {@link buildRxjsPipeline} via property access (`rxjsOperatorFactories.xxx(...)`
 * rather than a direct local function call) so jest tests can `jest.spyOn`
 * each entry to record invocation order without monkey-patching the module
 * exports — internal calls in TypeScript-compiled CommonJS use the LOCAL
 * function reference (not `exports.xxx`), so spying on the module namespace
 * would otherwise miss every call from inside `buildRxjsPipeline`.
 *
 * Production code does NOT need to interact with this object. It is exported
 * solely so the spec file can spy on it.
 */
export const rxjsOperatorFactories = {
  deduplication: deduplicationOperator,
  rateLimiter: rateLimiterOperator,
  throttling: throttlingOperator,
}

/**
 * Composes the three RxJS resilience stages declared on a {@link ResilanceConfig}
 * into a single {@link RxjsPipeline}. Mirrors the field-by-field filtering
 * approach used by {@link resiliencePolicyBuilder} for cockatiel policies, so
 * the two builders share a structural shape: collect every stage configured
 * on the input, drop the undefined slots, and reduce the survivors into a
 * single composed value.
 *
 * Composition order (declared OUTERMOST first, INNERMOST last):
 *
 *   `deduplication → rateLimiter → throttling`
 *
 * The outermost stage is the one that observes the upstream source first.
 * Placing `deduplication` outermost means a cache hit short-circuits BEFORE
 * the inner stages are entered — cached results bypass rate-limiting and
 * throttling slots for subsequent callers, which is exactly what
 * {@link ResilanceConfig.deduplication} promises.
 *
 * The reduction itself uses `reduceRight` so that the FIRST array entry ends
 * up as the outermost wrapper:
 *
 * ```
 * reduceRight starts at the rightmost (innermost) entry and walks LEFT:
 *   acc = source
 *   acc = throttling(verb, args, acc)        ← innermost wraps source
 *   acc = rateLimiter(verb, args, acc)       ← middle wraps throttling
 *   acc = deduplication(verb, args, acc)     ← outermost wraps everything
 * ```
 *
 * Returns `undefined` when none of the three fields is set, so
 * {@link BaseHttpService.callUnderlying} can skip the pipeline entirely without
 * paying for an empty-reduce closure on every request. Callers MUST treat
 * `undefined` as "no RxJS pipeline" rather than "empty pipeline" — the two are
 * indistinguishable observationally but the `undefined` form lets the dispatch
 * fast-path stay branch-light.
 *
 * @example
 * ```ts
 * import { buildRxjsPipeline, type ResilanceConfig } from 'nestjs-http-client'
 *
 * const config: ResilanceConfig<unknown> = {
 *   deduplication: {},
 *   throttling: { requestsPerInterval: 5, intervalMs: 1_000 },
 * }
 *
 * const pipeline = buildRxjsPipeline(config)
 * // pipeline applies deduplication first (outermost), then throttling.
 * // rateLimiter slot is empty, so it is skipped entirely.
 * ```
 */
export function buildRxjsPipeline(config: ResilanceConfig<unknown>): RxjsPipeline | undefined {
  // Build the slot array in OUTER-to-INNER order so a reader of the source
  // sees the documented composition order (`deduplication → rateLimiter →
  // throttling`) without having to mentally invert anything. Each slot is
  // either an `RxjsPipeline` produced by the corresponding factory or
  // `undefined` when the consumer omitted that field. Calls go through
  // `rxjsOperatorFactories.xxx` (property access) so jest spies on that
  // object intercept invocations during composition.
  const operators: Array<RxjsPipeline | undefined> = [
    config.deduplication && rxjsOperatorFactories.deduplication(config.deduplication),
    config.rateLimiter && rxjsOperatorFactories.rateLimiter(config.rateLimiter),
    config.throttling && rxjsOperatorFactories.throttling(config.throttling),
  ]

  const filtered = operators.filter(Boolean) as RxjsPipeline[]

  if (filtered.length === 0) {
    return undefined
  }

  // `reduceRight` walks from the innermost entry leftward, wrapping each
  // outer stage AROUND the accumulated inner observable. The first array
  // entry — the outermost — therefore lands as the final wrapper, which is
  // the one that subscribers attach to. Capturing `verb`/`args`/`source` per
  // call means each invocation builds its own composition over the per-call
  // source, so closures over those values stay correct under concurrent use.
  return (verb, args, source) =>
    filtered.reduceRight<Observable<AxiosResponse>>(
      (acc, operator) => operator(verb, args, acc),
      source,
    )
}
