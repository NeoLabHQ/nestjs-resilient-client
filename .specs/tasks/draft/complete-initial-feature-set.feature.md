---
title: Complete initial feature set
---

## Initial User Prompt

- complete initial feature set
- add unit tests, e2e tests
- add usage examples and documentation in README.md

### Context

This project is in initial draft state, it not working, but contain initial architecture. This task requires to complete initial feature set and make it working. Also, refactor draft implementations and cover it with tests.

### Requirements

- rename HttpClient to RestClient
- extract executeRequest from RestClient and make it a standalone decorator using Wrap from base-decorators library. Decorator should be named `@ExecuteWithPolicy` and should be used to decorate all erquest methods in RestClient. Decorator should read `this.policy` from RestClient instance and execute the request with it.
- rename AuthenticatedHttpService to AuthRestClient
- refactor AuthRestClient to use RestClient. It should not use any observable, firstValueFrom and p-retry. Remove withHttpRetry, isRetryableError.
- create AuthStrategyService that receive AuthConfig. It should implement and provide 3 public methods based on AuthConfig. `isAuthenticated()`. `authenticateIfNeeded()`, `extendRequest()`.
    - modify how AuthConfig setup. Instead of existing fields, it should have single field: `authenticate()`. `authenticate()` should receive instance of RestClient and return Promise with this fields: `extendRequest()`, `isAuthenticated()`.
        - `extendRequest()` should receive instance of AxiosRequestConfig and return new instance of AxiosRequestConfig with extended headers.
        - `isAuthenticated()` should return boolean if user is authenticated, and false otherwise.
    - AuthStrategyService should store result of `authenticate()` in private field and return it from `isAuthenticated()` and `extendRequest()`. authenticateIfNeeded should check isAuthenticated and if it is false, it should call `authenticate()` and store the result.
    - Use `@DedublicateInflight` decorator to wrap private `authenticate()` method inside of AuthStrategyService, that called inside of authenticateIfNeeded. It should ensure there no 2 parallel requests to authenticate are done.
- modify AuthRestClient to receiev AuthStrategyService as a constructor argument. Use it to authenticate requests. 
    - create `@Authenticate` decorator that should call `authenticateIfNeeded()` and then extend config param using `extendRequest()` from AuthStrategyService.
    - use OnErrorHook decorator from base-decorators library to handle authentication errors and authenticate again if it us auth error.
- create AuthRestModule that should export AuthRestClient and RestClient and use async factory to build AuthConfig and HttpService. It should accept ResilanceConfig as optional dependency.
- Correct jest unit tests setup for library and cover it with tests. Unit tests should be written for in `src/**/__tests__/*.spec.ts` files in the `src` directory for each module.
    - For unit tests avoid mocking libraries and imports. Use constructors to pass mocks. Refactor the code to make it easier to test, if needed.
    - Setup coverage handling for jest and add jest-it-up to bump tests coverage.
    - Setup stryker for mutation coverage testing, it should have `break: 80` threshold for coverage. Add unit tests until it pass.
    - Ensure that each policy type is covered with combination with http client. Mock only axios and test all combinations that include retries, circuit breakers, bulkheads and fallbacks.
- Setup jest e2e tests, they should be written in `tests/` folder in the root of the project. It should use testcontainers to setup some dummy service and make requests to it.
- Add command to run `test:unit` with coverage, `test:e2e`, `test:mutation` to the package.json scripts. And `test` command to run all of them, one by one.
- Update contributing guide with new commands and how to run them.
- Rename build.yaml to verify.yaml and correct if need.
- Update readme with quick start, usage examples and API reference.


## Description

// Will be filled in future stages by business analyst
