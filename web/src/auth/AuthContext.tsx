import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client';
import type { AuthUser } from '../api/types';

/**
 * Auth state, sourced from `GET /api/auth/me`. `user` is null when unauthenticated.
 * Login is a full-page redirect (`/api/auth/login`), so there is no in-app login call —
 * only `logout` and `refresh`.
 */
interface AuthContextValue {
    user: AuthUser | null;
    loading: boolean;
    logout: () => Promise<void>;
    refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<AuthUser | null>(null);
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const me = await api.get<AuthUser>('/api/auth/me');
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
            await api.post('/api/auth/logout');
        } finally {
            setUser(null);
        }
    }, []);

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
