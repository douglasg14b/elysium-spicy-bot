import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, getCurrentUser, logout as endSession, type AuthUser } from '@brattybot/web-sdk';
import { onSessionLost } from './sessionLoss';

/**
 * Auth state, sourced from `GET /api/auth/me`. `user` is null when unauthenticated.
 * Login is a full-page redirect (`/api/auth/login`), so there is no in-app login call —
 * only `logout` and `refresh`.
 *
 * `/me` is read with a direct SDK call rather than a query: it seeds this context once, on
 * mount, and this context is what empties the query cache on sign-out — a user kept in
 * that cache would be cleared out from under the provider that owns it.
 */
interface AuthContextValue {
    user: AuthUser | null;
    loading: boolean;
    logout: () => Promise<void>;
    refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
    const queryClient = useQueryClient();
    const [user, setUser] = useState<AuthUser | null>(null);
    const [loading, setLoading] = useState(true);

    /*
     * Signed out, however it happened — the operator logged out, or the API answered 401.
     * The `Gate` shows the login page for a null user, and the cache is emptied so nothing
     * one person loaded is on hand for whoever signs in next in this tab.
     */
    const signedOut = useCallback(() => {
        setUser(null);
        queryClient.clear();
    }, [queryClient]);

    // Subscribed before the `/me` read below starts, so its own 401 is heard too.
    useEffect(() => onSessionLost(signedOut), [signedOut]);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const { data: me } = await getCurrentUser();
            setUser(me);
        } catch (err) {
            // 401 is the normal "not logged in" case — anything else too, treat as signed out.
            if (!(err instanceof ApiError) || err.status !== 401) {
                console.error('[auth] /me failed:', err);
            }
            setUser(null);
        } finally {
            setLoading(false);
        }
    }, []);

    const logout = useCallback(async () => {
        try {
            await endSession();
        } finally {
            signedOut();
        }
    }, [signedOut]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const value = useMemo<AuthContextValue>(
        () => ({ user, loading, logout, refresh }),
        [user, loading, logout, refresh]
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
    return ctx;
}
