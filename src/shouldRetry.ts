import { isAxiosError, type AxiosError } from "axios";

export const SAFE_HTTP_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Retry policy for network errors and 5xx server errors.
 *
 * This is a simplified retry condition suitable for non-idempotent requests (POST, PATCH).
 * It retries on:
 * - Network errors (ENOTFOUND, ECONNABORTED, ECONNRESET, etc.) - uses isNetworkOrInternalError
 * - Server errors (5xx) - temporary server issues
 *
 * It does NOT retry on:
 * - Client errors (4xx) - bad request, authentication, validation errors
 *
 */
export function isRetryableError(error: Error, methods: string[] = SAFE_HTTP_METHODS): boolean {
    // Not an axios error - retry (types/parsing error)
    if (!isAxiosError(error)) {
        return true;
    }

    // Retry only for idempotent methods
    if (!isMethodInList(error, methods)) {
        return false;
    }

    // Network/timeout errors (no response)
    return isNetworkOrInternalError(error);
}

export function isMethodInList(error: AxiosError, list: string[]): boolean {
    const method = error.config?.method;
    if (!method) {
        // Cannot determine if the request can be retried
        return false;
    }

    return list.includes(method.toUpperCase());
}

export function isNetworkOrInternalError(error: AxiosError): boolean {
    return isNetworkError(error) || isInternalError(error);
}

// Based on https://github.com/sindresorhus/is-retry-allowed/blob/main/index.js
const CODE_EXCLUDE_LIST = [
    'ERR_CANCELED', 
    'ECONNABORTED',
    'ENOTFOUND',
	'ENETUNREACH',

	// SSL errors from https://github.com/nodejs/node/blob/fc8e3e2cdc521978351de257030db0076d79e0ab/src/crypto/crypto_common.cc#L301-L328
	'UNABLE_TO_GET_ISSUER_CERT',
	'UNABLE_TO_GET_CRL',
	'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
	'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
	'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
	'CERT_SIGNATURE_FAILURE',
	'CRL_SIGNATURE_FAILURE',
	'CERT_NOT_YET_VALID',
	'CERT_HAS_EXPIRED',
	'CRL_NOT_YET_VALID',
	'CRL_HAS_EXPIRED',
	'ERROR_IN_CERT_NOT_BEFORE_FIELD',
	'ERROR_IN_CERT_NOT_AFTER_FIELD',
	'ERROR_IN_CRL_LAST_UPDATE_FIELD',
	'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
	'OUT_OF_MEM',
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'SELF_SIGNED_CERT_IN_CHAIN',
	'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
	'CERT_CHAIN_TOO_LONG',
	'CERT_REVOKED',
	'INVALID_CA',
	'PATH_LENGTH_EXCEEDED',
	'INVALID_PURPOSE',
	'CERT_UNTRUSTED',
	'CERT_REJECTED',
	'HOSTNAME_MISMATCH'
];

export function isNetworkError(error: AxiosError) {
    if (error.response) {
        return false;
    }
    if (!error.code) {
        return false;
    }
    // Prevents retrying unsafe errors
    if (CODE_EXCLUDE_LIST.includes(error.code)) {
        return false;
    }
    
    return true;
}


export function isInternalError(error: AxiosError): boolean {
    return (
        error.code !== 'ECONNABORTED' &&
        (!error.response ||
            error.response.status !== undefined ||
            error.response.status === 429 ||
            (error.response.status >= 500 && error.response.status <= 599))
    );
}

