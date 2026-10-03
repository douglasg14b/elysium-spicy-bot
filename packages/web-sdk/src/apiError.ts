/**
 * One problem the server pinned on part of a request, as an error body's `issues` carries
 * it. Only the flow graph routes send any today.
 *
 * The shape of the server's and the dashboard's `FlowValidationIssue`, written out here
 * because the SDK can import from neither. `src/web/api/__tests__/flowRoutes.test.ts`
 * holds the three to each other at compile time. It moves into the spec when the flow
 * routes do.
 */
export interface ApiIssue {
    readonly nodeId?: string;
    readonly field?: string;
    readonly message: string;
}

/**
 * Every refusal the dashboard API answers with, thrown by both the generated SDK and the
 * hand-written client in `web/src/api/client.ts` while pages move from one to the other —
 * so one `instanceof ApiError` check holds whichever client a page uses.
 *
 * Carries the HTTP status, which a page branches on (a 409 is not a 400), and the
 * server's own sentence from the `{ error }` body.
 */
export class ApiError extends Error {
    /**
     * The same sentence as `message`, under the body's own name.
     *
     * The generated signatures type every error as the response's `ErrorBody` — the
     * generator cannot see that `setupClient` throws this class instead — so a query's
     * `error.error` compiles. Carrying it makes that type true rather than a field that
     * reads `undefined` at runtime.
     */
    public readonly error: string;

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
        public readonly issues: readonly ApiIssue[] = []
    ) {
        super(message);
        this.name = 'ApiError';
        this.error = message;
    }
}

/**
 * The {@link ApiError} for a refused response, read from its parsed body.
 *
 * `body` is whatever the response held — the parsed JSON, the raw text when it was not
 * JSON, or nothing — so every field is checked rather than trusted: a proxy or an older
 * server can put anything there, and a non-array `issues` would otherwise reach a `.map`
 * in the builder as a render-time crash.
 */
export function apiErrorFromBody(status: number, body: unknown): ApiError {
    let message = `Request failed (${status})`;
    let issues: readonly ApiIssue[] = [];

    if (body && typeof body === 'object') {
        const { error, issues: bodyIssues } = body as { error?: unknown; issues?: unknown };
        if (typeof error === 'string' && error) message = error;
        if (Array.isArray(bodyIssues)) issues = bodyIssues as ApiIssue[];
    }

    return new ApiError(status, message, issues);
}
