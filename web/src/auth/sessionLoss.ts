/**
 * "The API says nobody is signed in", carried from the SDK's client to the auth context.
 *
 * The SDK is set up once, before the first render (`main.tsx`), and reports a 401 through
 * the `onUnauthorized` it was handed then — long before `AuthProvider` exists to act on
 * it. This is the hand-off between the two: `setupClient` is given
 * {@link reportSessionLost}, and `AuthProvider` subscribes with {@link onSessionLost}.
 *
 * A 401 means the session is gone — expired, revoked, or never established — so the
 * dashboard signs out rather than showing that page's error. The first `/auth/me` before
 * login answers 401 too, and reports here like any other; signing out an already
 * signed-out dashboard changes nothing.
 */

type SessionLostListener = () => void;

const listeners = new Set<SessionLostListener>();

/** Tell every subscriber the session is gone. The SDK's `onUnauthorized`. */
export function reportSessionLost(): void {
    for (const listener of listeners) listener();
}

/** Be told when the session is gone. Returns the unsubscribe, for an effect's cleanup. */
export function onSessionLost(listener: SessionLostListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
