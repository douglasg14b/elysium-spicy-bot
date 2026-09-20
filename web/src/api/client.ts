/**
 * Thin fetch wrapper for the BrattyBot JSON API. Same-origin — cookies (the session)
 * are sent automatically. Throws {@link ApiError} on non-2xx so callers can surface it.
 */

import type { FlowValidationIssue } from './types';

export class ApiError extends Error {
    constructor(
        public readonly status: number,
        message: string,
        /**
         * Per-node, per-field detail, when the endpoint sends any.
         *
         * Empty for every endpoint that does not — the graph save is the only one
         * today — so a caller can read it without asking which endpoint it came
         * from. `message` always says the same thing in one sentence, so a caller
         * with nowhere to put a list loses placement rather than the error.
         */
        public readonly issues: readonly FlowValidationIssue[] = []
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
        let issues: readonly FlowValidationIssue[] = [];
        try {
            const body = (await res.json()) as { error?: string; issues?: FlowValidationIssue[] };
            if (body?.error) message = body.error;
            // Guarded rather than trusted: this is a parsed response body, and a
            // proxy or an older server can put anything here. A non-array would
            // otherwise reach `.map` in the builder as a render-time crash.
            if (Array.isArray(body?.issues)) issues = body.issues;
        } catch {
            // Non-JSON error body — keep the generic message.
        }
        throw new ApiError(res.status, message, issues);
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
