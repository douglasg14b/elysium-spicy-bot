/**
 * Ticket API helpers for the list and detail pages. Same style as `journeys.ts` — pages
 * stay URL-free.
 *
 * The shapes are the SDK's (`@brattybot/web-sdk`), generated from the routes. The ticket
 * config is read and written through the SDK itself; these calls move to it with the list
 * and detail pages.
 */

import type { TicketActionResult, TicketDetail, TicketList } from '@brattybot/web-sdk';
import { api } from './client';

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

/**
 * The tickets matching `filter`, the guild-wide counts, and whether the server capped the
 * rows it returned — `counts` still reports the true totals, so the two together are
 * honest: "200 of 4,312 shown, narrow it".
 */
export function listTickets(guildId: string, filter: TicketListFilter = {}): Promise<TicketList> {
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.type) params.set('type', filter.type);
    if (filter.unclaimedOnly) params.set('unclaimed', 'true');
    if (filter.search?.trim()) params.set('search', filter.search.trim());

    const query = params.toString();
    return api.get<TicketList>(`/api/guilds/${guildId}/tickets${query ? `?${query}` : ''}`);
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
