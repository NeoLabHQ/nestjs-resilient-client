import type { StartedTestContainer } from 'testcontainers'

declare global {

  var __HTTP_CONTAINER__: StartedTestContainer | undefined
}

/**
 * Jest globalTeardown: stops the httpbin container started in
 * `e2e-setup.ts`. Uses optional chaining so a failed setup (where the
 * container handle was never assigned) does not mask the original error
 * with a teardown null-reference.
 */
export default async function teardown(): Promise<void> {
  await globalThis.__HTTP_CONTAINER__?.stop()
}
