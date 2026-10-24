import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { listGuildsOptions, type Guild } from '@brattybot/web-sdk';

/**
 * Loads the guilds the bot is in that the user may manage, and which one the dashboard is
 * working on. `selected` is the operator's last pick while it is still in the list, and
 * the first guild otherwise — a server the bot left, or a different person signing in on
 * the same browser, falls back rather than showing nothing.
 */
interface GuildContextValue {
    guilds: readonly Guild[];
    selected: Guild | null;
    /** Make `guildId` the selected guild, remembered across reloads. */
    select: (guildId: string) => void;
    loading: boolean;
    error: string | null;
}

/** Where the last pick is kept: a browser preference, like the flow builder's column widths. */
export const SELECTED_GUILD_STORAGE_KEY = 'brattybot.selectedGuildId';

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

    const [pickedId, setPickedId] = useState<string | null>(() =>
        typeof window === 'undefined' ? null : window.localStorage.getItem(SELECTED_GUILD_STORAGE_KEY)
    );

    const select = useCallback((guildId: string) => {
        setPickedId(guildId);
        window.localStorage.setItem(SELECTED_GUILD_STORAGE_KEY, guildId);
    }, []);

    // Said once per failure, as the hand-written load did; the pages show their own state.
    useEffect(() => {
        if (error) notifications.show({ color: 'red', title: 'Could not load servers', message: error });
    }, [error]);

    const value = useMemo<GuildContextValue>(
        () => ({
            guilds,
            selected: guilds.find((guild) => guild.id === pickedId) ?? guilds[0] ?? null,
            select,
            loading,
            error,
        }),
        [guilds, pickedId, select, loading, error]
    );

    return <GuildContext.Provider value={value}>{children}</GuildContext.Provider>;
}

export function useGuilds(): GuildContextValue {
    const ctx = useContext(GuildContext);
    if (!ctx) throw new Error('useGuilds must be used within a GuildProvider');
    return ctx;
}
