/**
 * Thin fetch wrapper for the BrattyBot JSON API. Same-origin — cookies (the session)
 * are sent automatically. Throws {@link ApiError} on non-2xx so callers can surface it.
 */

export class ApiError extends Error {
    constructor(
        public readonly status: number,
        message: string
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
        ...init,
    });

    if (!res.ok) {
        let message = `Request failed (${res.status})`;
        try {
            const body = (await res.json()) as { error?: string };
            if (body?.error) message = body.error;
        } catch {
            // Non-JSON error body — keep the generic message.
        }
        throw new ApiError(res.status, message);
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
