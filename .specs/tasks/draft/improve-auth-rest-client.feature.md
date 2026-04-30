---
title: Improve AuthRestClient
---

## Initial User Prompt

refactor Auth module

### Context

AuthModule currently expect to receive inline AuthStratgy object as response from authenticate function in AuthConfig. This violates NestJS class based DI pattern. Rewrite it using AuthStrategy as a class pattern.

Important: library not yet released, breaking changes are allowed.

### Requirements

- Remove AuthConfig interface.
- Rename AuthStrategyService to AuthProcessor.
- Change AuthModule. It should now receive class that implements AuthStrategy interface. This class should be injected to AuthProcessor. Then AuthProcessor should be injected to AuthRestClient.
- AuthStrategy interface now should include additional method: `authenticate(client: RestClient): Promise<void>`.
- AuthProcessor should provide same functionality like now, but instead of holding authResult state, it should just call AuthStrategy methods directly.
- update readme with new API and usage + add example of static auth with RestClient:
```ts
@Module({
  imports: [
    RestModule.forRootAsync({
      useFactory: (config: ConfigService) => ({
        axios: {
          baseURL: 'https://api.example.com',
          headers: {
            'Authorization': `Bearer ${config.get('API_TOKEN')}`,
          },
        },
      }),
    }),
  ],
  exports: [RestClient],
})
```
Add test that this example actually works. 

Then add note in `Authenticated client` section, that for static API tokens, you can use `RestClient` directly, but if you need some dynamic authentication, the `AuthRestModule` simplify creation of it.

#### Additional changes

- Add jsdocs usage examples for each class and method in the repository.

#### Testing

- Add unit tests for new or update functionality.
- Add e2e tests for new or update functionality.
- Iterate till all tests pass.

## Description

// Will be filled in future stages by business analyst
