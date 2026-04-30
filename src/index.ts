// Runtime client classes
export { HookableHttpService } from './client/hookable-http.service'
export { RestClient } from './client/rest.client'
export { RestModule } from './client/rest.module'
export { AuthRestClient } from './auth/auth-rest.client'
export { AuthStrategyService } from './auth/auth-strategy.service'
export { AuthRestModule } from './auth/auth-rest.module'

// Resilience presets — enum carries runtime + type sides, so re-exported as a value
export { ResilencePresets, resiliencePolicyPresets } from './resilence.policy'

// Type-only exports — auth surface
export type { AuthConfig, AuthStrategy } from './auth/auth.config'

// Type-only exports — hook surface
export type {
  HttpServiceLike,
  HttpVerb,
  InvokeArgs,
} from './client/hookable-http.service'

// Type-only exports — resilience configuration surface
export type {
  ResilanceConfig,
  RetryConfig,
  CircuitBreakerConfig,
  BulkheadConfig,
  FallbackConfig,
  TimeoutConfig,
} from './client/resilance.config'
