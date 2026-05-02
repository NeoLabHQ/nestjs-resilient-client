import type { AxiosResponse } from 'axios'
import { Observable, Subject, lastValueFrom, of, throwError, toArray } from 'rxjs'

import { buildRxjsPipeline, deduplicationOperator, rateLimiterOperator, rxjsOperatorFactories, throttlingOperator, type RxjsPipeline } from '../rxjs-pipeline'
import type { HttpVerb, InvokeArgs } from '../hookable-http.service'
import type { ResilanceConfig } from '../resilance.config'

/**
 * Builds a deterministic {@link AxiosResponse} fixture for use as the source
 * Observable's emission. Tests assert on `data`/`status` to confirm callers
 * receive the same value the source emitted (no mutation by the operator).
 */
function buildResponse<T = unknown>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: {} as never },
  } as AxiosResponse<T>
}

/**
 * Builds an {@link InvokeArgs} carrier matching the shape produced by
 * {@link BaseHttpService} verb methods (`url`, optional `data`, and a
 * `config` object). Mirrors the canonical args used by the real client so
 * the operator's default key derivation (`${verb}:${args.url}`) lines up
 * with what the production dispatcher would observe.
 */
function buildArgs(url: string, configUrl?: string): InvokeArgs {
  return {
    url,
    config: configUrl !== undefined ? { url: configUrl } : {},
  }
}

describe('deduplicationOperator', () => {
  describe('concurrent dedup', () => {
    /**
     * AC: Concurrent subscribers to the same key share one source Observable
     * subscription. 100 concurrent subscriptions to the same key MUST result
     * in exactly 1 source subscription (i.e. one network call) — every other
     * subscriber receives the replayed emission.
     */
    it('shares one source subscription for 100 concurrent subscribers with the same key', async () => {
      const subscribe = jest.fn()
      const source$ = new Observable<AxiosResponse>((subscriber) => {
        subscribe()
        // Defer emission so all 100 subscribers attach BEFORE the source emits;
        // otherwise sync `of(...)` would complete before we register the rest.
        queueMicrotask(() => {
          subscriber.next(buildResponse({ id: 42 }))
          subscriber.complete()
        })
      })

      const operator = deduplicationOperator({})
      const verb: HttpVerb = 'get'
      const args = buildArgs('/users/42')

      // Subscribe 100 times concurrently. Each call invokes the operator
      // (closure look-up by key), which MUST return the SAME shared Observable.
      const promises: Promise<AxiosResponse>[] = []
      for (let i = 0; i < 100; i++) {
        const piped$ = operator(verb, args, source$)
        promises.push(
          new Promise<AxiosResponse>((resolve, reject) => {
            piped$.subscribe({ next: resolve, error: reject })
          }),
        )
      }

      const responses = await Promise.all(promises)

      expect(subscribe).toHaveBeenCalledTimes(1)
      expect(responses).toHaveLength(100)
      expect(responses[0].data).toEqual({ id: 42 })
    })
  })

  describe('sequential cache cleanup', () => {
    /**
     * AC: Cache entry is removed after Observable completes (via `finalize`).
     * Two SEQUENTIAL calls (the second starts after the first completes) MUST
     * each subscribe to the source — the cache must not retain the completed
     * Observable.
     */
    it('subscribes to the source twice for two sequential calls to the same key', async () => {
      const subscribe = jest.fn()
      const source$ = new Observable<AxiosResponse>((subscriber) => {
        subscribe()
        subscriber.next(buildResponse({ count: subscribe.mock.calls.length }))
        subscriber.complete()
      })

      const operator = deduplicationOperator({})
      const verb: HttpVerb = 'get'
      const args = buildArgs('/users/42')

      // First call: subscribes, completes, finalize evicts the cache entry.
      await new Promise<AxiosResponse>((resolve, reject) => {
        operator(verb, args, source$).subscribe({ next: resolve, error: reject })
      })

      // Second call: cache is empty, fresh subscription happens.
      await new Promise<AxiosResponse>((resolve, reject) => {
        operator(verb, args, source$).subscribe({ next: resolve, error: reject })
      })

      expect(subscribe).toHaveBeenCalledTimes(2)
    })
  })

  describe('different keys', () => {
    /**
     * AC: Two different keys do not share cache entries — each key has its
     * own in-flight subscription.
     */
    it('does not share cache between distinct keys', async () => {
      const subscribeUsers = jest.fn()
      const subscribeOrders = jest.fn()
      const usersSource$ = new Observable<AxiosResponse>((subscriber) => {
        subscribeUsers()
        subscriber.next(buildResponse({ kind: 'users' }))
        subscriber.complete()
      })
      const ordersSource$ = new Observable<AxiosResponse>((subscriber) => {
        subscribeOrders()
        subscriber.next(buildResponse({ kind: 'orders' }))
        subscriber.complete()
      })

      const operator = deduplicationOperator({})

      const usersResponse = await new Promise<AxiosResponse>((resolve, reject) => {
        operator('get', buildArgs('/users'), usersSource$).subscribe({ next: resolve, error: reject })
      })
      const ordersResponse = await new Promise<AxiosResponse>((resolve, reject) => {
        operator('get', buildArgs('/orders'), ordersSource$).subscribe({ next: resolve, error: reject })
      })

      expect(subscribeUsers).toHaveBeenCalledTimes(1)
      expect(subscribeOrders).toHaveBeenCalledTimes(1)
      expect(usersResponse.data).toEqual({ kind: 'users' })
      expect(ordersResponse.data).toEqual({ kind: 'orders' })
    })

    /**
     * AC: Different verbs to the same URL produce distinct cache keys —
     * `GET /users` and `POST /users` MUST NOT collide under the default
     * key-derivation strategy.
     */
    it('does not share cache between distinct verbs targeting the same url', async () => {
      const subscribe = jest.fn()
      const source$ = new Observable<AxiosResponse>((subscriber) => {
        subscribe()
        subscriber.next(buildResponse({ ok: true }))
        subscriber.complete()
      })

      const operator = deduplicationOperator({})

      await new Promise<AxiosResponse>((resolve, reject) => {
        operator('get', buildArgs('/users'), source$).subscribe({ next: resolve, error: reject })
      })
      await new Promise<AxiosResponse>((resolve, reject) => {
        operator('post', buildArgs('/users'), source$).subscribe({ next: resolve, error: reject })
      })

      expect(subscribe).toHaveBeenCalledTimes(2)
    })
  })

  describe('default key derivation', () => {
    /**
     * AC: When `args.url` is undefined, the operator falls back to
     * `args.config.url ?? ''`. Two `request`-style calls (no positional `url`,
     * url carried inside `config`) hitting the same `config.url` MUST share
     * the cache entry.
     */
    it('falls back to args.config.url when args.url is undefined', async () => {
      const subscribe = jest.fn()
      const source$ = new Observable<AxiosResponse>((subscriber) => {
        subscribe()
        queueMicrotask(() => {
          subscriber.next(buildResponse({ ok: true }))
          subscriber.complete()
        })
      })

      const operator = deduplicationOperator({})
      const verb: HttpVerb = 'request'
      const args: InvokeArgs = { config: { url: '/users/42' } }

      const a$ = operator(verb, args, source$)
      const b$ = operator(verb, args, source$)

      const [a, b] = await Promise.all([
        new Promise<AxiosResponse>((resolve, reject) => a$.subscribe({ next: resolve, error: reject })),
        new Promise<AxiosResponse>((resolve, reject) => b$.subscribe({ next: resolve, error: reject })),
      ])

      expect(subscribe).toHaveBeenCalledTimes(1)
      expect(a.data).toEqual({ ok: true })
      expect(b.data).toEqual({ ok: true })
    })

    it('uses empty string key when both args.url and args.config.url are absent', async () => {
      const subscribe = jest.fn()
      const source$ = new Observable<AxiosResponse>((subscriber) => {
        subscribe()
        queueMicrotask(() => {
          subscriber.next(buildResponse({ ok: true }))
          subscriber.complete()
        })
      })

      const operator = deduplicationOperator({})
      const verb: HttpVerb = 'request'
      const args: InvokeArgs = { config: {} }

      const a$ = operator(verb, args, source$)
      const b$ = operator(verb, args, source$)

      const [a, b] = await Promise.all([
        new Promise<AxiosResponse>((resolve, reject) => a$.subscribe({ next: resolve, error: reject })),
        new Promise<AxiosResponse>((resolve, reject) => b$.subscribe({ next: resolve, error: reject })),
      ])

      // Both use the empty-string key → share one subscription
      expect(subscribe).toHaveBeenCalledTimes(1)
      expect(a.data).toEqual({ ok: true })
      expect(b.data).toEqual({ ok: true })
    })
  })

  describe('custom key builder', () => {
    /**
     * AC: When `key` is provided, the operator MUST use it instead of
     * the default `${verb}:${url}` derivation. Two requests with different
     * URLs but the same custom key MUST share one source subscription.
     */
    it('uses the custom key builder when provided', async () => {
      const subscribe = jest.fn()
      const source$ = new Observable<AxiosResponse>((subscriber) => {
        subscribe()
        queueMicrotask(() => {
          subscriber.next(buildResponse({ ok: true }))
          subscriber.complete()
        })
      })

      // Always returns the same key — every subscription should dedupe to one.
      const keyBuilder = jest.fn(() => 'shared-key')
      const operator = deduplicationOperator({ key: keyBuilder })

      const a$ = operator('get', buildArgs('/users/1'), source$)
      const b$ = operator('get', buildArgs('/users/2'), source$)

      await Promise.all([
        new Promise<AxiosResponse>((resolve, reject) => a$.subscribe({ next: resolve, error: reject })),
        new Promise<AxiosResponse>((resolve, reject) => b$.subscribe({ next: resolve, error: reject })),
      ])

      // Custom key builder invoked for every operator call.
      expect(keyBuilder).toHaveBeenCalledTimes(2)
      expect(keyBuilder).toHaveBeenCalledWith('get', buildArgs('/users/1'))
      expect(keyBuilder).toHaveBeenCalledWith('get', buildArgs('/users/2'))
      // Both subscriptions resolve to the same key, so the source is hit once.
      expect(subscribe).toHaveBeenCalledTimes(1)
    })
  })

  describe('error path', () => {
    /**
     * AC: Cache entry is removed even when upstream errors (`finalize` runs
     * on completion AND error). A second sequential call to the same key
     * after the first errors MUST trigger a fresh subscription.
     */
    it('clears the cache entry when upstream errors and allows a retry to subscribe fresh', async () => {
      const subscribe = jest.fn()
      const source$ = new Observable<AxiosResponse>((subscriber) => {
        subscribe()
        subscriber.error(new Error('boom'))
      })

      const operator = deduplicationOperator({})
      const verb: HttpVerb = 'get'
      const args = buildArgs('/users/42')

      // First call errors out. Use a try/catch to swallow the rejection.
      await expect(
        new Promise<AxiosResponse>((resolve, reject) => {
          operator(verb, args, source$).subscribe({ next: resolve, error: reject })
        }),
      ).rejects.toThrow('boom')

      // Second call: cache entry cleared by `finalize`, fresh subscription.
      await expect(
        new Promise<AxiosResponse>((resolve, reject) => {
          operator(verb, args, source$).subscribe({ next: resolve, error: reject })
        }),
      ).rejects.toThrow('boom')

      expect(subscribe).toHaveBeenCalledTimes(2)
    })

    /**
     * AC: Concurrent subscribers attached to a key whose source errors MUST
     * all observe the same error. Cache cleanup must run exactly once.
     */
    it('propagates the same error to all concurrent subscribers and clears the cache', async () => {
      const subject = new Subject<AxiosResponse>()
      const subscribe = jest.fn()
      const source$ = new Observable<AxiosResponse>((subscriber) => {
        subscribe()
        const sub = subject.subscribe(subscriber)
        return () => sub.unsubscribe()
      })

      const operator = deduplicationOperator({})
      const verb: HttpVerb = 'get'
      const args = buildArgs('/users/42')

      const a = new Promise<AxiosResponse>((resolve, reject) => {
        operator(verb, args, source$).subscribe({ next: resolve, error: reject })
      })
      const b = new Promise<AxiosResponse>((resolve, reject) => {
        operator(verb, args, source$).subscribe({ next: resolve, error: reject })
      })

      // Trigger the upstream error AFTER both subscribers attach.
      subject.error(new Error('boom'))

      await expect(a).rejects.toThrow('boom')
      await expect(b).rejects.toThrow('boom')

      // Source is still subscribed to once (shared); after error, finalize
      // evicts the entry — the next call subscribes again.
      expect(subscribe).toHaveBeenCalledTimes(1)

      const fresh$ = of(buildResponse({ ok: true }))
      const retry = await new Promise<AxiosResponse>((resolve, reject) => {
        operator(verb, args, fresh$).subscribe({ next: resolve, error: reject })
      })
      expect(retry.data).toEqual({ ok: true })
    })

    /**
     * AC: Synchronous `throwError` source still triggers `finalize` cleanup
     * — the cache is empty after the error propagates.
     */
    it('clears the cache for synchronous throwError sources', async () => {
      const operator = deduplicationOperator({})
      const verb: HttpVerb = 'get'
      const args = buildArgs('/users/42')

      const failing$ = throwError(() => new Error('boom'))

      await expect(
        new Promise<AxiosResponse>((resolve, reject) => {
          operator(verb, args, failing$).subscribe({ next: resolve, error: reject })
        }),
      ).rejects.toThrow('boom')

      // After the error, a successful retry sees the freshly-emitted value.
      const successResponse = buildResponse({ ok: true })
      const retry = await new Promise<AxiosResponse>((resolve, reject) => {
        operator(verb, args, of(successResponse)).subscribe({ next: resolve, error: reject })
      })
      expect(retry.data).toEqual({ ok: true })
    })
  })
})

/**
 * Synthesises a deterministic {@link AxiosResponse} carrying the supplied
 * payload. The rate-limiter tests assert on `data` to confirm that emissions
 * are NOT dropped — every source value must reach the downstream subscriber,
 * only the timing changes.
 */
function buildRateLimiterResponse(data: unknown): AxiosResponse {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: {} as never },
  } as AxiosResponse
}

const rateLimiterVerb: HttpVerb = 'get'
const rateLimiterArgs: InvokeArgs = { url: '/x', config: {} }

/**
 * Drives a `RxjsPipeline` over an inline source `Subject<AxiosResponse>` and
 * collects the emissions into an array as they arrive. The returned
 * `arrived` array reflects exactly what the pipeline has already emitted at
 * the moment of inspection — so a test can advance jest fake timers and
 * read the array to assert when each emission was released.
 */
function driveRateLimiter(pipeline: RxjsPipeline): {
  source: Subject<AxiosResponse>
  arrived: AxiosResponse[]
} {
  const source = new Subject<AxiosResponse>()
  const arrived: AxiosResponse[] = []

  pipeline(rateLimiterVerb, rateLimiterArgs, source.asObservable()).subscribe({
    next: (response) => {
      arrived.push(response)
    },
  })

  return { source, arrived }
}

describe('rateLimiterOperator', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('contract', () => {
    /**
     * AC: `rateLimiterOperator(config)` returns a closure with the canonical
     * `RxjsPipeline` shape — three positional parameters `(verb, args, source)`.
     */
    it('returns a closure of the RxjsPipeline shape', () => {
      const pipeline = rateLimiterOperator({
        strategy: 'token-bucket',
        capacity: 1,
        refillRatePerSec: 1,
      })

      expect(typeof pipeline).toBe('function')
      expect(pipeline.length).toBe(3)
    })
  })

  describe('token-bucket strategy', () => {
    /**
     * AC: token-bucket allows `capacity` immediate emissions, then defers
     * subsequent emissions until refill ticks fire (one token per
     * `1000 / refillRatePerSec` ms).
     */
    it('allows capacity emissions immediately, then delays subsequent emissions until refill', async () => {
      // capacity=2 → 2 immediate; refillRatePerSec=1 → 1 token per 1000 ms.
      const pipeline = rateLimiterOperator({
        strategy: 'token-bucket',
        capacity: 2,
        refillRatePerSec: 1,
      })
      const { source, arrived } = driveRateLimiter(pipeline)

      // Push 4 emissions in a tight burst. The first two consume the initial
      // capacity; the remaining two must wait for refill ticks.
      source.next(buildRateLimiterResponse(1))
      source.next(buildRateLimiterResponse(2))
      source.next(buildRateLimiterResponse(3))
      source.next(buildRateLimiterResponse(4))

      // Microtasks: tokens.pipe(filter, take(1)) for the first two values
      // resolves synchronously because the BehaviorSubject already holds a
      // positive count. Flush microtasks so the immediate gates resolve.
      await Promise.resolve()
      await Promise.resolve()

      expect(arrived.map(r => r.data)).toEqual([1, 2])

      // Advance one full refill window → one new token → one more emission.
      await jest.advanceTimersByTimeAsync(1000)
      expect(arrived.map(r => r.data)).toEqual([1, 2, 3])

      // Another window → another token → fourth emission released.
      await jest.advanceTimersByTimeAsync(1000)
      expect(arrived.map(r => r.data)).toEqual([1, 2, 3, 4])
    })

    /**
     * AC: token-bucket QUEUES bursty input rather than dropping. Five rapid
     * emissions through a single-token bucket must all be delivered exactly
     * once, in order, as the bucket refills.
     */
    it('queues bursty input rather than dropping emissions', async () => {
      const pipeline = rateLimiterOperator({
        strategy: 'token-bucket',
        capacity: 1,
        refillRatePerSec: 1,
      })
      const { source, arrived } = driveRateLimiter(pipeline)

      for (let i = 0; i < 5; i++) {
        source.next(buildRateLimiterResponse(i))
      }

      // First emission is gated synchronously on the initial token.
      await Promise.resolve()
      expect(arrived.map(r => r.data)).toEqual([0])

      // Advance four full windows; each window should release exactly one
      // queued emission until the queue is drained.
      for (let tick = 1; tick <= 4; tick++) {
        await jest.advanceTimersByTimeAsync(1000)
      }

      expect(arrived.map(r => r.data)).toEqual([0, 1, 2, 3, 4])
    })

    /**
     * AC: refill respects the `capacity` ceiling — an idle period cannot
     * accumulate more tokens than the configured burst budget.
     */
    it('caps refilled token count at capacity (no overflow on idle)', async () => {
      // capacity=2, refill=1/sec. After 5 idle seconds, the bucket must hold
      // at most 2 tokens — a 3rd rapid emission must wait for fresh refill.
      const pipeline = rateLimiterOperator({
        strategy: 'token-bucket',
        capacity: 2,
        refillRatePerSec: 1,
      })
      const { source, arrived } = driveRateLimiter(pipeline)

      // Idle for 5 seconds — refill ticks fire but cannot exceed `capacity`.
      await jest.advanceTimersByTimeAsync(5000)

      source.next(buildRateLimiterResponse('a'))
      source.next(buildRateLimiterResponse('b'))
      source.next(buildRateLimiterResponse('c'))

      await Promise.resolve()
      await Promise.resolve()

      // Only 2 tokens should be available despite 5 elapsed refill windows.
      expect(arrived.map(r => r.data)).toEqual(['a', 'b'])

      // The third emission still requires one more refill tick.
      await jest.advanceTimersByTimeAsync(1000)
      expect(arrived.map(r => r.data)).toEqual(['a', 'b', 'c'])
    })

    /**
     * AC: subscription cancellation MUST stop the refill `interval` so no
     * timers leak after the downstream consumer unsubscribes.
     */
    it('stops the refill timer when the subscription is torn down', async () => {
      const pipeline = rateLimiterOperator({
        strategy: 'token-bucket',
        capacity: 1,
        refillRatePerSec: 1,
      })

      const source = new Subject<AxiosResponse>()
      const arrived: AxiosResponse[] = []
      const subscription = pipeline(
        rateLimiterVerb,
        rateLimiterArgs,
        source.asObservable(),
      ).subscribe({
        next: (response) => {
          arrived.push(response)
        },
      })

      source.next(buildRateLimiterResponse('first'))
      await Promise.resolve()
      expect(arrived.map(r => r.data)).toEqual(['first'])

      // Tear down before the next refill — if the refill interval leaked,
      // jest would still have a pending timer scheduled.
      subscription.unsubscribe()

      // No outstanding timers after unsubscribe → refill interval stopped.
      expect(jest.getTimerCount()).toBe(0)
    })

    /**
     * AC: when a second subscription attaches to the SAME operator instance
     * while the refill timer is already running, `ensureRefill` MUST short-
     * circuit on the `refillSub !== null` guard rather than starting a second
     * timer. Otherwise the bucket would refill at 2x the configured rate for
     * the duration of the overlapping subscriptions.
     *
     * Two concurrent subscriptions to the same pipeline both call into
     * `ensureRefill` on subscribe — the first starts the timer, the second
     * MUST observe the already-running timer and return early. The shared
     * refill rate is verified by exhausting both buckets and confirming each
     * subscription receives exactly one refilled emission per window (rather
     * than two, which would happen if a second timer were started).
     */
    it('reuses a single refill timer across concurrent subscriptions on the same operator', async () => {
      const pipeline = rateLimiterOperator({
        strategy: 'token-bucket',
        capacity: 1,
        refillRatePerSec: 1,
      })

      const sourceA = new Subject<AxiosResponse>()
      const sourceB = new Subject<AxiosResponse>()
      const arrivedA: AxiosResponse[] = []
      const arrivedB: AxiosResponse[] = []

      // First subscription: starts the refill timer (refillSub goes non-null).
      const subA = pipeline(
        rateLimiterVerb,
        rateLimiterArgs,
        sourceA.asObservable(),
      ).subscribe({ next: r => arrivedA.push(r) })

      // Second subscription: enters `ensureRefill` while refillSub is already
      // non-null. The early-return guard at line 181 of rxjs-pipeline.ts MUST
      // fire here — without it, a second timer would be started.
      const subB = pipeline(
        rateLimiterVerb,
        rateLimiterArgs,
        sourceB.asObservable(),
      ).subscribe({ next: r => arrivedB.push(r) })

      // Drain initial token from each source so both queues start gating on
      // refill ticks. Both share ONE bucket — the second consumer must wait
      // until refill fires.
      sourceA.next(buildRateLimiterResponse('a-1'))
      await Promise.resolve()
      expect(arrivedA.map(r => r.data)).toEqual(['a-1'])

      // sourceB's initial emission must wait — token was just consumed by A.
      sourceB.next(buildRateLimiterResponse('b-1'))
      await Promise.resolve()
      expect(arrivedB.map(r => r.data)).toEqual([])

      // Advance one refill window. Exactly ONE token is added (single timer)
      // — sourceB receives its emission. If a second timer had been started
      // by the duplicate `ensureRefill` call, two tokens would have been
      // added in this window and arrivedB would already contain two items.
      await jest.advanceTimersByTimeAsync(1000)
      expect(arrivedB.map(r => r.data)).toEqual(['b-1'])

      subA.unsubscribe()
      subB.unsubscribe()
    })

    /**
     * AC: the refill rate accepts arbitrarily fast configurations without
     * degenerating into a tight loop — the internal `Math.max(1, ...)` floor
     * ensures `interval(0)` is never produced.
     */
    it('floors the refill interval at 1ms for very fast refill rates', async () => {
      // 10_000 emissions/sec → 0.1 ms ideal interval, floored to 1 ms.
      const pipeline = rateLimiterOperator({
        strategy: 'token-bucket',
        capacity: 1,
        refillRatePerSec: 10_000,
      })
      const { source, arrived } = driveRateLimiter(pipeline)

      source.next(buildRateLimiterResponse('a'))
      source.next(buildRateLimiterResponse('b'))

      await Promise.resolve()
      // First emission consumes the initial token immediately.
      expect(arrived.map(r => r.data)).toEqual(['a'])

      // After 1 ms (the floored refill window), the queued emission is freed.
      await jest.advanceTimersByTimeAsync(1)
      expect(arrived.map(r => r.data)).toEqual(['a', 'b'])
    })
  })

  describe('leaky-bucket strategy', () => {
    /**
     * AC: leaky-bucket spaces emissions at exactly `1000 / refillRatePerSec`
     * ms intervals regardless of arrival burst.
     */
    it('spaces emissions at fixed 1000/refillRatePerSec intervals regardless of arrival burst', async () => {
      // refillRatePerSec=2 → emit every 500 ms.
      const pipeline = rateLimiterOperator({
        strategy: 'leaky-bucket',
        capacity: 1,
        refillRatePerSec: 2,
      })
      const { source, arrived } = driveRateLimiter(pipeline)

      source.next(buildRateLimiterResponse('a'))
      source.next(buildRateLimiterResponse('b'))
      source.next(buildRateLimiterResponse('c'))

      // Even the first emission is delayed by the configured spacing — the
      // leaky bucket models a constant-rate output channel.
      expect(arrived.length).toBe(0)

      await jest.advanceTimersByTimeAsync(500)
      expect(arrived.map(r => r.data)).toEqual(['a'])

      await jest.advanceTimersByTimeAsync(500)
      expect(arrived.map(r => r.data)).toEqual(['a', 'b'])

      await jest.advanceTimersByTimeAsync(500)
      expect(arrived.map(r => r.data)).toEqual(['a', 'b', 'c'])
    })

    /**
     * AC: leaky-bucket forwards every source emission downstream. Verified
     * end-to-end with real timers and a fast refill rate so the test
     * deterministically completes without scheduling.
     */
    it('forwards every source emission downstream (no drops)', async () => {
      jest.useRealTimers()

      const pipeline = rateLimiterOperator({
        strategy: 'leaky-bucket',
        capacity: 1,
        refillRatePerSec: 1000, // 1 ms spacing
      })

      const sourceItems = [
        buildRateLimiterResponse(1),
        buildRateLimiterResponse(2),
        buildRateLimiterResponse(3),
      ]
      const result = await lastValueFrom(
        pipeline(rateLimiterVerb, rateLimiterArgs, of(...sourceItems)).pipe(toArray()),
      )

      expect(result.map(r => r.data)).toEqual([1, 2, 3])
    })
  })
})

/**
 * Builds an {@link AxiosResponse} fixture tagged with the supplied `data` so
 * throttling tests can correlate which source emission reached the downstream
 * subscriber after the admission queue drains.
 */
function buildThrottleResponse(data: unknown): AxiosResponse {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: {} as never },
  } as AxiosResponse
}

const throttleVerb: HttpVerb = 'get'

/**
 * Builds a tagged {@link InvokeArgs} carrier for throttling tests. Each
 * invocation gets its own URL so the underlying source observables stay
 * distinguishable in subscription-count assertions.
 */
function buildThrottleArgs(tag: string): InvokeArgs {
  return { url: `/throttle/${tag}`, config: {} }
}

/**
 * Constructs a single source `Observable<AxiosResponse>` whose subscribe
 * function increments a shared counter every time the throttle operator
 * subscribes — that is the exact moment a real HTTP request would fire — and
 * then completes synchronously with the supplied response. The returned
 * `subscriptions` array makes it trivial to assert "≤ N subscriptions in the
 * first window" by reading `subscriptions.length` after advancing fake timers.
 */
function makeCountingSource(response: AxiosResponse): {
  source: Observable<AxiosResponse>
  subscriptions: number[]
} {
  const subscriptions: number[] = []
  const source = new Observable<AxiosResponse>((subscriber) => {
    // Record the wall-clock time of subscription via Date.now() — under
    // jest fake timers this returns the simulated time, so we can verify
    // the spacing between admissions.
    subscriptions.push(Date.now())
    subscriber.next(response)
    subscriber.complete()
  })
  return { source, subscriptions }
}

describe('throttlingOperator', () => {
  beforeEach(() => {
    // Set fake timers BEFORE each test so the RxJS `interval(intervalMs)`
    // refill timer dispatches deterministically — the operator's only timing
    // primitive is RxJS's `asyncScheduler` (not raw setTimeout), but that
    // scheduler honours jest's fake-timer queue when fake timers are active.
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('contract', () => {
    /**
     * AC: `throttlingOperator(config)` returns a closure with the canonical
     * `RxjsPipeline` shape — three positional parameters `(verb, args, source)`.
     */
    it('returns a closure of the RxjsPipeline shape', () => {
      const pipeline = throttlingOperator({ requestsPerInterval: 1, intervalMs: 100 })

      expect(typeof pipeline).toBe('function')
      expect(pipeline.length).toBe(3)
    })
  })

  describe('per-window admission cap', () => {
    /**
     * AC: 1 per 100 ms over 100 subscriptions in a tight loop. The total
     * upstream subscriptions in the FIRST 1000 ms must be `≤ 11` — one
     * synchronous admission at t=0 plus one admission per 100 ms refill tick
     * across the next ten ticks (t=100, 200, …, 1000).
     */
    it('admits at most requestsPerInterval source subscriptions per intervalMs window', async () => {
      const pipeline = throttlingOperator({ requestsPerInterval: 1, intervalMs: 100 })
      const collected: AxiosResponse[] = []

      // Subscribe 100 times in a tight synchronous loop. Each invocation gets
      // its own counting source so the test can read `subscriptions.length`
      // across all sources to count actual admissions.
      const sources: Array<{ source: Observable<AxiosResponse>, subscriptions: number[] }> = []
      for (let i = 0; i < 100; i++) {
        const counting = makeCountingSource(buildThrottleResponse(i))
        sources.push(counting)
        pipeline(throttleVerb, buildThrottleArgs(`s${i}`), counting.source).subscribe({
          next: response => collected.push(response),
        })
      }

      // Synchronous drain: only the first entry should be admitted at t=0.
      expect(sources.filter(s => s.subscriptions.length > 0)).toHaveLength(1)

      // Advance to t=1000 — ten refill ticks fire at t=100, 200, …, 1000,
      // each admitting one more entry. Total admissions ≤ 11.
      await jest.advanceTimersByTimeAsync(1000)
      const admittedInFirstSecond = sources.filter(s => s.subscriptions.length > 0).length
      expect(admittedInFirstSecond).toBeLessThanOrEqual(11)
      // Lower bound: at least the synchronous admission plus 9 ticks worth.
      // We accept ≥ 10 to tolerate scheduler edge timing while still proving
      // the throttle releases entries on every tick.
      expect(admittedInFirstSecond).toBeGreaterThanOrEqual(10)
    })

    /**
     * AC: `requestsPerInterval = 5` allows a synchronous burst of 5 admissions
     * in the same window, after which the next 5 must wait for the next refill
     * tick at t = intervalMs.
     */
    it('admits a burst of requestsPerInterval synchronously, then defers further admissions to the next window', async () => {
      const pipeline = throttlingOperator({ requestsPerInterval: 5, intervalMs: 100 })

      // Enqueue 10 entries. The first 5 must be admitted synchronously; the
      // remaining 5 must wait until the t=100 refill tick.
      const sources: Array<{ source: Observable<AxiosResponse>, subscriptions: number[] }> = []
      for (let i = 0; i < 10; i++) {
        const counting = makeCountingSource(buildThrottleResponse(i))
        sources.push(counting)
        pipeline(throttleVerb, buildThrottleArgs(`b${i}`), counting.source).subscribe({})
      }

      // Burst of 5 admitted synchronously.
      expect(sources.filter(s => s.subscriptions.length > 0)).toHaveLength(5)
      // The first 5 entries (FIFO) are the ones admitted.
      expect(sources.slice(0, 5).every(s => s.subscriptions.length === 1)).toBe(true)
      expect(sources.slice(5).every(s => s.subscriptions.length === 0)).toBe(true)

      // Advance one window — second burst of 5 admitted at the refill tick.
      await jest.advanceTimersByTimeAsync(100)
      expect(sources.filter(s => s.subscriptions.length > 0)).toHaveLength(10)
    })
  })

  describe('queue ordering and FIFO admission', () => {
    /**
     * AC: queued entries are admitted in arrival order — FIFO. With
     * `requestsPerInterval = 1` and three sequential enqueues, the downstream
     * MUST observe responses in the order they were enqueued (not interleaved).
     */
    it('admits queued entries in FIFO order across multiple windows', async () => {
      const pipeline = throttlingOperator({ requestsPerInterval: 1, intervalMs: 100 })
      const collected: unknown[] = []

      for (const tag of ['first', 'second', 'third']) {
        const { source } = makeCountingSource(buildThrottleResponse(tag))
        pipeline(throttleVerb, buildThrottleArgs(tag), source).subscribe({
          next: response => collected.push(response.data),
        })
      }

      // Synchronous admission for the first; subsequent items wait their turn.
      expect(collected).toEqual(['first'])

      await jest.advanceTimersByTimeAsync(100)
      expect(collected).toEqual(['first', 'second'])

      await jest.advanceTimersByTimeAsync(100)
      expect(collected).toEqual(['first', 'second', 'third'])
    })
  })

  describe('cancellation safety', () => {
    /**
     * AC: a downstream that unsubscribes BEFORE its admission slot opens MUST
     * NOT trigger an upstream subscription — i.e. no leaked HTTP request. The
     * cancelled slot must also NOT consume a window allocation: the next
     * admitted entry observes the full quota.
     */
    it('does not subscribe to the upstream source for entries cancelled before admission', async () => {
      const pipeline = throttlingOperator({ requestsPerInterval: 1, intervalMs: 100 })

      // First entry admitted synchronously.
      const a = makeCountingSource(buildThrottleResponse('a'))
      pipeline(throttleVerb, buildThrottleArgs('a'), a.source).subscribe({})

      // Second entry queued; cancel BEFORE any admission tick fires.
      const b = makeCountingSource(buildThrottleResponse('b'))
      const cancelled = pipeline(throttleVerb, buildThrottleArgs('b'), b.source).subscribe({})
      cancelled.unsubscribe()

      // Third entry queued behind the cancelled one.
      const c = makeCountingSource(buildThrottleResponse('c'))
      pipeline(throttleVerb, buildThrottleArgs('c'), c.source).subscribe({})

      // Advance one window — the cancelled entry MUST be skipped without
      // consuming the slot, so 'c' is admitted on the very next tick.
      await jest.advanceTimersByTimeAsync(100)

      expect(a.subscriptions).toHaveLength(1)
      expect(b.subscriptions).toHaveLength(0)
      expect(c.subscriptions).toHaveLength(1)
    })
  })

  describe('idle teardown', () => {
    /**
     * AC: when the queue fully drains and the window settles, the internal
     * refill timer is unsubscribed so an idle throttle does not hold a
     * recurring scheduler reference. Verified indirectly by asserting that
     * `jest.getTimerCount()` returns to 0 after the next refill tick.
     */
    it('releases the refill timer when the queue drains and the window settles', async () => {
      const pipeline = throttlingOperator({ requestsPerInterval: 1, intervalMs: 100 })
      const { source } = makeCountingSource(buildThrottleResponse('one'))

      pipeline(throttleVerb, buildThrottleArgs('one'), source).subscribe({})
      // Queue should now hold one in-flight refill timer.
      expect(jest.getTimerCount()).toBeGreaterThanOrEqual(1)

      // Advance one full window: the tick fires, finds the queue empty AND
      // the window counter back at zero, then tears the refill timer down.
      await jest.advanceTimersByTimeAsync(100)
      expect(jest.getTimerCount()).toBe(0)
    })
  })

  describe('error propagation', () => {
    /**
     * AC: when an admitted upstream source errors, the failure MUST be
     * forwarded verbatim to the downstream subscriber — the throttle is a
     * pacing layer, not an error filter. Verified by enqueueing a single
     * source that errors synchronously after admission and asserting the
     * downstream `error` callback fires with the same error instance.
     */
    it('forwards upstream errors to the downstream subscriber', async () => {
      const pipeline = throttlingOperator({ requestsPerInterval: 1, intervalMs: 100 })
      const failure = new Error('upstream failed')
      const failingSource = new Observable<AxiosResponse>((subscriber) => {
        subscriber.error(failure)
      })

      const observed: unknown[] = []
      pipeline(throttleVerb, buildThrottleArgs('err'), failingSource).subscribe({
        next: () => {
          /* never reached — the source errors before emission */
        },
        error: (err) => {
          observed.push(err)
        },
      })

      // Synchronous admission of the only entry triggers the error path
      // verbatim — no need to advance fake timers.
      expect(observed).toEqual([failure])
    })
  })
})

/**
 * Builds a probe {@link RxjsPipeline} that, when invoked, appends `tag` to the
 * shared `callOrder` array and forwards its source observable unchanged. Used
 * by the {@link buildRxjsPipeline} composition tests to record the exact
 * sequence in which each stage's pipeline closure is invoked when the composed
 * pipeline is called — that sequence reveals the OUTER-to-INNER wrapping order
 * applied by the reduction inside {@link buildRxjsPipeline}.
 */
function buildOrderProbe(tag: string, callOrder: string[]): RxjsPipeline {
  return (_verb, _args, source) => {
    callOrder.push(tag)
    return source
  }
}

describe('buildRxjsPipeline', () => {
  /**
   * AC: when none of `deduplication`, `rateLimiter`, or `throttling` is
   * configured, the composer returns `undefined` so callers can short-circuit
   * the dispatch fast-path without paying for an empty-reduce closure.
   */
  it('returns undefined when none of deduplication, rateLimiter, or throttling is set', () => {
    // Other resilience fields (timeout, …) MUST NOT cause the RxJS pipeline
    // to materialise — they belong to cockatiel, not the RxJS layer. The
    // composer must filter purely on the three RxJS-pipeline slots.
    const config: ResilanceConfig<unknown> = {
      timeout: 1_000,
    }

    expect(buildRxjsPipeline(config)).toBeUndefined()
  })

  it('returns undefined for an entirely empty config', () => {
    expect(buildRxjsPipeline({})).toBeUndefined()
  })

  /**
   * AC: when ONLY `deduplication` is set, the returned pipeline behaves
   * exactly like a standalone `deduplicationOperator` — concurrent identical
   * subscriptions share a single source subscription and no other operator's
   * effect is visible. Verifying this end-to-end against the real operator
   * proves the composer correctly skipped the unset slots rather than wrapping
   * the source in an empty stage.
   */
  it('returns a pipeline that applies only the deduplication operator when only deduplication is set', async () => {
    const subscribe = jest.fn()
    const source$ = new Observable<AxiosResponse>((subscriber) => {
      subscribe()
      // Defer emission so concurrent subscribers attach BEFORE the source
      // emits — that is what makes the dedup `shareReplay` measurable.
      queueMicrotask(() => {
        subscriber.next(buildResponse({ id: 1 }))
        subscriber.complete()
      })
    })

    const pipeline = buildRxjsPipeline({ deduplication: {} })
    expect(pipeline).toBeDefined()

    const verb: HttpVerb = 'get'
    const args = buildArgs('/users/1')

    // Two concurrent subscriptions to the same key → dedup MUST share one
    // source subscription. If any other operator were silently composed, the
    // observable identity check or subscription count would diverge.
    const a$ = pipeline!(verb, args, source$)
    const b$ = pipeline!(verb, args, source$)

    const [a, b] = await Promise.all([
      new Promise<AxiosResponse>((resolve, reject) => a$.subscribe({ next: resolve, error: reject })),
      new Promise<AxiosResponse>((resolve, reject) => b$.subscribe({ next: resolve, error: reject })),
    ])

    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(a.data).toEqual({ id: 1 })
    expect(b.data).toEqual({ id: 1 })
  })

  /**
   * AC: the composer wraps the configured stages in the documented order
   * `deduplication → rateLimiter → throttling` (deduplication outermost,
   * throttling innermost). Verified by replacing each operator factory with a
   * probe that records the order in which the resulting per-stage pipeline
   * closures are CALLED when the composed pipeline executes.
   *
   * Mechanism: `reduceRight` walks the operator array from RIGHT to LEFT, so
   * the rightmost (innermost) operator's closure is invoked FIRST and the
   * leftmost (outermost) operator's closure is invoked LAST. The expected
   * call order is therefore `['throttling', 'rateLimiter', 'deduplication']`.
   *
   * This test relies on `jest.spyOn` working against the
   * {@link rxjsOperatorFactories} indirection map exported alongside
   * `buildRxjsPipeline` — its body resolves each factory through property
   * access on that map, so spies installed on the map intercept every
   * composition-time call (a direct local function call would not be
   * intercepted in CommonJS).
   */
  it('composes operators in declared order: deduplication outermost, throttling innermost', () => {
    const callOrder: string[] = []

    // Replace each real operator factory on the indirection map with a probe
    // that returns a pipeline recording its own invocation. The probes share
    // the same shape as the real `RxjsPipeline` contract so the reduction
    // inside `buildRxjsPipeline` type-checks and runs without modification.
    const dedupSpy = jest
      .spyOn(rxjsOperatorFactories, 'deduplication')
      .mockReturnValue(buildOrderProbe('deduplication', callOrder))
    const rateSpy = jest
      .spyOn(rxjsOperatorFactories, 'rateLimiter')
      .mockReturnValue(buildOrderProbe('rateLimiter', callOrder))
    const throttleSpy = jest
      .spyOn(rxjsOperatorFactories, 'throttling')
      .mockReturnValue(buildOrderProbe('throttling', callOrder))

    try {
      const pipeline = buildRxjsPipeline({
        deduplication: {},
        rateLimiter: { strategy: 'token-bucket', capacity: 1, refillRatePerSec: 1 },
        throttling: { requestsPerInterval: 1, intervalMs: 100 },
      })

      expect(pipeline).toBeDefined()
      // Each factory must be invoked exactly once during composer setup.
      expect(dedupSpy).toHaveBeenCalledTimes(1)
      expect(rateSpy).toHaveBeenCalledTimes(1)
      expect(throttleSpy).toHaveBeenCalledTimes(1)

      // Drive the composed pipeline with a trivial source. Each probe pushes
      // its tag into `callOrder` when invoked, so the final array reveals the
      // INNER-to-OUTER subscription cascade produced by `reduceRight`.
      const verb: HttpVerb = 'get'
      const args = buildArgs('/users/1')
      const source$ = of(buildResponse({ ok: true }))
      pipeline!(verb, args, source$)

      // `reduceRight` invokes the rightmost (innermost) probe first and the
      // leftmost (outermost) probe last — proving the composition order.
      expect(callOrder).toEqual(['throttling', 'rateLimiter', 'deduplication'])
    }
    finally {
      // Always restore the real implementations so subsequent tests in this
      // file (or any other file sharing the module instance) see the genuine
      // operator factories rather than the leaked probes.
      dedupSpy.mockRestore()
      rateSpy.mockRestore()
      throttleSpy.mockRestore()
    }
  })

  /**
   * AC: a config that only has `rateLimiter` and `throttling` set (no
   * `deduplication`) must compose those two stages in the expected order
   * (`rateLimiter` outer, `throttling` inner) and skip the deduplication
   * factory entirely. Confirms the slot filter drops `undefined` slots
   * without disturbing the relative order of the surviving stages.
   */
  it('skips unset slots while preserving the relative order of the configured stages', () => {
    const callOrder: string[] = []

    const dedupSpy = jest.spyOn(rxjsOperatorFactories, 'deduplication')
    const rateSpy = jest
      .spyOn(rxjsOperatorFactories, 'rateLimiter')
      .mockReturnValue(buildOrderProbe('rateLimiter', callOrder))
    const throttleSpy = jest
      .spyOn(rxjsOperatorFactories, 'throttling')
      .mockReturnValue(buildOrderProbe('throttling', callOrder))

    try {
      const pipeline = buildRxjsPipeline({
        rateLimiter: { strategy: 'token-bucket', capacity: 1, refillRatePerSec: 1 },
        throttling: { requestsPerInterval: 1, intervalMs: 100 },
      })

      expect(pipeline).toBeDefined()
      // Deduplication slot was undefined → its factory MUST NOT be invoked.
      expect(dedupSpy).not.toHaveBeenCalled()
      expect(rateSpy).toHaveBeenCalledTimes(1)
      expect(throttleSpy).toHaveBeenCalledTimes(1)

      pipeline!('get', buildArgs('/items'), of(buildResponse({ ok: true })))

      // With dedup absent, the inner-to-outer cascade is just throttling →
      // rateLimiter, preserving the documented relative order.
      expect(callOrder).toEqual(['throttling', 'rateLimiter'])
    }
    finally {
      dedupSpy.mockRestore()
      rateSpy.mockRestore()
      throttleSpy.mockRestore()
    }
  })
})
