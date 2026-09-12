import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { notifications } from '@mantine/notifications';
import { api } from '../api/client';
import type { Guild } from '../api/types';

/**
 * Loads the guilds the bot is in that the user may manage. Single-server for now
 * (design doc §1), so `selected` is simply the first guild. The context is keyed by
 * guild so it stays multi-server-ready.
 */
interface GuildContextValue {
    guilds: Guild[];
    selected: Guild | null;
    loading: boolean;
    error: string | null;
}

const GuildContext = createContext<GuildContextValue | undefined>(undefined);

export function GuildProvider({ children }: { children: ReactNode }) {
    const [guilds, setGuilds] = useState<Guild[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            setLoading(true);
            setError(null);
            try {
                const data = await api.get<{ guilds: Guild[] }>('/api/guilds');
                if (!cancelled) setGuilds(data.guilds);
            } catch (err) {
                const message = err instanceof Error ? err.message : 'Failed to load servers';
                if (!cancelled) {
                    setError(message);
                    notifications.show({ color: 'red', title: 'Could not load servers', message });
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const value = useMemo<GuildContextValue>(
        () => ({ guilds, selected: guilds[0] ?? null, loading, error }),
        [guilds, loading, error]
    );

    return <GuildContext.Provider value={value}>{children}</GuildContext.Provider>;
}

export function useGuilds(): GuildContextValue {
    const ctx = useContext(GuildContext);
    if (!ctx) throw new Error('useGuilds must be used within a GuildProvider');
    return ctx;
}
