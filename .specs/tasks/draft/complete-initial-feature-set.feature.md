---
title: Complete initial feature set
---

## Initial User Prompt

complete initial feature set

add unit tests, e2e tests



### Requirements

- Setup jest unit tests for the service. Unit tests should be written for in `src/**/__tests__/*.spec.ts` files in the `src` directory for each module.
    - For unit tests avoid mocking libraries and imports. Use constructors to pass mocks. Refactor the code to make it easier to test, if needed.
    - Setup coverage handling for jest and add jest-it-up to bump tests coverage.
    - Setup stryker for mutation coverage testing, it should have `break: 80` threshold for coverage. Add unit tests until it pass.
- Setup jest e2e tests, they should be written in `tests/` folder in the root of the project. It should test as much logic end modules together as possible.
- Setup smoke tests in `smoke-tests/smoke-test.ts` file. It should check the health checks and accept `SERVICE_URL` as an environment variable agains which to run the tests. It should be possible to run like this `npx tsx smoke-tests/smoke-test.ts`.
- Setup `smoke-tests/run-smoke-tests-local.sh` it should start the service locally and run the smoke tests against it.
- Add command to run `test:unit`, `test:e2e` and `test:smoke-local` to the package.json scripts. And `test` command to run all of them, one by one.
- Update readme with new commands and how to run them.
- Add test command to be run in verify.yaml workflow.
- Extract verify.yaml to reusable workflow verify-reusable.yaml and reference it in verify.yaml. Also add job run verify workflow to deploy-dev.yaml workflow. That should pass before deploy to dev environment.

## Description

// Will be filled in future stages by business analyst
