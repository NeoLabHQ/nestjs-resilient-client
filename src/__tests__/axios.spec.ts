import type { AxiosError } from 'axios'

import { getRequestRoute } from '../axios'

/**
 * Build a synthetic AxiosError-like object that satisfies `isAxiosError`.
 *
 * Mirrors the fixture shape used by `should-retry.spec.ts` so the suite is
 * consistent across the package. `isAxiosError` only checks the truthy
 * `isAxiosError` flag, so any plain `Error` augmented with that flag and a
 * `config` member is recognised by `axios.isAxiosError`.
 */
function makeAxiosError(config: AxiosError['config']): Error {
  const error = new Error('test') as Error & {
    isAxiosError: boolean
    config?: AxiosError['config']
  }
  error.isAxiosError = true
  error.config = config
  return error
}

describe('getRequestRoute', () => {
  describe('non-axios / missing config short-circuit', () => {
    it('returns the literal string "unknown" for a plain Error', () => {
      // Non-axios errors have no `isAxiosError` flag set, so the function
      // short-circuits and returns the sentinel string. The exact spelling
      // matters for log scraping; keep it pinned to "unknown" not "Unknown".
      expect(getRequestRoute(new Error('boom'))).toBe('unknown')
    })

    it('returns "unknown" for null, undefined, primitives', () => {
      expect(getRequestRoute(null)).toBe('unknown')
      expect(getRequestRoute(undefined)).toBe('unknown')
      expect(getRequestRoute(42)).toBe('unknown')
      expect(getRequestRoute('string-error')).toBe('unknown')
    })

    it('returns "unknown" for an axios error without config', () => {
      // The function checks for both `isAxiosError(error)` AND `error.config`.
      // A truthy `isAxiosError` flag with an undefined `config` must still
      // route to the unknown branch.
      const error = new Error('no-config') as Error & { isAxiosError: boolean }
      error.isAxiosError = true
      expect(getRequestRoute(error as unknown as Error)).toBe('unknown')
    })
  })

  describe('method + url formatting', () => {
    it('returns "METHOD URL" with method uppercased and no querystring', () => {
      const error = makeAxiosError({
        method: 'get',
        url: 'https://api.example.com/users',
      } as AxiosError['config'])

      // Method always uppercased; `?` is omitted when no params are present.
      expect(getRequestRoute(error)).toBe('GET https://api.example.com/users')
    })

    it('uppercases lowercase methods', () => {
      const error = makeAxiosError({
        method: 'post',
        url: '/items',
      } as AxiosError['config'])

      expect(getRequestRoute(error)).toBe('POST /items')
    })

    it('preserves already-uppercase methods', () => {
      const error = makeAxiosError({
        method: 'PUT',
        url: '/items/1',
      } as AxiosError['config'])

      expect(getRequestRoute(error)).toBe('PUT /items/1')
    })

    it('returns "undefined URL" when method is absent', () => {
      // When `config.method` is missing, `method?.toUpperCase()` resolves to
      // undefined and is interpolated as the literal string "undefined".
      // This is intentional behaviour — log scrapers filter on it.
      const error = makeAxiosError({ url: '/no-method' } as AxiosError['config'])

      expect(getRequestRoute(error)).toBe('undefined /no-method')
    })

    it('returns "METHOD undefined" when url is absent', () => {
      const error = makeAxiosError({ method: 'get' } as AxiosError['config'])

      expect(getRequestRoute(error)).toBe('GET undefined')
    })
  })

  describe('querystring formatting from config.params', () => {
    it('serialises params into a leading-? querystring', () => {
      const error = makeAxiosError({
        method: 'get',
        url: '/search',
        params: { q: 'cats', limit: '10' },
      } as AxiosError['config'])

      // URLSearchParams renders key/value pairs joined by `&`; the result
      // must start with `?` and pass values through untouched.
      const route = getRequestRoute(error)
      expect(route.startsWith('GET /search?')).toBe(true)
      expect(route).toContain('q=cats')
      expect(route).toContain('limit=10')
    })

    it('omits the querystring entirely when params is absent', () => {
      const error = makeAxiosError({
        method: 'get',
        url: '/no-params',
      } as AxiosError['config'])

      // No params -> no leading `?`; the returned route ends at the URL.
      expect(getRequestRoute(error)).toBe('GET /no-params')
    })

    it('renders a bare `?` when params is an empty object', () => {
      const error = makeAxiosError({
        method: 'get',
        url: '/empty-params',
        params: {},
      } as AxiosError['config'])

      // Empty params object is still truthy, so the function appends `?` with
      // no body. This pins the documented behaviour against a future
      // refactor that might `Object.keys(params).length === 0`-skip it.
      expect(getRequestRoute(error)).toBe('GET /empty-params?')
    })

    it('URL-encodes special characters via URLSearchParams', () => {
      const error = makeAxiosError({
        method: 'get',
        url: '/search',
        params: { q: 'foo bar', code: 'a=b&c' },
      } as AxiosError['config'])

      const route = getRequestRoute(error)
      // URLSearchParams encodes spaces as `+` and `&`/`=` as `%26`/`%3D`.
      expect(route).toContain('q=foo+bar')
      expect(route).toContain('code=a%3Db%26c')
    })
  })
})
