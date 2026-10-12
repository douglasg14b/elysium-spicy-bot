import { onTestFinished, vi } from 'vitest';

/** The methods the SDK sends. */
export type FakeApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** A request the component sent, as the server would have received it. */
export interface RecordedApiRequest {
    readonly method: FakeApiMethod;
    /** Pathname plus search, exactly as fetched. */
    readonly path: string;
    /** The parsed JSON body, or `undefined` when none was sent. */
    readonly body: unknown;
}

/** What a route answers with. A status of 400 or above goes down `ApiError`'s path. */
export interface FakeApiReply {
    readonly status?: number;
    readonly body?: unknown;
}

export type FakeApiHandler = (request: RecordedApiRequest) => FakeApiReply | Promise<FakeApiReply>;

export interface FakeApi {
    /**
     * Answer `method path` with `handler`. A later registration for the same route
     * replaces the earlier one, so a test can change what the server says mid-test.
     */
    on(method: FakeApiMethod, path: string, handler: FakeApiHandler): void;
    /** Every request sent so far, in order. */
    readonly requests: readonly RecordedApiRequest[];
}

/**
 * Stand in for the bot's HTTP API underneath `@brattybot/web-sdk`, for one test.
 *
 * `fetch` is replaced rather than the SDK mocked, so the client's own error handling —
 * `ApiError`, the `error` body field, 204s, the session gate holding a 401 — runs as it does in the
 * browser.
 *
 * **A request nothing answers is a fault, not a 404.** The dialogs catch API errors and
 * show a sentence, so a route the test forgot to register would otherwise surface as a
 * component quietly rendering its error state, and a test asserting that state would
 * pass for the wrong reason. The fault is answered with a 500 so the component carries
 * on, and rethrown when the test finishes so the test fails naming the route. The same
 * rule TestDiscord follows for Discord's side.
 *
 * Restores `fetch` when the test finishes, so no teardown can be forgotten.
 */
export function installFakeApi(): FakeApi {
    const routes = new Map<string, FakeApiHandler>();
    const requests: RecordedApiRequest[] = [];
    const faults: string[] = [];

    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        // Read through a `Request`, so a call made either way is heard the same: the SDK
        // calls `fetch(request)` with no init, plain code `fetch(path, init)`.
        const sent = new Request(input, init);
        const url = new URL(sent.url);
        const method = sent.method.toUpperCase() as FakeApiMethod;
        const path = `${url.pathname}${url.search}`;
        const text = await sent.text();
        const body = text ? (JSON.parse(text) as unknown) : undefined;
        const request: RecordedApiRequest = { method, path, body };
        requests.push(request);

        const handler = routes.get(routeKey(method, path));
        if (!handler) {
            faults.push(`${method} ${path}`);
            return jsonResponse(500, { error: `No fake route for ${method} ${path}` });
        }

        const reply = await handler(request);
        const status = reply.status ?? 200;
        return status === 204 ? new Response(null, { status }) : jsonResponse(status, reply.body ?? {});
    };

    vi.stubGlobal('fetch', fakeFetch);

    onTestFinished(() => {
        vi.unstubAllGlobals();
        if (faults.length > 0) {
            throw new Error(
                `The component called routes this test never registered:\n  ${faults.join('\n  ')}`
            );
        }
    });

    return {
        on(method, path, handler) {
            routes.set(routeKey(method, path), handler);
        },
        requests,
    };
}

/** A reply a test sends when it chooses, and the way to send it. */
export interface HeldReply {
    /** Hand this to {@link FakeApi.on}'s handler; the request waits on it. */
    readonly reply: Promise<FakeApiReply>;
    readonly send: (reply: FakeApiReply) => void;
}

/**
 * A reply held back until the test sends it, so a request can be kept in flight while the
 * page does something else — a remount, a second click, another request overtaking it.
 */
export function heldReply(): HeldReply {
    let send: (reply: FakeApiReply) => void = () => undefined;
    const reply = new Promise<FakeApiReply>((settle) => {
        send = settle;
    });
    return { reply, send };
}

function routeKey(method: FakeApiMethod, path: string): string {
    return `${method} ${path}`;
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
