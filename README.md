# NestJS HTTP Client

Zero-configuration resilience and transient-fault-handling HTTP Client that wraps official @nestjs/axios library

## Patterns

Implements following resilience patterns:

- Retry - Supports sync/async operations with exponential backoff, jitter, and custom retry conditions
- Circuit Breaker - Configurable failure rate thresholds, slow call detection, and half-open state management
- Timeout - Pessimistic and optimistic timeout patterns
- Rate Limiter - Token bucket and leaky bucket implementations
- Time Limiter - Timeout handling with cancellation support
- Bulkhead - Thread-pool and semaphore isolation to limit concurrent calls
- Fallback - Graceful degradation strategies
- Conditional Retries - Fine-grained control via retry_if_exception, retry_if_result
- Stop Strategies - stop_after_attempt, stop_after_delay, stop_never
- Wait Strategies - Fixed, exponential, random, and custom wait functions
- Before/After Hooks - Logging and metrics integration points

## Additional features

- Cache - In-memory and distributed caching
- OpenTelemetry - Deep integration with OpenTelemetry
- Zero-configuration - By default enabled resilence setup that suitable for majority of workloads

## Development

- Install dependencies:

```bash
npm install
```

- Run the unit tests:

```bash
npm run test
```

- Build the library:

```bash
npm run build
```



## Special Thanks

Library esentially is reimplementation of following libraries for NestJS:

- [Resilience4j](https://github.com/resilience4j/resilience4j)
- [Polly](https://github.com/App-vNext/Polly)
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

## License

GNU Affero General Public License v3.0
