import { isAxiosError } from "axios";

export function getRequestRoute(error: unknown): string {
    if (!isAxiosError(error) || !error.config) {
        return 'unknown';
    }
    
    const { config } = error;
    const method = config.method?.toUpperCase();
    const url = config.url;
    const queryString = config.params ? '?' + new URLSearchParams(config.params as Record<string, string>).toString() : '';
    return `${method} ${url}${queryString}`;
}