// Runtime client classes
export { RestClient } from './client/rest.client'
export { AuthRestClient } from './auth/auth-rest.client'
export { AuthStrategyService } from './auth/auth-strategy.service'
export { AuthRestModule } from './auth/auth-rest.module'

// Decorators
export { ExecuteWithPolicy } from './client/execute-with-policy.decorator'
export { Authenticate } from './auth/authenticate.decorator'
export { DeduplicateInflight } from './deduplicate-inflight.decorator'

// Resilience presets — enum carries runtime + type sides, so re-exported as a value
export { ResilencePresets, resiliencePolicyPresets } from './resilence.policy'

// Type-only exports — auth surface
export type { AuthConfig, AuthStrategy } from './auth/auth.config'

// Type-only exports — resilience configuration surface
export type {
  ResilanceConfig,
  RetryConfig,
  CircuitBreakerConfig,
  BulkheadConfig,
  FallbackConfig,
} from './client/resilance.config'
