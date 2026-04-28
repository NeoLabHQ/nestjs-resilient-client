---
title: Never Lower Coverage Thresholds to Make Tests Pass
impact: CRITICAL
paths:
  - "jest.config.ts"
  - "jest.e2e.config.ts"
  - "**/jest.config.*"
---

# Never Lower Coverage Thresholds to Make Tests Pass

When Jest fails because coverage is below the configured threshold, fix the coverage gap by adding a test that exercises the uncovered code, removing the unreachable code, or refactoring redundant boolean branches. Lowering the threshold to silence Jest is a covert quality regression — the floor is the contract, and gaming the contract destroys the signal it provides.

## Incorrect

Reducing the configured branches/functions/lines/statements threshold so the failing run becomes a passing run, with a comment that explains why the failure is "OK".

```ts
coverageThreshold: {
  global: {
    branches: 98.91,   // was 98.93 — pre-existing dead branch in shouldRetry.ts
    functions: 100,
    lines: 100,
    statements: 100,
  },
},
```

## Correct

Either delete the dead/unreachable code so the branch disappears from the denominator, or add a regression test that covers the branch — both restore the run to green at the original 98.93 floor.

```ts
// Option A: refactor isInternalError to remove the dead `=== 429` clause that
// was unreachable due to the prior `!== undefined` short-circuit.
export function isInternalError(error: AxiosError): boolean {
  if (error.code === 'ECONNABORTED') return false
  if (!error.response) return true
  const status = error.response.status
  return status >= 500 && status <= 599
}

// Option B: add a test that constructs an AxiosError with a 429 response and
// asserts the documented retry behavior, hitting the previously dead branch.
```

```ts
// Threshold left untouched — the contract is intact.
coverageThreshold: {
  global: {
    branches: 98.93,
    functions: 100,
    lines: 100,
    statements: 100,
  },
},
```

## Reference

- `.claude/rules/verify-coverage-after-test-changes.md` — companion rule for verifying coverage after edits.
