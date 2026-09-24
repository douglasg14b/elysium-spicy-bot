/** Ticket API helpers. Same style as `journeys.ts` — pages stay URL-free. */

import { api } from './client';
import type {
    TicketActionResult,
    TicketCounts,
    TicketDetail,
    TicketSummary,
    TicketTypeView,
    TicketingConfigView,
} from './types';

/**
 * What narrows the list, all optional.
 *
 * An absent member means "all" rather than "none" — a filter nobody set must not hide
 * every row. `search` is handed to a server-side query rather than applied here: the
 * list is unpaginated, and shipping a guild's whole ticket history to the browser so it
 * can hide most of it is not a search.
 */
export interface TicketListFilter {
    status?: string;
    type?: string;
    unclaimedOnly?: boolean;
    search?: string;
}

export interface TicketListResult {
    tickets: TicketSummary[];
    /** Guild-wide, so the strip does not move when the list is filtered. */
    counts: TicketCounts;
    /**
     * Whether the server capped the rows it returned.
     *
     * The list is bounded server-side — an uncapped one on a mature guild meant serialising
     * the whole ticket history into one response — so the table has to be able to say it is
     * showing a slice. `counts` still reports the guild's true totals, so the two together
     * are honest: "200 of 4,312 shown, narrow it".
     */
    truncated: boolean;
}

export function listTickets(guildId: string, filter: TicketListFilter = {}): Promise<TicketListResult> {
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.type) params.set('type', filter.type);
    if (filter.unclaimedOnly) params.set('unclaimed', 'true');
    if (filter.search?.trim()) params.set('search', filter.search.trim());

    const query = params.toString();
    return api.get<TicketListResult>(`/api/guilds/${guildId}/tickets${query ? `?${query}` : ''}`);
}

export function getTicket(guildId: string, ticketId: number): Promise<TicketDetail> {
    return api.get<TicketDetail>(`/api/guilds/${guildId}/tickets/${ticketId}`);
}

/**
 * The four lifecycle actions.
 *
 * One function rather than four, because the only thing that differs is the path
 * segment and the caller already holds the action as data — the row's buttons are
 * rendered from `availableActions`, so four named exports would be four things to keep
 * in step with one list.
 *
 * No `delete`: destroying a ticket destroys its channel, and that stays in Discord.
 */
export type TicketAction = 'claim' | 'unclaim' | 'close' | 'reopen';

export function actOnTicket(
    guildId: string,
    ticketId: number,
    action: TicketAction
): Promise<TicketActionResult> {
    return api.post<TicketActionResult>(`/api/guilds/${guildId}/tickets/${ticketId}/${action}`);
}

export function getTicketsConfig(guildId: string): Promise<TicketingConfigView> {
    return api.get<TicketingConfigView>(`/api/guilds/${guildId}/config/tickets`);
}

/** Replaces the categories and moderation roles. The declared types are left alone. */
export function updateTicketsConfig(
    guildId: string,
    input: {
        supportTicketCategoryName: string;
        claimedTicketCategoryName: string;
        closedTicketCategoryName: string;
        moderationRoles: string[];
    }
): Promise<TicketingConfigView> {
    return api.put<TicketingConfigView>(`/api/guilds/${guildId}/config/tickets`, input);
}

/**
 * Adds or replaces one ticket type.
 *
 * The key travels in the path, so the body cannot disagree with it about which type is
 * being written. Returns the whole config so the editor re-reads every type rather than
 * patching the one row it changed.
 */
export function saveTicketType(
    guildId: string,
    type: string,
    input: Omit<TicketTypeView, 'type'>
): Promise<TicketingConfigView> {
    return api.put<TicketingConfigView>(
        `/api/guilds/${guildId}/config/tickets/types/${encodeURIComponent(type)}`,
        input
    );
}

/**
 * Removes a ticket type.
 *
 * Refused with a 409 while any ticket holds it, including deleted ones — their rows
 * still have to be able to render their own label. The refusal names the counts and a
 * few ticket numbers, and it is shown verbatim.
 */
export function deleteTicketType(guildId: string, type: string): Promise<void> {
    return api.delete<void>(
        `/api/guilds/${guildId}/config/tickets/types/${encodeURIComponent(type)}`
    );
}
