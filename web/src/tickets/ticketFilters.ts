import type { TicketingConfigView } from '../api/types';

/**
 * What the list is currently narrowed to.
 *
 * `status: 'all'` rather than `undefined` for "no status filter", because the control is
 * a `SegmentedControl` and a segmented control always has a value — modelling "all" as
 * absence would mean the UI's state and this type disagreeing about what is selected.
 *
 * **The default is open tickets only.** A ticket list that opens on the guild's entire
 * history buries the handful anybody can act on under everything already dealt with.
 */
export type TicketStatusFilter = 'open' | 'closed' | 'deleted' | 'all';

export interface TicketFilterState {
    readonly status: TicketStatusFilter;
    /** A declared type key, or null for every type. */
    readonly type: string | null;
    readonly unclaimedOnly: boolean;
    readonly search: string;
}

export const DEFAULT_TICKET_FILTER: TicketFilterState = {
    status: 'open',
    type: null,
    unclaimedOnly: false,
    search: '',
};

/**
 * The filter as query parameters for `listTickets`.
 *
 * `all` becomes an absent `status` rather than the literal string, which is the shape
 * the route expects — it validates `status` against the three real statuses and would
 * reject `all` as nonsense, correctly.
 */
export function toListFilter(filter: TicketFilterState): {
    status?: string;
    type?: string;
    unclaimedOnly?: boolean;
    search?: string;
} {
    return {
        status: filter.status === 'all' ? undefined : filter.status,
        type: filter.type ?? undefined,
        unclaimedOnly: filter.unclaimedOnly || undefined,
        search: filter.search.trim() || undefined,
    };
}

/**
 * The type dropdown's options, from the guild's own declarations.
 *
 * Labelled, because an operator picks "Support" and not `support`. An `All types` entry
 * leads, with an empty value — the absence of a filter has to be selectable or there is
 * no way back from having chosen one.
 */
export function typeFilterOptions(
    config: TicketingConfigView | null
): { value: string; label: string }[] {
    const declared = (config?.types ?? []).map((type) => ({ value: type.type, label: type.label }));
    return [{ value: '', label: 'All types' }, ...declared];
}

/*
 * There is deliberately **no** client-side `filterTickets` here.
 *
 * The plan listed one, and it would have had no call site: every filter on this page is
 * a query parameter, because the list is unpaginated and narrowing in the browser would
 * mean shipping a guild's whole ticket history in order to hide most of it. A second
 * filtering implementation with no caller is a second place for the rules to drift from
 * the route's, and the first place somebody would "fix" a disagreement in the wrong
 * direction.
 *
 * `toListFilter` above is the one translation, and the route is the one authority.
 */
