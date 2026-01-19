---
name: resilience-engineering
description: Resailience engineering skills that contain explanation of main resilience patterns and policies.
---

# Transient fault handling and proactive resilience engineering

This skill based on [Polly library wiki](https://github.com/App-vNext/Polly/wiki). More information about resilience engineering can be found there.

Today's cloud-based, microservice-based or internet-of-things applications often depend on communicating with other systems across an [unreliable network](https://en.wikipedia.org/wiki/Fallacies_of_distributed_computing).

Such systems can be unavailable or unreachable due to transient faults such as network problems and timeouts, or subsystems being offline, under load or otherwise non-responsive.

The [resilience policies offered by Polly](https://github.com/App-vNext/Polly/tree/7.2.4#resilience-policies) provide a range of **reactive** strategies for dealing with transient faults and **preemptive** and **proactive** strategies for promoting resilience and stability.

## Handling transient faults with retry and circuit-breaker

Transient faults are errors whose cause is expected to be a temporary condition such as temporary service unavailability or network connectivity issues.

### Retry

[Retry](Retry) allows callers to retry operations in the expectation that many faults are transient and may self-correct: the operation may succeed if retried, possibly after a short delay.

[Waiting between retries](https://github.com/App-vNext/Polly/tree/7.2.4#wait-and-retry) allows faults time to self-correct. Practices such as [exponential backoff](Retry#exponential-backoff) and [jitter](Retry-with-jitter) refine this by scheduling retries to prevent them becoming sources of further load or spikes.

### Circuit-Breaker

A circuit breaker detects the level of faults in calls placed through it, and prevents calls when a configurable fault threshold is exceeded.

While retrying plays for success, faults do arise where retries are not likely to succeed or may be counter-productive - for example, where a subsystem is completely offline, or struggling under load.

In such cases additional retries may be inappropriate, either because they have no chance of succeeding, or because they may just place additional load on the called system.

A further ramification is that if a caller is unable to detect that a downstream system is unavailable, it may itself queue up large numbers of pending requests and retries.  Resources in the caller may then become exhausted or excessively blocked, waiting for replies which will never come.  In the worst case, this could consume so much resource that the caller in turn fails - an upstream-cascading failure.

Callers thus need a way to detect - and react - when a downstream system's faulting is _not_ transient.  [Circuit Breaker](Circuit-Breaker) presents a strategy for this.

#### How does circuit-breaker work?

A circuit breaker detects the level of faults in calls placed through it, and prevents calls when a configurable fault threshold is reached.

When faults exceed the threshold, the circuit breaks (opens).  While open, calls placed through the circuit, instead of being actioned, fail fast, throwing an exception immediately. (The call is not attempted at all.)  This both protects a significantly faulting downstream system from extra load, and allows the upstream system to avoid placing calls which are unlikely to succeed.  Failing fast in this scenario usually also promotes a better user experience.

After a configured period, the circuit moves to a half-open state, where the next call will be treated as a trial to determine the downstream system's health.  On the basis of this trial call, the breaker decides whether to close the circuit (resume normal operation) or break again.

The analogy is with a circuit-breaker in electrical wiring: significant faults will 'trip' the circuit, protecting systems governed by the circuit.

### Fallback

A **[Fallback](Fallback) policy** defines how the operation should react if, despite retries - or because of a broken circuit - the underlying operation fails.  Like retry and circuit-breaker, a fallback policy is reactive in that it responds to defined faults.  Fallback policies can be used to provide a substitute, pre-canned response for failed calls, or for more complex remedial action.

## Promoting resilience through a proactive, stability-oriented approach

Retry and circuit-breaker are primary strategies for resilience to transient faults, but both are **reactive** in the sense that they react once the failure response to a call has been received.

What though if that response never comes - or is so delayed that we do not wish to continue waiting?  And what if that delay - waiting, waiting to react - could itself store up problems?  Can we be more pro-active in our approach to resource management and resilience?  Consider that in a high-throughput system, many calls can be put through to a recently-failed system before the first timeout is received.  For example, with 50 calls/second to a downstream system on which a 10-second timeout is imposed, 500 calls could be in flight in parallel (assuming no other limitations) before the first timeout is received.  A circuit-breaker will react to this scenario as soon as sufficient failures are received, but a resource bulge can certainly occur before then.

While Retry and Circuit-Breaker are reactive, **Timeout**, **Bulkhead** and **Caching** policies offer **preemptive** and **proactive** strategies: they increase resilience for high-throughput systems by explicitly managing load for stability.

### Timeout

[Timeout](Timeout) allows callers to walk away from a pending call.  This primary benefit improves resilience, and user experience, by freeing callers when a response no longer seems likely.

Additionally, as the numerical examples show, choice of timeouts can influence resource consumption in a faulting, high-throughput system.  Given it is often the blocking up of threads or connections - and the memory those pending calls consume - which causes further failure, consider how long you want to let your pending calls consume those resources.

### Bulkhead

Excessive load is a primary cause of system instability and failure.  Building resilience thus involves explicitly managing that load and/or pro-actively scaling to support it.

Excessive load can either be due to genuine external demand (for example spikes in user traffic), or, as previously described, due to faulting scenarios, where large numbers of calls back up.

[Bulkhead](Bulkhead) strategies promote stability by directly managing load and thus resource consumption.  The Polly Bulkhead is a simple parallelism throttle: it limits parallelism of calls placed through it, with the option to queue and/or reject excess calls.

#### Bulkhead as isolation

A **bulkhead** is a section of a ship which can be sealed off from others.  If the ship is holed in one place, that bulkhead section can be sealed, other sections will not flood, and the whole ship will not sink.

Similarly, placing a bulkhead policy - a parallelism limit - around one stream of calls, limits the resource that stream of calls can consume. If that stream faults, it cannot consume all resources in the host and thus bring down the whole host.

#### Bulkhead as load segregation and relative resource allocation

More than one Bulkhead policy can also be used in the same process to achieve **load segregation** and **relative resource allocation**.

A good metaphor here is the check-out lanes of supermarkets or grocery stores: there are often separate lanes for "baskets only" (or "8 items or fewer"), as opposed to full shopping carts.  For example, two lanes might be allocated to "baskets only" while six are for full carts.

The segregation allows those with baskets-only always to check-out quickly.  Without this, they could be starved of options, blocked waiting behind an excess of full shopping carts.

Using multiple bulkhead policies to separate software operations provides similar benefits, both in terms of relative resource allocation for different call streams; and in guaranteeing one kind of call cannot wholly prevent (or excessively starve) another.

#### Bulkhead as load-shedding

Bulkhead policies can also be used to **proactively shed load** (reject calls) beyond a certain limit.

Why actively reject calls, when the host might yet have more capacity to service them?  The answer is it depends [whether you prefer managed or unmanaged failure](http://bravenewgeek.com/take-it-to-the-limit-considerations-for-building-reliable-systems/).  Prescribing explicit limits (while setting those limits to make good utilisation of available resource) enables your systems to fail in predictable, testable ways.  Leaving systems unbounded doesn't mean there isn't a limit: it just means you don't know where that limit is; and your system is instead liable to unpredictable, unexpected failure.

#### Bulkhead as a trigger for scaling out

While **load shedding** is a strong proactive resilience practice to pre-empt resource exhaustion, it is not of course the only response to growing load.  Bulkhead utilization or queue size can also be monitored as a trigger for adding capacity - **horizontal scaling** - just as a supermarket might open extra lanes at times of high demand.  The key here is to detect the growing load is not in response to faulting calls: load and fault-rate need to be monitored in combination.

To round up the different aspects of bulkhead with an airline departures hall metaphor: a first response to growing load might be horizontal scaling (open another check-in desk), but if capacity was exhausted (all desks in use) and load still excessive (too many people in the departures hall), it would be preferable to shed load proactively in a planned manner (ask some people to queue on the pavement outside) than have no plan, and risk a potentially more dangerous failure (say, dangerous overcrowding inside the departures hall).

### Cache

Anything that reduces network traffic and overall call duration increases resilience and improves user experience.  [Caching](Cache) provides the ability to not place calls at all - or obtain answers from a nearer-by network resource - if you may know the answer already.

Caching can be used with multiple caches - in-memory/local caches and distributed caches - in combination.  Polly CachePolicy supports multiple caches in the same call, using [PolicyWrap](PolicyWrap).

### Fallback

Although Fallback policy has been covered earlier, as it is rightly a reactive policy, it's worth revisiting now that we have considered all the other resilience options.

However well resilience-engineered your system, failures will happen.  [Fallback](Fallback) means defining what you will do when that happens: plan for failure, rather than leave it to have unpredictable effects on your system.
