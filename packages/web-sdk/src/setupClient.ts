import { apiErrorFromBody } from './apiError';
import { client } from './gen/client.gen';

export interface SetupClientOptions {
    /**
     * Where the API is served from, without `/api` — the spec's paths already carry it.
     * `''` in the dashboard: same origin in production, and Vite proxies `/api` in dev.
     */
    readonly baseUrl: string;
    /**
     * Called whenever the API answers 401, which means the session is gone — expired,
     * revoked, or never established. Optional: the dashboard does not pass one yet, so a
     * 401 surfaces as that page's error, the same as through the hand-written client.
     */
    readonly onUnauthorized?: () => void;
}

let isSetUp = false;
let unauthorizedHandler: (() => void) | undefined;

/*
 * Before setup, every request fails rather than going out against the generated
 * client's defaults. A request that silently ran without them would look like a server
 * problem: no credentials, so a 401 from a session that is perfectly valid.
 */
client.interceptors.request.use((request) => {
    if (!isSetUp) {
        throw new Error(
            'The dashboard API client is not set up. Call setupClient({ baseUrl }) once, before rendering anything that queries the API.'
        );
    }
    return request;
});

client.interceptors.response.use((response) => {
    if (response.status === 401) {
        unauthorizedHandler?.();
    }
    return response;
});

/*
 * The generated client throws a refused response's parsed body — or its raw text — and
 * nothing else, so the status is gone by the time a page sees it. Pages branch on the
 * status and read `issues`, so a refusal becomes an `ApiError` here, while the response
 * is still in reach.
 *
 * Only a refusal. With no response (the network failed, the request could not be built,
 * the client was never set up) or an OK one whose body would not parse, the original
 * error is the true account of what happened and is rethrown untouched — the same
 * `TypeError` a failed `fetch` gives the hand-written client.
 */
client.interceptors.error.use((error, response) =>
    response && !response.ok ? apiErrorFromBody(response.status, error) : error
);

/**
 * Configure the generated SDK for this app. Call once, before the first render.
 *
 * Every SDK call made before this throws, and every refusal after it is thrown as an
 * `ApiError` carrying the status, the server's message and any issues.
 */
export function setupClient({ baseUrl, onUnauthorized }: SetupClientOptions): void {
    unauthorizedHandler = onUnauthorized;
    client.setConfig({
        baseUrl,
        // The session is an HttpOnly cookie the browser attaches itself; nothing here
        // supplies a credential. Same-origin is enough because `/api` is.
        credentials: 'same-origin',
        /*
         * JSON or nothing. Left to `auto`, the client reads a 200 by its content type, so
         * an HTML page from a proxy, or the SPA fallback answering an unmounted `/api`
         * path, arrives as a string — and a page reading `data.staffRoleIds` sees
         * "nothing saved" and offers to save over the real list. Parsing as JSON makes
         * that a load error instead, as it was through the hand-written client.
         */
        parseAs: 'json',
        headers: { Accept: 'application/json' },
    });
    isSetUp = true;
}
