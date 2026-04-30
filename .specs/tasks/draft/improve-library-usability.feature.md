---
title: Improve library usability
---

## Initial User Prompt

improve library usability

### Context

This library not yet released, breaking changes are allowed.

### Requirements

- Change how timeout is handled during RestModule and AuthRestModule creation. If axios timeout is provided, the resilence config timeout should be removed before supliyng it to the RestClient constructor. Add example of timeout usage in README.md.
- Extend resilence config with following functionality:
    - dedublication - Deduplicate requests to the same endpoint
    - Rate Limiter - Token bucket and leaky bucket implementations
    - Time Limiter - Timeout handling with cancellation support
    - Throttling - Limit the number of requests to a service
    CRITICAL: use rxjs operators to implement these features, rather writing custom logic or using lodash. The nesjs HttpService already based on rxjs and returns Observable. So reuse it directly and compose with it, instead of creating new wrappers. 
- Extend HookableHttpService with support of `hooks: HooksConfig` parameter in constructor. HooksConfig should support following hooks:
    - onInvoke - pre-call hook: transform the verb's invocation args before callUnderlying.
    - onReturn - post-call hook: observe or substitute the response after callUnderlying.
    - onError - error hook: receive the error if callUnderlying throws an error.
    Add to RestClient and AuthRestClient passing of this `hooks` parameter to the super constructor.
    Extend RestModuleOptions with `hooks: HooksConfig` parameter.
- Make AuthRestModuleOptions extend RestModuleOptions. It must support all params from it, including axios, hooks and resilence config.
- Update readme with new features and examples.
- Rename existing `Quick start` section in readme to `Usage`. Add such quick start example to readme before `Resilience Patterns` section, but improve it:

#### Quick Start

Installl library

```sh
npm i nestjs-http-client
```

Add module 
```ts
import { RestModule, ResilencePresets } from 'nestjs-http-client'

@Module({
  imports: [
    RestModule,
  ],
  exports: [RestModule],
})
export class CatalogModule {}

```

Use client in service
```ts
import { RestClient } from 'nestjs-http-client'

@Injectable()
export class CatalogService {
  constructor(private readonly client: RestClient) {}

  // Resolves to https://api.example.com/products/42
  async getProduct(id: string) {
    const response = await this.client.get<Product>(`https://api.example.com/products/${id}`) // exposes regular axios interface
    return response.data
  }
}
```

Make sure such zero-configuration example actually works and ensure e2e test for it exist.

#### Testing

- Add unit tests for new or update functionality.
- Add e2e tests for new or update functionality.
- Iterate till all tests pass.

## Description

// Will be filled in future stages by business analyst
