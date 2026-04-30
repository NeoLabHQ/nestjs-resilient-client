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
- AuthProcessor should provide same functionality like now, but instead of holding authResult state, it should just call AuthStrategy methods directly.
- update readme

### Additional changes

- Add jsdocs usage examples for each class and method in the repository.

## Description

// Will be filled in future stages by business analyst
