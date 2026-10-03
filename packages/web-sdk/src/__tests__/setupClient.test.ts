import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The hand-written half of the SDK: the guard against an unconfigured client, and the
 * interceptor that turns a refusal into an `ApiError`.
 *
 * The interceptor is the part pages depend on. The generated client throws a refused
 * response's parsed body and nothing else, so without it every page's
 * `err instanceof ApiError` would be false, its status gone, and the operator shown the
 * generic fallback instead of the server's sentence.
 *
 * Each test imports a fresh copy, because "never set up" is module state. The base URL
 * is absolute only because Node cannot resolve a relative one; the app passes `''`.
 */

const BASE_URL = 'http://dashboard.test';
const PATH = { guildId: '900000000000000001' };

async function freshSdk() {
    vi.resetModules();
    return import('../index');
}

function respondWith(status: number, body: unknown): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
            new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
        )
    );
}

beforeEach(() => {
    vi.unstubAllGlobals();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('setupClient', () => {
    it('refuses to send anything before it is called', async () => {
        const sdk = await freshSdk();
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        // The base URL per call, so the request can be built in Node at all and it is the
        // guard, not URL parsing, that stops it.
        await expect(
            sdk.getWarningsConfig({ baseUrl: BASE_URL, path: PATH })
        ).rejects.toThrow(/not set up/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    // No `throwOnError` passed anywhere below: every call throws by default, which is the
    // contract pages rely on when they `await` an SDK function directly.
    it('throws a refusal as an ApiError carrying the status, the message and the issues', async () => {
        const sdk = await freshSdk();
        sdk.setupClient({ baseUrl: BASE_URL });
        const issues = [{ nodeId: 'node-1', field: 'channelId', message: 'Pick a channel.' }];
        respondWith(409, { error: 'Someone else got there first.', issues });

        const error: unknown = await sdk.getWarningsConfig({ path: PATH }).catch((thrown) => thrown);

        expect(error).toBeInstanceOf(sdk.ApiError);
        expect(error).toMatchObject({ status: 409, message: 'Someone else got there first.', issues });
    });

    it('falls back to the status when the refusal has no usable body', async () => {
        const sdk = await freshSdk();
        sdk.setupClient({ baseUrl: BASE_URL });
        vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502 })));

        const error: unknown = await sdk.getWarningsConfig({ path: PATH }).catch((thrown) => thrown);

        expect(error).toMatchObject({ status: 502, message: 'Request failed (502)', issues: [] });
    });

    it('leaves a network failure as it was, since there is no status to report', async () => {
        const sdk = await freshSdk();
        sdk.setupClient({ baseUrl: BASE_URL });
        const offline = new TypeError('fetch failed');
        vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(offline)));

        await expect(sdk.getWarningsConfig({ path: PATH })).rejects.toBe(offline);
    });

    it('fails a 200 that is not JSON rather than reading it as empty data', async () => {
        // An HTML page in place of the API: read as a string, a page would take it for
        // "nothing saved" and offer to save over the real value.
        const sdk = await freshSdk();
        sdk.setupClient({ baseUrl: BASE_URL });
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('<html>Sign in</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
        );

        await expect(sdk.getGuildSettings({ path: PATH })).rejects.toBeInstanceOf(SyntaxError);
    });

    it('reports a 401 to onUnauthorized', async () => {
        const sdk = await freshSdk();
        const onUnauthorized = vi.fn();
        sdk.setupClient({ baseUrl: BASE_URL, onUnauthorized });
        respondWith(401, { error: 'Not authenticated' });

        await sdk.getWarningsConfig({ path: PATH }).catch(() => undefined);

        expect(onUnauthorized).toHaveBeenCalledOnce();
    });
});
