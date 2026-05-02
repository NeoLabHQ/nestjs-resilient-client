import { Test, type TestingModule } from '@nestjs/testing'

// Imports point at the concrete `RestClient` / `RestModule` modules rather
// than the package barrel (`../src/index`) so this spec stays orthogonal
// to the in-progress auth refactor: a transient breakage in
// `src/auth/*` re-exports cannot fail this test, and the import surface
// remains strictly limited to `RestModule`/`RestClient` per Step 11.
import { RestClient } from '../src/client/rest.client'
import { RestModule } from '../src/client/rest.module'

/**
 * End-to-end coverage for the README's "static API token via `RestModule`"
 * example. Verifies that wiring `RestModule.forRootAsync` with an axios
 * `headers.Authorization` default produces a {@link RestClient} that forwards
 * the configured Authorization header on every outbound request.
 *
 * This spec is intentionally orthogonal to the auth refactor: it only touches
 * `RestModule` / {@link RestClient}, never the auth surface
 * (`AuthRestModule`, `AuthRestClient`, `AuthProcessor`, `AuthStrategy`).
 *
 * Container coordinates flow in via `process.env.TEST_HTTP_BASE_URL` —
 * tests never hard-code hosts or ports.
 */

/** Static token value injected via axios default headers. */
const STATIC_TOKEN = 'Bearer static-token-X'

describe('Static-token RestModule (e2e)', () => {
  /**
   * Resolves the shared httpbin container's base URL or throws a clear
   * diagnostic if the testcontainers harness in `tests/e2e-setup.ts`
   * misfired. Centralised so the bootstrap helper produces a uniform
   * error when the env var is absent.
   */
  function requireBaseUrl(): string {
    const baseURL = process.env.TEST_HTTP_BASE_URL
    if (!baseURL) {
      throw new Error('TEST_HTTP_BASE_URL must be set by tests/e2e-setup.ts')
    }
    return baseURL
  }

  /**
   * Builds a fresh NestJS testing module wired exactly as the README's
   * static-token example: `RestModule.forRootAsync` whose factory returns
   * `axios: { baseURL, headers: { Authorization: STATIC_TOKEN } }`. Each
   * test compiles its own module so axios default-header state is isolated.
   */
  async function buildModule(): Promise<TestingModule> {
    const baseURL = requireBaseUrl()
    return Test.createTestingModule({
      imports: [
        RestModule.registerAsync({
          useFactory: () => ({
            axios: {
              baseURL,
              headers: { Authorization: STATIC_TOKEN },
            },
          }),
        }),
      ],
    }).compile()
  }

  describe('GET /anything with axios.headers.Authorization', () => {
    it('forwards the configured static Authorization header on every request', async () => {
      const moduleRef = await buildModule()
      try {
        const client = moduleRef.get(RestClient)

        // httpbin's `/anything` echoes request headers under `.headers` —
        // a strong signal that the static token was actually transmitted
        // over the wire (not just present on the in-process axios config).
        const response = await client.get<{ headers: Record<string, string> }>('/anything')

        expect(response.status).toBe(200)
        // httpbin canonicalises header casing (typically `Authorization`),
        // but a future container release could alter that, so look the
        // header up case-insensitively before comparing the value.
        const echoedHeaders = response.data.headers
        const authKey = Object.keys(echoedHeaders).find(
          key => key.toLowerCase() === 'authorization',
        )
        expect(authKey).toBeDefined()
        // Narrow `authKey` for strict TS — we just asserted it is defined.
        if (authKey === undefined) {
          throw new Error('expected httpbin to echo the Authorization header')
        }
        expect(echoedHeaders[authKey]).toBe(STATIC_TOKEN)
      }
      finally {
        // Tear the testing module down so HttpModule's axios instance and
        // any RestClient-internal cockatiel state are released between
        // tests. Prevents cross-test bleed if more cases are added later.
        await moduleRef.close()
      }
    })
  })
})
