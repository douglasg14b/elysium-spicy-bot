/**
 * Thin fetch wrapper for the BrattyBot JSON API. Same-origin — cookies (the session)
 * are sent automatically. Throws {@link ApiError} on non-2xx so callers can surface it.
 *
 * Being replaced by the SDK generated in `packages/web-sdk`. Its one caller left is
 * `journeys.ts`, for the journey routes that are not in the spec yet, plus the journey
 * dialogs that import `ApiError` from here; it goes with them. Until then both clients throw the same `ApiError`, read from the error body by the
 * same function — it lives in the SDK and is re-exported here — so every
 * `instanceof ApiError` holds whichever client a page uses.
 *
 * Unlike the SDK, a 401 here does not sign the dashboard out: only `setupClient`'s
 * `onUnauthorized` does that, and these calls do not pass through it.
 */

import { ApiError, apiErrorFromBody } from '@brattybot/web-sdk';

export { ApiError };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
        ...init,
    });

    if (!res.ok) {
        // A body that is not JSON keeps the generic "Request failed (status)" message.
        const body: unknown = await res.json().catch(() => undefined);
        throw apiErrorFromBody(res.status, body);
    }

    // 204 / empty bodies.
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
}

export const api = {
    get: <T>(path: string) => request<T>(path),
    post: <T>(path: string, body?: unknown) =>
        request<T>(
            path,
            body === undefined
                ? { method: 'POST' }
                : {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(body),
                  }
        ),
    put: <T>(path: string, body: unknown) =>
        request<T>(path, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
