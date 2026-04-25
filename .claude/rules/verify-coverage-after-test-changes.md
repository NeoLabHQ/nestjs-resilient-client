---
title: Verify Coverage Thresholds After Test Changes
impact: HIGH
paths:
  - "**/*.spec.ts"
  - "**/*.e2e-spec.ts"
---

# Verify Coverage Thresholds After Test Changes

After removing, reducing, or modifying tests, run `npm run test:cov` to verify coverage thresholds still pass. This project uses `jest-it-up` for ratcheted thresholds in `test/jest.config.js`. If thresholds drop below the configured values, run `npm run posttest:cov` to update them or add tests to maintain coverage.

## Incorrect

Removing tests and only verifying unit tests pass without checking coverage.

```bash
# Removed 3 fail-open tests, added 1 replacement
npm run test:unit  # 1258 passed -- looks good!
# Never ran test:cov, coverage thresholds now broken
```

## Correct

Running the full coverage check after test modifications to catch threshold regressions.

```bash
# Removed 3 fail-open tests, added 1 replacement
npm run test:cov   # Checks coverage thresholds
# If thresholds fail, either:
# 1. Add tests to maintain coverage, or
# 2. Run: npm run posttest:cov  (jest-it-up updates thresholds)
```