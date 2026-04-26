import axios from 'axios'

/**
 * Smoke test: verifies the testcontainers harness in `e2e-setup.ts` is
 * wired correctly — the httpbin container is reachable from a test
 * worker via `process.env.TEST_HTTP_BASE_URL`. Acts as the gate for
 * Step 16's Definition of Done.
 */
describe('testcontainers smoke test', () => {
  it('exposes TEST_HTTP_BASE_URL and httpbin /get responds 200', async () => {
    const baseUrl = process.env.TEST_HTTP_BASE_URL

    expect(baseUrl).toBeDefined()
    expect(baseUrl).toMatch(/^http:\/\/.+:\d+$/)

    const response = await axios.get(`${baseUrl}/get`)

    expect(response.status).toBe(200)
    expect(response.data).toHaveProperty('url')
  })
})
