import { QueryClient } from '@tanstack/react-query';

/**
 * The dashboard's TanStack Query cache, for pages on the generated SDK.
 *
 * One factory for the app and for every test render, so a page under test caches,
 * retries and refetches exactly as it does in the browser — tests take a fresh one per
 * render so no answer leaks from one test into the next.
 *
 * Two query defaults are switched off, both to keep what pages did before the cache
 * (mutations already default to no retries):
 *
 *  - **`retry`**. A refusal here is a decision — no access, no such server, a bad body —
 *    and asking again gets the same answer three backoffs later, with a spinner in the
 *    meantime where the hand-written fetch showed the error at once. Tests would wait out
 *    the same backoff.
 *  - **`refetchOnWindowFocus`**. Pages keep an unsaved draft beside the saved value; a
 *    refetch on every tab switch would move the saved value under an operator mid-edit.
 */
export function createDashboardQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            queries: { retry: false, refetchOnWindowFocus: false },
        },
    });
}
