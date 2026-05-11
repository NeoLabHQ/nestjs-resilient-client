// Runtime client classes
export { BaseHttpService } from './client/base-http.service'
export { HookableHttpService } from './client/hookable-http.service'
export { RestClient } from './client/rest.client'
export { RestModule, REST_MODULE_OPTIONS } from './client/rest.module'
export { AuthRestClient } from './auth/auth-rest.client'
export { AuthProcessor } from './auth/auth-processor'
export { AuthRestModule } from './auth/auth-rest.module'

// Resilience presets — enum carries runtime + type sides, so re-exported as a value
export * from './resilence.policy'
export * from './shouldRetry'

// Type-only exports — auth surface
export type { AuthStrategy } from './auth/auth.config'

// Type-only exports — hook surface
export type {
  HttpServiceLike,
  HttpVerb,
  InvokeArgs,
} from './client/base-http.service'
export type { HooksConfig } from './client/hookable-http.service'

// Type-only exports — resilience configuration surface
export type {
  ResilanceConfig,
  RetryConfig,
  CircuitBreakerConfig,
  BulkheadConfig,
  FallbackConfig,
  TimeoutConfig,
  DeduplicationConfig,
  RateLimiterConfig,
  ThrottlingConfig,
} from './client/resilance.config'

// Type-only exports — module options surface (for advanced consumers and test fixtures)
export type {
  RestModuleOptions,
  RestFromHttpServiceOptions,
} from './client/rest.module'
export type { AuthRestModuleOptions } from './auth/auth-rest.module'
