import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, getCurrentUser, logout as endSession, type AuthUser } from '@brattybot/web-sdk';
import { onSessionLost, sessionBegan, sessionEnded, sessionRestored } from './sessionGate';
import { startOver } from './startOver';

/**
 * Auth state, sourced from `GET /api/auth/me`. `user` is null when unauthenticated.
 * Login is a full-page redirect (`/api/auth/login`), so there is no in-app login call.
 *
 * `/me` is read with a direct SDK call rather than a query: it seeds this context once, on
 * mount, and this context is what empties the query cache on Log out — a user kept in
 * that cache would be cleared out from under the provider that owns it.
 *
 * **A session that runs out mid-session does not sign the dashboard out.** The session
 * gate (`sessionGate.ts`) holds the refused request and says so; this marks the session
 * `expired`, keeping the user, and `App`'s `AuthGate` puts the "sign in again" panel over the page
 * it leaves standing. `recheckSession` asks `/me` whether the operator has signed in again
 * (in another tab): the same person, and every held request goes out; somebody else, and
 * the dashboard loads afresh as them, because what this page holds is not theirs.
 */
interface AuthContextValue {
    /** Kept while the session is expired: the page under the panel is still theirs. */
    user: AuthUser | null;
    loading: boolean;
    /** The session ran out mid-session, and the page waits for the same person to sign in again. */
    sessionExpired: boolean;
    logout: () => Promise<void>;
    /** Ask whether the session is back. One check at a time; a second call shares the first's answer. */
    recheckSession: () => Promise<SessionRecheck>;
}

/** Where the session stands, as far as this page knows. */
type Session =
    | { readonly kind: 'checking' }
    | { readonly kind: 'signedOut' }
    | { readonly kind: 'signedIn'; readonly user: AuthUser }
    | { readonly kind: 'expired'; readonly user: AuthUser }
    /** Somebody else signed in on another tab; the dashboard is loading afresh as them. */
    | { readonly kind: 'replaced' };

/** What asking whether the session is back found. */
export type SessionRecheck = 'restored' | 'stillSignedOut' | 'unreachable' | 'replaced';

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
    const queryClient = useQueryClient();
    const [session, setSession] = useState<Session>({ kind: 'checking' });
    const sessionRef = useRef(session);
    sessionRef.current = session;

    // Subscribed before the `/me` read below starts. Only a signed-in session can expire:
    // the session gate passes a 401 straight through while nobody is.
    useEffect(
        () =>
            onSessionLost(() =>
                setSession((current) => (current.kind === 'signedIn' ? { kind: 'expired', user: current.user } : current))
            ),
        []
    );

    useEffect(() => {
        // StrictMode runs this twice in development; only the read still mounted counts, so
        // a late answer cannot tell the session gate something React does not show.
        let superseded = false;
        void (async () => {
            try {
                const { data: me } = await getCurrentUser();
                if (superseded) return;
                // Before the dashboard mounts, so its first request is already guarded.
                sessionBegan();
                setSession({ kind: 'signedIn', user: me });
            } catch (err) {
                if (superseded) return;
                // 401 is the normal "not logged in" case — anything else too, treat as signed out.
                if (!(err instanceof ApiError) || err.status !== 401) {
                    console.error('[auth] /me failed:', err);
                }
                setSession({ kind: 'signedOut' });
            }
        })();
        return () => {
            superseded = true;
        };
    }, []);

    /*
     * Somebody else signed in. `AuthGate` has shown its loader by the time this runs, so the
     * dashboard tree is unmounted — its unsaved-work prompt with it, and every write its
     * unmount flushed is held, because the session gate was never reopened. A fresh page then boots
     * as the new person, on their dashboard, with an empty cache.
     */
    useEffect(() => {
        if (session.kind === 'replaced') startOver();
    }, [session.kind]);

    const pendingRecheckRef = useRef<Promise<SessionRecheck> | null>(null);

    const recheckSession = useCallback((): Promise<SessionRecheck> => {
        pendingRecheckRef.current ??= askWhetherBack().finally(() => {
            pendingRecheckRef.current = null;
        });
        return pendingRecheckRef.current;

        async function askWhetherBack(): Promise<SessionRecheck> {
            const before = sessionRef.current;
            // Settled already, so nothing is pending: say how it settled.
            if (before.kind === 'replaced') return 'replaced';
            if (before.kind !== 'expired') return 'restored';
            let me: AuthUser;
            try {
                ({ data: me } = await getCurrentUser());
            } catch (err) {
                if (err instanceof ApiError && err.status === 401) return 'stillSignedOut';
                console.error('[auth] /me failed:', err);
                return 'unreachable';
            }
            if (me.id !== before.user.id) {
                setSession({ kind: 'replaced' });
                return 'replaced';
            }
            sessionRestored();
            setSession({ kind: 'signedIn', user: me });
            return 'restored';
        }
    }, []);

    const logout = useCallback(async () => {
        try {
            await endSession();
        } finally {
            // The cache is emptied so nothing one person loaded is on hand for whoever
            // signs in next in this tab; `AuthGate` shows the login page for a null user.
            sessionEnded();
            setSession({ kind: 'signedOut' });
            queryClient.clear();
        }
    }, [queryClient]);

    const value = useMemo<AuthContextValue>(
        () => ({
            user: signedInUser(session),
            loading: session.kind === 'checking' || session.kind === 'replaced',
            sessionExpired: session.kind === 'expired',
            logout,
            recheckSession,
        }),
        [session, logout, recheckSession]
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** The person whose dashboard this is, or null while there is none to show. */
function signedInUser(session: Session): AuthUser | null {
    switch (session.kind) {
        case 'signedIn':
        case 'expired':
            return session.user;
        case 'checking':
        case 'signedOut':
        case 'replaced':
            return null;
    }
}

export function useAuth(): AuthContextValue {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
    return ctx;
}
