import { ApiError } from '@brattybot/web-sdk';

/**
 * What a page says about a failed read: the server's own sentence when the API refused,
 * `fallback` when the request never got an answer (a network failure is not an
 * `ApiError`), and null when nothing failed.
 */
export function loadErrorMessage(error: unknown, fallback: string): string | null {
    if (!error) return null;
    return error instanceof ApiError ? error.message : fallback;
}
