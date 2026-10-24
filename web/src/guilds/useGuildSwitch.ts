/**
 * Switching the server the dashboard works on.
 *
 * A switch is a navigation, not just a state change. Whatever page is open belongs to the
 * old server — a flow, a ticket, a member's record — so the switch lands on that section's
 * own page, and it only happens if that navigation does: the flow builder holds a
 * navigation away from unsaved work, and an operator who answers "stay" must stay on the
 * server they were editing. So the guild to switch to rides the navigation's state, and is
 * applied once the router has actually arrived.
 */

import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useGuilds } from './GuildContext';

interface GuildSwitchState {
    readonly switchToGuildId: string;
}

/** The section's own page: `/flows/abc` → `/flows`. A detail page names something in the old server. */
export function pathAfterGuildSwitch(pathname: string): string {
    const [section] = pathname.split('/').filter(Boolean);
    return section ? `/${section}` : '/';
}

/** The guild a navigation carries a switch to, if it carries one. */
function pendingGuildSwitch(state: unknown): string | null {
    if (typeof state !== 'object' || state === null || !('switchToGuildId' in state)) return null;
    return typeof state.switchToGuildId === 'string' ? state.switchToGuildId : null;
}

export interface GuildSwitch {
    /** A switch has arrived and is being applied; the page should wait a render for it. */
    readonly switching: boolean;
    /** Go to the section's own page as `guildId`. */
    readonly switchTo: (guildId: string) => void;
}

export function useGuildSwitch(): GuildSwitch {
    const { select } = useGuilds();
    const location = useLocation();
    const navigate = useNavigate();
    const pending = pendingGuildSwitch(location.state);

    useEffect(() => {
        if (!pending) return;
        select(pending);
        // Drop the switch from the history entry, so going back to it later does not switch again.
        navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null });
    }, [pending, select, navigate, location.pathname, location.search]);

    return {
        switching: pending !== null,
        switchTo: (guildId) => {
            const state: GuildSwitchState = { switchToGuildId: guildId };
            navigate(pathAfterGuildSwitch(location.pathname), { state });
        },
    };
}
