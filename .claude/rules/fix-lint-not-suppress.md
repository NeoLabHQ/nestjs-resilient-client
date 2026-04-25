---
title: Fix Lint Errors Through Code Restructuring Not Suppression
impact: HIGH
---

# Fix Lint Errors Through Code Restructuring Not Suppression

When tasked with fixing ESLint errors, restructure code to satisfy the rule. Add `eslint-disable` only after demonstrating that restructuring is infeasible and documenting why in the comment. Suppressing lint rules accumulates technical debt and defeats the purpose of fixing errors.

## Incorrect

Suppressing the lint error with a disable comment as the first approach.

```typescript
// eslint-disable-next-line ts/class-methods-use-this -- kept as method for cohesion
private extractData(input: Record<string, unknown>): ParsedResult {
  return parseInput(input)
}
```

## Correct

Restructuring the code to satisfy the rule (e.g., converting to a standalone function when `this` is not used).

```typescript
function extractData(input: Record<string, unknown>): ParsedResult {
  return parseInput(input)
}
```