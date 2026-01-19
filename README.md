# NestJS HTTP Client

Zero-configuration resilience and transient-fault-handling HTTP Client that extends official @nestjs/axios library.

## Features

- OpenTelemetry - Deep integration with OpenTelemetry
- Zero-configuration - By default enabled resilence setup that suitable for majority of workloads

### Resilience Patterns

Client default configuration assumes that API you are calling is good and capable of unlimited parallel processing of requests, until it's not. By default enabled only reactive resilience patterns, with reasonable exceptions, for example Timeout policy. On top of that retry mechanism is work based on type and status of requests. It will try to retry only idempotent requests: GET, HEAD, OPTIONS. And only for 5xx status codes. While PUT, DELETE also considered idempotent in properly implemented RESTfull API, in reality they usualy not. This default strategy is called "Conservative". But you also can enable other that make reasonable assumptions about your API, for example "Restfull" or "Low Quality".

#### Reactive Resilience Patterns

These are primary strategies for resilience to transient faults, they are reactive in the sense that they react once the failure response to a call has been received.

- Retry - Supports sync/async operations with exponential backoff, jitter, and custom retry conditions
- Circuit Breaker - Configurable failure rate thresholds, slow call detection, and half-open state management

#### Proactive Resilience Patterns

These policies offer preemptive and proactive strategies: they increase resilience for high-throughput systems by explicitly managing load for stability.

- Timeout - Pessimistic and optimistic timeout patterns
- Bulkhead - Thread-pool and semaphore isolation to limit concurrent calls
- Cache - In-memory and distributed caching

#### Other Patterns

TODO: distribute them to first 2 categories

- Rate Limiter - Token bucket and leaky bucket implementations
- Time Limiter - Timeout handling with cancellation support
- Throttling - Limit the number of requests to a service
- Fallback - Graceful degradation strategies
- Conditional Retries - Fine-grained control via retry_if_exception, retry_if_result
- Stop Strategies - stop_after_attempt, stop_after_delay, stop_never
- Wait Strategies - Fixed, exponential, random, and custom wait functions
- Health Checks - Health checks for the service
- Deduplication - Deduplicate requests to the same endpoint
- Before/After Hooks - Logging and metrics integration points

## Configuration Strategies

Conservative strategy is default, and rest of strategies are based on it.

### Conservative

Default strategy that makes reasonable assumptions about API you are calling. For example it is probaly mainly follows REST, but makes common mistakes. Specific assumptions are:

- Timeout is 5 seconds.
- GET, HEAD, OPTIONS are idempotent and will be retried 3 times only for 5xx status codes, with exponential backoff.
- PUT, DELETE, PATCH, POST are not idempotent and will not be retried.

### Restfull

Assume that API you are calling is RESTfull and we can trust on methods and status codes.

- Timeout is 2 seconds.
- GET, HEAD, OPTIONS, PUT, DELETE are idempotent and will be retried 3 times only for 5xx status codes, with exponential backoff.
- PATCH, POST are not idempotent and will not be retried, with exponential backoff.

### Low Quality

Assume that API you are calling is low quality, it need much time for processing and usually fails without obvious reason. Specific assumptions are:

- Timeout is 30 second.
- GET, HEAD, OPTIONS are idempotent and will be retried 3 times only for 5xx status codes, with exponential backoff.
- PUT, DELETE, PATCH, POST are not idempotent and will not be retried.

## Special Thanks

Library esentially is reimplementation of following libraries for NestJS:

- [Resilience4j](https://github.com/resilience4j/resilience4j)
- [Polly](https://github.com/App-vNext/Polly) - and great article about [resilience patterns](https://github.com/App-vNext/Polly/wiki/Transient-fault-handling-and-proactive-resilience-engineering)
- [Failsafe](https://github.com/failsafe-lib/failsafe)
- [Tenacity](https://github.com/jd/tenacity)
- [Gobreaker](https://github.com/sony/gobreaker)

Patterns implementation is based or using following libraries:

- [Cockatiel](https://github.com/connor4312/cockatiel)
- [Opossum](https://github.com/nodeshift/opossum)
- [Axios Retry](https://github.com/softonic/axios-retry)
- [Ofetch](https://github.com/unjs/ofetch)
- [Keyv](https://github.com/jaredwray/keyv)
- [P-Retry](https://github.com/sindresorhus/p-retry)
- [NestJS Resilience](https://github.com/SocketSomeone/nestjs-resilience)
- [NestJS OpenTelemetry](https://github.com/MetinSeylan/Nestjs-OpenTelemetry)
- [NestJS OTEL](https://github.com/pragmaticivan/nestjs-otel)
- [NestJS Omacache](https://github.com/BJS-kr/nestjs-omacache)
- [NestJS HTTP Promise](https://github.com/benhason1/nestjs-http-promise)
