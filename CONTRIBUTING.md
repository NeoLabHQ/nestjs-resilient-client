# Contributing

Thanks for taking the time to contribute. This document covers the local development workflow, the test commands, and the prerequisites you need to run them.

## Prerequisites

- **Node.js** — version compatible with the engines in `package.json`.
- **npm** — bundled with Node.
- **Docker** — required for the end-to-end test suite. The e2e tests use [`testcontainers`](https://node.testcontainers.org/) to start an `httpbin`-style HTTP target on demand. Docker must be running and reachable by the current user (e.g. via the Docker daemon socket) before running `npm run test:e2e`. The unit and mutation suites do NOT require Docker.

## Quick Start

```bash
git clone https://github.com/NeoLabHQ/nestjs-log-decorator.git
cd nestjs-log-decorator
npm install
npm run dev
# Concurrently runs the build in watch mode and the unit tests
```

## Testing

The project ships four `npm` scripts; they all match `package.json` exactly and all set `TS_NODE_PROJECT=tsconfig.json` so `ts-jest` and `stryker` resolve types correctly.

### `npm run test:unit`

Runs the unit suite with Jest using `jest.config.ts` and produces a coverage report.

```bash
npm run test:unit
```

A `posttest:unit` hook runs [`jest-it-up`](https://github.com/dollarshaveclub/jest-it-up) to ratchet the coverage thresholds in `jest.config.ts` whenever a run exceeds the current floor.

```bash
# Runs automatically after `npm run test:unit`
```

No external services are required for this command.

### `npm run test:e2e`

Runs the end-to-end suite with Jest using `jest.e2e.config.ts`. The suite spins up containerised dependencies via `testcontainers` and exercises the public client surface against a real HTTP target.

```bash
npm run test:e2e
```

**Requires Docker** — the testcontainers global setup will fail if the Docker daemon is not running. On Linux, ensure your user is in the `docker` group; on macOS / Windows, ensure Docker Desktop is started.

### `npm run test:mutation`

Runs [Stryker](https://stryker-mutator.io/) to compute the mutation score against the unit suite. The mutation gate is enforced at 80% by `stryker.config.json`.

```bash
npm run test:mutation
```

No external services are required for this command, but it runs the full unit suite many times and is the slowest of the three.

### `npm run test`

Composite script that chains all three suites in order; fails fast on the first non-zero exit.

```bash
npm run test
# npm run test:unit && npm run test:e2e && npm run test:mutation
```

This is the same chain run by the `verify.yaml` GitHub Actions workflow on push and pull request.

## Building

```bash
npm run build
# Produces dist/ via tsdown
```

For a watch loop combining build + tests, use `npm run dev`.

## Type-checking

```bash
npm run typecheck
# tsc --noEmit
```

## Linting

```bash
npm run lint
# eslint src tests
```

The project lints `src/` and `tests/` with ESLint 10 in flat-config mode using `@typescript-eslint/parser` + the `@typescript-eslint/eslint-plugin` recommended rule set (see `eslint.config.js`).

`@typescript-eslint/no-explicit-any` is enabled in production code and intentionally disabled for test files. The handful of `eslint-disable-next-line @typescript-eslint/no-explicit-any` directives in `src/client/rest.client.ts` and `src/auth/auth-rest.client.ts` are present because the per-verb default type parameters (`<T = any, D = any>`) mirror the upstream `@nestjs/axios` `HttpService` signatures — restructuring to `unknown` would force every consumer calling a verb without an explicit type argument to narrow `response.data`, breaking API parity. Each disable directive is paired with a JSDoc-style justification comment explaining why restructuring is infeasible at that site, in line with `.claude/rules/fix-lint-not-suppress.md`.

## Commits and Releases

This project uses **semantic-release** for automated versioning and changelog generation. All commits MUST follow the [Conventional Commits](https://www.conventionalcommits.org/) format.

### Creating a commit

Instead of `git commit`, use:

```bash
git add .
npm run commit
```

Or, to stage everything and commit in one step:

```bash
npm run cz
```

This launches an interactive prompt (commitizen) that guides you through producing a properly formatted commit message.

### Commit format

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

**Types:**

- `feat` — new feature (triggers a minor version bump)
- `fix` — bug fix (triggers a patch version bump)
- `docs` — documentation changes
- `style` — code style changes (formatting, no code change)
- `refactor` — code refactoring
- `perf` — performance improvements
- `test` — adding or updating tests
- `chore` — maintenance tasks
- `ci` — CI/CD changes

**Breaking changes:** add `BREAKING CHANGE:` in the footer or `!` after the type (e.g. `feat!:`) to trigger a major version bump.
