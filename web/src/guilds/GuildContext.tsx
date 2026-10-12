import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { listGuildsOptions, type Guild } from '@brattybot/web-sdk';

/**
 * Loads the guilds the bot is in that the user may manage. Single-server for now
 * (design doc §1), so `selected` is simply the first guild. The context is keyed by
 * guild so it stays multi-server-ready.
 */
interface GuildContextValue {
    guilds: readonly Guild[];
    selected: Guild | null;
    loading: boolean;
    error: string | null;
}

const GuildContext = createContext<GuildContextValue | undefined>(undefined);

/** One reference for "none loaded", so the context value does not change on every render. */
const NO_GUILDS: readonly Guild[] = [];

export function GuildProvider({ children }: { children: ReactNode }) {
    const guildsQuery = useQuery(listGuildsOptions());
    const guilds = guildsQuery.data?.guilds ?? NO_GUILDS;
    const loading = guildsQuery.isPending;
    const error = guildsQuery.error
        ? guildsQuery.error instanceof Error
            ? guildsQuery.error.message
            : 'Failed to load servers'
        : null;

    // Said once per failure, as the hand-written load did; the pages show their own state.
    useEffect(() => {
        if (error) notifications.show({ color: 'red', title: 'Could not load servers', message: error });
    }, [error]);

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
