import { GenericContainer, Wait } from 'testcontainers'
import type { StartedTestContainer } from 'testcontainers'

/**
 * Globally accessible (within the Jest CLI process) handle to the started
 * httpbin container. Persisted on `globalThis` so that `e2e-teardown.ts`
 * can stop the same instance that `e2e-setup.ts` started.
 *
 * Note: Jest test workers run in separate processes and DO NOT see this
 * symbol — they receive the container coordinates through environment
 * variables (TEST_HTTP_BASE_URL) instead.
 */
declare global {

  var __HTTP_CONTAINER__: StartedTestContainer | undefined
}

/**
 * Jest globalSetup: starts a single httpbin container shared by all e2e
 * specs and exposes its base URL via `process.env.TEST_HTTP_BASE_URL`.
 *
 * Why httpbin: provides deterministic endpoints (`/get`, `/status/<code>`,
 * `/anything`) needed by the resilience and authentication e2e suites
 * without standing up a custom service.
 */
export default async function setup(): Promise<void> {
  const container = await new GenericContainer('kennethreitz/httpbin')
    .withExposedPorts(80)
    .withWaitStrategy(Wait.forHttp('/get', 80).forStatusCode(200))
    .start()

  globalThis.__HTTP_CONTAINER__ = container

  const host = container.getHost()
  const port = container.getMappedPort(80)
  process.env.TEST_HTTP_BASE_URL = `http://${host}:${port}`
}
