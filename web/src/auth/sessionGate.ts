/**
 * The session gate: what a session running out does to the dashboard's requests.
 *
 * Every SDK call goes through {@link sessionGatedFetch}, which `main.tsx` hands to
 * `setupClient`. While somebody is signed in, a request the API refuses with a 401 is not
 * failed: the session is marked lost, `AuthProvider` hears it through
 * {@link onSessionLost} and puts the "sign in again" panel over the page, and the request
 * **waits**. When the same person has signed in again, `AuthProvider` calls
 * {@link sessionRestored} and the request is sent again — so an autosave lands, a Save
 * completes, a read fills its page, and nothing the operator had on screen is lost. No
 * caller sees a 401, so no page shows a failure for one.
 *
 * While the session is lost, a new request waits **before it is sent**. It would only be
 * refused; and if somebody else signs in on another tab, the cookie becomes theirs, and a
 * request still going out from this page would be sent as them.
 *
 * Sending again is safe: on this API a 401 comes only from `requireAuth`, which runs
 * before any handler, so a refused request was never carried out. The request is cloned
 * before it is sent, because sending consumes its body.
 *
 * `/api/auth/*` is never held. `/me` is how `AuthProvider` asks whether the session is
 * back, and has to be able to answer 401; a 401 on logout means already signed out. With
 * nobody signed in — before the boot `/me` has answered, or after Log out — a 401 is an
 * answer and passes straight through, which is what sends a first visit to the login page.
 *
 * Every request it gates while somebody is signed in carries their id in
 * {@link SESSION_USER_HEADER}. The cookie is the browser's, not this page's: if somebody
 * else signs in on another tab, it becomes theirs while this page still shows the last
 * person's work. The API refuses a request whose header names somebody other than the
 * cookie's owner with the same 401 as no session, so the page's next request loses the
 * session here, the panel goes up, and `/me` — never stamped — answers with the new
 * person, which `AuthProvider` takes as somebody else having signed in. Log out is
 * stamped too, though never held, so a stale tab cannot sign the new person out.
 */

type SessionLostListener = () => void;

type GateState =
    /** Nobody signed in: a 401 is an answer. */
    | { readonly kind: 'signedOut' }
    | { readonly kind: 'signedIn'; readonly userId: string }
    /** Signed in until a 401 said otherwise. Requests wait for `reopened`. */
    | { readonly kind: 'lost'; readonly userId: string; readonly reopened: Promise<void>; readonly reopen: () => void };

/** Every path under it is about the session itself, and answers for itself. */
const SESSION_PATH_PREFIX = '/api/auth/';
/** The one session path that is stamped: it acts on the cookie, so it must be this page's. */
const LOGOUT_PATH = '/api/auth/logout';

/**
 * Names who this page is signed in as. `requireAuth` (`src/web/auth/middleware.ts`) reads
 * it under the same name; its `middleware.test.ts` fails if the two drift.
 */
export const SESSION_USER_HEADER = 'X-BrattyBot-User';

let state: GateState = { kind: 'signedOut' };

/**
 * Moves on with every restore. A 401 for a request sent before the last restore was the
 * old cookie being refused — a slow request overtaken by the sign-in — so it is sent again
 * at once rather than taken as the new session being lost.
 */
let generation = 0;

const listeners = new Set<SessionLostListener>();

/**
 * The `fetch` for `setupClient`. Calls the global `fetch` as each request is made, so a
 * test that stubs it is heard.
 */
export async function sessionGatedFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path.startsWith(SESSION_PATH_PREFIX)) {
        // Never held, but Log out still says whose session it ends: in a tab whose cookie
        // somebody else has since taken, it is refused rather than signing them out.
        if (path === LOGOUT_PATH) stamp(request);
        return globalThis.fetch(request);
    }
    return send(request, request.signal);
}

/** Name the signed-in person on `request`, if anybody is. */
function stamp(request: Request): void {
    if (state.kind !== 'signedOut') request.headers.set(SESSION_USER_HEADER, state.userId);
}

/**
 * Send `request`, holding it while the session is lost. `signal` is the first request's,
 * for every wait: a clone's signal is not a dependable stand-in — Node's `Request.clone()`
 * keeps the clone's controller only weakly, so once it is collected an abort stops reaching
 * the clone.
 */
async function send(request: Request, signal: AbortSignal): Promise<Response> {
    if (state.kind === 'lost') await untilReopened(state.reopened, signal);
    // Stamped as it goes, every time: a request held across a restore goes out naming
    // whoever is signed in by then, and the clone below carries the stamp to a resend.
    stamp(request);
    const sentIn = generation;
    const again = request.clone();
    const response = await globalThis.fetch(request);
    if (response.status !== 401 || state.kind === 'signedOut') return response;
    if (sentIn !== generation) return send(again, signal);
    await untilReopened(loseSession(), signal);
    return send(again, signal);
}

/** Mark the session lost, once however many requests say so, and tell the listeners. */
function loseSession(): Promise<void> {
    if (state.kind === 'lost') return state.reopened;
    if (state.kind === 'signedOut') throw new Error('A session nobody began cannot be lost.');
    let reopen: () => void = () => undefined;
    const reopened = new Promise<void>((resolve) => {
        reopen = resolve;
    });
    state = { kind: 'lost', userId: state.userId, reopened, reopen };
    for (const listener of listeners) listener();
    return reopened;
}

/**
 * Resolves when `reopened` does, which may be never. Rejects with the signal's reason if
 * the request is aborted first, so a query TanStack cancels does not wait for a sign-in.
 */
function untilReopened(reopened: Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const abandon = (): void => reject(signal.reason);
        signal.addEventListener('abort', abandon, { once: true });
        void reopened.then(() => {
            signal.removeEventListener('abort', abandon);
            resolve();
        });
    });
}

/**
 * `userId` is signed in: from now on a 401 means their session ran out, and every gated
 * request names them. Called on the boot `/me` answering, before the dashboard mounts, so
 * its first request is guarded. Nothing, unless nobody was: a session already signed in,
 * or lost and waiting, is not begun again by a late answer.
 */
export function sessionBegan(userId: string): void {
    if (state.kind !== 'signedOut') return;
    state = { kind: 'signedIn', userId };
}

/**
 * The same person signed in again: every held request goes out, still naming them.
 * Nothing, if none is held.
 */
export function sessionRestored(): void {
    if (state.kind !== 'lost') return;
    const { reopen, userId } = state;
    generation += 1;
    state = { kind: 'signedIn', userId };
    reopen();
}

/**
 * Signed out on purpose. A request still held is left pending and never settles: it was
 * waiting for a session this page will not get back. (Unreachable from the UI, where Log
 * out sits under the panel; it is also how each dom test starts afresh.)
 *
 * Not called when somebody else signs in: the gate stays shut so that nothing of this page
 * goes out as them, and `AuthProvider` loads the dashboard afresh instead.
 */
export function sessionEnded(): void {
    state = { kind: 'signedOut' };
}

/** Be told when the session is lost. Returns the unsubscribe, for an effect's cleanup. */
export function onSessionLost(listener: SessionLostListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
