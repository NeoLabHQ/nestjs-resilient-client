import {
  isRetryableError,
  isMethodInList,
  isNetworkError,
  isInternalError,
  SAFE_HTTP_METHODS,
} from '../shouldRetry'
import type { AxiosError } from 'axios'

/**
 * Build a synthetic axios error fixture without invoking jest.mock.
 *
 * - When `status` is provided, the fixture mimics an HTTP response error
 *   (sets `error.response`).
 * - When `status` is omitted, the fixture mimics a network error (sets
 *   `error.request` only — no response).
 * - `code` is optional and used to exercise the CODE_EXCLUDE_LIST branches.
 */
function makeAxiosError(method: string, status?: number, code?: string): AxiosError {
  const error = new Error('test') as Error & {
    isAxiosError: boolean
    response?: { status: number }
    request?: object
    config?: { method: string }
    code?: string
  }

  error.isAxiosError = true
  error.config = { method }

  if (status !== undefined) {
    error.response = { status }
  }
  else {
    error.request = {}
  }

  if (code) {
    error.code = code
  }

  return error as unknown as AxiosError
}

describe('shouldRetry', () => {
  describe('isRetryableError', () => {
    describe('non-axios errors', () => {
      it('returns true for plain Error (treated as internal/parsing error)', () => {
        const error = new Error('some non-axios failure')

        expect(isRetryableError(error)).toBe(true)
      })

      it('returns true for TypeError', () => {
        const error = new TypeError('parse failure')

        expect(isRetryableError(error)).toBe(true)
      })
    })

    describe('safe HTTP method allow-list (default SAFE_HTTP_METHODS)', () => {
      it('returns true for GET with 5xx server error', () => {
        const error = makeAxiosError('GET', 500)

        expect(isRetryableError(error)).toBe(true)
      })

      it('returns true for HEAD with 5xx server error', () => {
        const error = makeAxiosError('HEAD', 503)

        expect(isRetryableError(error)).toBe(true)
      })

      it('returns true for OPTIONS with 5xx server error', () => {
        const error = makeAxiosError('OPTIONS', 502)

        expect(isRetryableError(error)).toBe(true)
      })

      it('returns false for POST with 5xx server error (not in allow-list)', () => {
        const error = makeAxiosError('POST', 500)

        expect(isRetryableError(error)).toBe(false)
      })

      it('returns false for PUT with 5xx server error (not in default allow-list)', () => {
        const error = makeAxiosError('PUT', 503)

        expect(isRetryableError(error)).toBe(false)
      })

      it('returns false for DELETE with 5xx server error (not in default allow-list)', () => {
        const error = makeAxiosError('DELETE', 500)

        expect(isRetryableError(error)).toBe(false)
      })

      it('returns false for PATCH with 5xx server error (not in default allow-list)', () => {
        const error = makeAxiosError('PATCH', 500)

        expect(isRetryableError(error)).toBe(false)
      })
    })

    describe('extended methods list (RESTFULL preset semantics)', () => {
      const restfullMethods = [...SAFE_HTTP_METHODS, 'PUT', 'DELETE']

      it('returns true for PUT with 5xx when PUT is allow-listed', () => {
        const error = makeAxiosError('PUT', 500)

        expect(isRetryableError(error, restfullMethods)).toBe(true)
      })

      it('returns true for DELETE with 5xx when DELETE is allow-listed', () => {
        const error = makeAxiosError('DELETE', 500)

        expect(isRetryableError(error, restfullMethods)).toBe(true)
      })

      it('still returns false for POST when not in extended allow-list', () => {
        const error = makeAxiosError('POST', 500)

        expect(isRetryableError(error, restfullMethods)).toBe(false)
      })
    })

    describe('CODE_EXCLUDE_LIST (cancellations and SSL/cert failures)', () => {
      // ECONNABORTED is the only excluded code that ALSO short-circuits
      // `isInternalError` — so it is the only one for which `isRetryableError`
      // currently returns `false`. Other CODE_EXCLUDE_LIST entries are filtered
      // by `isNetworkError` but still pass `isInternalError` (since they have
      // no response and a code !== 'ECONNABORTED'), which is the documented
      // current behaviour exercised by the integration with cockatiel.
      it('returns false when code is ECONNABORTED on a network error', () => {
        const error = makeAxiosError('GET', undefined, 'ECONNABORTED')

        expect(isRetryableError(error)).toBe(false)
      })

      it('isNetworkError returns false for ERR_CANCELED (CODE_EXCLUDE_LIST)', () => {
        const error = makeAxiosError('GET', undefined, 'ERR_CANCELED')

        expect(isNetworkError(error)).toBe(false)
      })

      it('isNetworkError returns false for ENOTFOUND (CODE_EXCLUDE_LIST)', () => {
        const error = makeAxiosError('GET', undefined, 'ENOTFOUND')

        expect(isNetworkError(error)).toBe(false)
      })

      it('isNetworkError returns false for CERT_HAS_EXPIRED (SSL failure in CODE_EXCLUDE_LIST)', () => {
        const error = makeAxiosError('GET', undefined, 'CERT_HAS_EXPIRED')

        expect(isNetworkError(error)).toBe(false)
      })

      it.each([
        'ENETUNREACH',
        'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
        'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
        'CERT_SIGNATURE_FAILURE',
        'CRL_SIGNATURE_FAILURE',
        'CRL_NOT_YET_VALID',
        'CRL_HAS_EXPIRED',
        'ERROR_IN_CERT_NOT_BEFORE_FIELD',
        'OUT_OF_MEM',
        'CERT_CHAIN_TOO_LONG',
        'PATH_LENGTH_EXCEEDED',
        'CERT_REJECTED',
      ])('isNetworkError returns false for %s (CODE_EXCLUDE_LIST)', (code) => {
        const error = makeAxiosError('GET', undefined, code)

        expect(isNetworkError(error)).toBe(false)
      })
    })

    describe('network errors (no response, retryable code)', () => {
      it('returns true for GET network error with ECONNRESET', () => {
        const error = makeAxiosError('GET', undefined, 'ECONNRESET')

        expect(isRetryableError(error)).toBe(true)
      })

      it('returns true for GET network error with ETIMEDOUT', () => {
        const error = makeAxiosError('GET', undefined, 'ETIMEDOUT')

        expect(isRetryableError(error)).toBe(true)
      })

      it('returns false for POST network error with ECONNRESET (method not allow-listed)', () => {
        const error = makeAxiosError('POST', undefined, 'ECONNRESET')

        expect(isRetryableError(error)).toBe(false)
      })
    })

    describe('missing config / method', () => {
      it('returns false when axios error has no config.method (cannot determine)', () => {
        const error = new Error('weird') as Error & {
          isAxiosError: boolean
          response?: { status: number }
          config?: { method?: string }
        }
        error.isAxiosError = true
        error.response = { status: 500 }
        error.config = {}

        expect(isRetryableError(error as unknown as AxiosError)).toBe(false)
      })
    })
  })

  describe('isMethodInList', () => {
    it('returns true when error.config.method is in the list (uppercased)', () => {
      const error = makeAxiosError('get', 500)

      expect(isMethodInList(error, ['GET', 'HEAD'])).toBe(true)
    })

    it('returns false when error.config.method is not in the list', () => {
      const error = makeAxiosError('POST', 500)

      expect(isMethodInList(error, ['GET', 'HEAD'])).toBe(false)
    })

    it('returns false when error.config.method is missing', () => {
      const error = new Error('no-method') as Error & {
        isAxiosError: boolean
        config?: { method?: string }
      }
      error.isAxiosError = true
      error.config = {}

      expect(isMethodInList(error as unknown as AxiosError, ['GET'])).toBe(false)
    })

    it('returns false when error.config itself is missing (covers the `??` fallback branch)', () => {
      // No `config` at all — covers the optional-chaining short-circuit on
      // line 33 of shouldRetry.ts (`!error.config?.method`).
      const error = new Error('no-config') as Error & {
        isAxiosError: boolean
        config?: undefined
      }
      error.isAxiosError = true

      expect(isMethodInList(error as unknown as AxiosError, ['GET'])).toBe(false)
    })

    it('handles lowercased method names by uppercasing before lookup', () => {
      // Ensures the `.toUpperCase()` step on line 38 is exercised end-to-end.
      const error = new Error('lower') as Error & {
        isAxiosError: boolean
        config?: { method?: string }
      }
      error.isAxiosError = true
      error.config = { method: 'get' }

      expect(isMethodInList(error as unknown as AxiosError, ['GET'])).toBe(true)
    })
  })

  describe('isNetworkError', () => {
    it('returns false when there is a response (HTTP-level error, not network)', () => {
      const error = makeAxiosError('GET', 500)

      expect(isNetworkError(error)).toBe(false)
    })

    it('returns false when there is no code (cannot classify)', () => {
      const error = makeAxiosError('GET')

      expect(isNetworkError(error)).toBe(false)
    })

    it('returns false when code is in CODE_EXCLUDE_LIST', () => {
      const error = makeAxiosError('GET', undefined, 'ECONNABORTED')

      expect(isNetworkError(error)).toBe(false)
    })

    it('returns true when code is set and not excluded', () => {
      const error = makeAxiosError('GET', undefined, 'ECONNRESET')

      expect(isNetworkError(error)).toBe(true)
    })
  })

  describe('isInternalError', () => {
    it('returns true for 5xx response status', () => {
      const error = makeAxiosError('GET', 500)

      expect(isInternalError(error)).toBe(true)
    })

    it('returns false for 4xx response status (client errors are not internal/transient)', () => {
      // 4xx errors signal a client-side problem (bad request, auth, validation)
      // that retries cannot fix. The README explicitly excludes 4xx from the
      // retry surface, and `isInternalError` mirrors that contract.
      const error = makeAxiosError('GET', 400)

      expect(isInternalError(error)).toBe(false)
    })

    it('returns true for 429 response status', () => {
      const error = makeAxiosError('GET', 429)

      expect(isInternalError(error)).toBe(true)
    })

    it('returns false for ECONNABORTED code', () => {
      const error = makeAxiosError('GET', undefined, 'ECONNABORTED')

      expect(isInternalError(error)).toBe(false)
    })

    it('returns true when error has no response (covers `!error.response` branch)', () => {
      // No response and no ECONNABORTED code — internal-error short-circuits via
      // the leftmost OR alternative (`!error.response`).
      const error = makeAxiosError('GET', undefined, 'ECONNRESET')

      expect(isInternalError(error)).toBe(true)
    })

    it('returns true when status is exactly 500 (lower 5xx boundary)', () => {
      const error = makeAxiosError('GET', 500)

      expect(isInternalError(error)).toBe(true)
    })

    it('returns true when status is exactly 599 (upper 5xx boundary)', () => {
      const error = makeAxiosError('GET', 599)

      expect(isInternalError(error)).toBe(true)
    })

    it('returns false when error.response exists but status is undefined and code is not ECONNABORTED', () => {
      // Exercises the `error.response.status !== undefined` short-circuit when
      // status is `undefined`. The OR chain falls through every clause:
      // `!error.response` is false (response present), `status !== undefined`
      // is false, `=== 429` is false, and the 5xx range comparison with
      // undefined is false — so the whole expression yields `false`.
      const error = new Error('no-status') as Error & {
        isAxiosError: boolean
        response?: { status?: number }
        config?: { method: string }
      }
      error.isAxiosError = true
      error.config = { method: 'GET' }
      error.response = {}

      expect(isInternalError(error as unknown as AxiosError)).toBe(false)
    })

    it('returns true for status === 429 (Too Many Requests)', () => {
      const error = makeAxiosError('GET', 429)

      expect(isInternalError(error)).toBe(true)
    })
  })

  describe('SAFE_HTTP_METHODS constant', () => {
    it('contains GET, HEAD, OPTIONS only', () => {
      expect(SAFE_HTTP_METHODS).toEqual(['GET', 'HEAD', 'OPTIONS'])
    })
  })
})
