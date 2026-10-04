import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onSessionLost, sessionBegan, sessionEnded, sessionGatedFetch, sessionRestored } from '../sessionGate';

/**
 * The session gate on its own, against a stub server whose session can run out and come
 * back: what it holds, what it sends again, and what it lets through.
 *
 * The whole app over it is `sessionExpiry.test.tsx`; the Flow Builder's draft surviving a
 * lost session, through the real routes, is `web/e2e/sessionExpiry.test.tsx`.
 */

const ORIGIN = 'http://dashboard.test';
const SETTINGS = `${ORIGIN}/api/guilds/900000000000000001/settings`;
const ME = `${ORIGIN}/api/auth/me`;

interface SentRequest {
    readonly url: string;
    readonly body: string;
}

/** A server that answers 401 to everything while `session.live` is false. */
function stubServer(): { readonly session: { live: boolean }; readonly sent: SentRequest[] } {
    const session = { live: true };
    const sent: SentRequest[] = [];
    vi.stubGlobal('fetch', async (request: Request): Promise<Response> => {
        sent.push({ url: request.url, body: await request.text() });
        return session.live
            ? new Response(JSON.stringify({ ok: true }), { status: 200 })
            : new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 });
    });
    return { session, sent };
}

/** Let everything already set going — a stub's answer, the gate's own steps — run. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

/** Whether `promise` has settled once everything already queued has run. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
    let settled = false;
    promise.then(
        () => (settled = true),
        () => (settled = true)
    );
    await tick();
    return settled;
}

function put(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return sessionGatedFetch(new Request(url, { method: 'PUT', body: JSON.stringify(body), signal }));
}

let lost = vi.fn();
let unsubscribe: () => void = () => undefined;

beforeEach(() => {
    lost = vi.fn();
    unsubscribe = onSessionLost(lost);
});

afterEach(() => {
    unsubscribe();
    sessionEnded();
    vi.unstubAllGlobals();
});

describe('the session gate', () => {
    it('lets a 401 through while nobody is signed in — the first visit, headed for the login page', async () => {
        const { session } = stubServer();
        session.live = false;

        const response = await put(SETTINGS, { staffRoleIds: [] });

        expect(response.status).toBe(401);
        expect(lost).not.toHaveBeenCalled();
    });

    it('holds a 401 while signed in, and sends the same body again once the session is back', async () => {
        const { session, sent } = stubServer();
        sessionBegan();
        session.live = false;

        const saving = put(SETTINGS, { staffRoleIds: ['1'] });

        expect(await hasSettled(saving)).toBe(false);
        expect(lost).toHaveBeenCalledOnce();

        session.live = true;
        sessionRestored();

        expect((await saving).status).toBe(200);
        expect(sent).toEqual([
            { url: SETTINGS, body: '{"staffRoleIds":["1"]}' },
            { url: SETTINGS, body: '{"staffRoleIds":["1"]}' },
        ]);
    });

    it('says the session is lost once, however many requests are refused together', async () => {
        const { session } = stubServer();
        sessionBegan();
        session.live = false;

        const first = put(SETTINGS, { staffRoleIds: ['1'] });
        const second = put(SETTINGS, { staffRoleIds: ['2'] });
        await hasSettled(Promise.all([first, second]));

        expect(lost).toHaveBeenCalledOnce();
        session.live = true;
        sessionRestored();
        expect((await Promise.all([first, second])).map((response) => response.status)).toEqual([200, 200]);
    });

    it('sends nothing new while the session is lost', async () => {
        const { session, sent } = stubServer();
        sessionBegan();
        session.live = false;
        const refused = put(SETTINGS, { staffRoleIds: ['1'] });
        await hasSettled(refused);
        const sentBeforeLater = sent.length;

        const later = put(SETTINGS, { staffRoleIds: ['2'] });

        expect(await hasSettled(later)).toBe(false);
        expect(sent).toHaveLength(sentBeforeLater);
        session.live = true;
        sessionRestored();
        expect((await later).status).toBe(200);
        expect(sent.at(-1)).toEqual({ url: SETTINGS, body: '{"staffRoleIds":["2"]}' });
    });

    it('never holds a call about the session itself — the recheck must be able to hear 401', async () => {
        const { session } = stubServer();
        sessionBegan();
        session.live = false;
        void put(SETTINGS, { staffRoleIds: [] });
        await tick();

        const asked = await sessionGatedFetch(new Request(ME));

        expect(asked.status).toBe(401);
    });

    it('sends a slow request again without losing the session a second time, when its 401 predates the sign-in', async () => {
        // The slow request left with the old cookie; by the time its 401 arrives the operator
        // has signed in again, so it is the old cookie being refused, not the new one.
        const slowAnswer: { send?: (response: Response) => void } = {};
        let live = false;
        vi.stubGlobal('fetch', async (request: Request): Promise<Response> => {
            const body = await request.text();
            if (body === '"slow"' && !slowAnswer.send) {
                return new Promise<Response>((resolve) => (slowAnswer.send = resolve));
            }
            return new Response('{}', { status: live ? 200 : 401 });
        });
        sessionBegan();

        const slow = put(SETTINGS, 'slow');
        const quick = put(SETTINGS, 'quick');
        await hasSettled(quick);
        expect(lost).toHaveBeenCalledOnce();

        live = true;
        sessionRestored();
        expect((await quick).status).toBe(200);
        expect(slowAnswer.send).toBeDefined();
        slowAnswer.send?.(new Response('{}', { status: 401 }));

        expect((await slow).status).toBe(200);
        expect(lost).toHaveBeenCalledOnce();
    });

    it('lets go of a held request that is aborted, rather than waiting on a sign-in', async () => {
        const { session } = stubServer();
        sessionBegan();
        session.live = false;
        const controller = new AbortController();

        const reading = put(SETTINGS, {}, controller.signal);
        await hasSettled(reading);
        controller.abort(new Error('left the page'));

        await expect(reading).rejects.toThrow('left the page');
    });

    it('leaves what it holds pending once signed out, and lets the next 401 through', async () => {
        const { session } = stubServer();
        sessionBegan();
        session.live = false;
        const held = put(SETTINGS, { staffRoleIds: ['1'] });
        await hasSettled(held);

        sessionEnded();
        sessionRestored();

        expect(await hasSettled(held)).toBe(false);
        expect((await put(SETTINGS, {})).status).toBe(401);
    });
});
