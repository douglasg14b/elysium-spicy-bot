import type { ListWarningsData, WarningStatus } from '@brattybot/web-sdk';

/**
 * What the warnings list is narrowed to.
 *
 * `'all'` rather than absence for "no status filter", because the control is a
 * `SegmentedControl` and a segmented control always has a value — the tickets list's
 * reasoning (`ticketFilters.ts`).
 *
 * **The default is active warnings only.** The ones still counting against somebody are what
 * a mod opening this page is there for; the record of everything else is one click away.
 */
export type WarningStatusFilter = WarningStatus | 'all';

/**
 * One member the list is narrowed to. `id` is the filter; `name` is only what the chip says,
 * taken from the row that was clicked, and is never sent or matched on.
 */
export interface WarningMemberFilter {
    readonly id: string;
    readonly name: string;
}

/** Everything the list is narrowed by: one status (or all), one member, and the search text. */
export interface WarningFilterState {
    readonly status: WarningStatusFilter;
    readonly member: WarningMemberFilter | null;
    readonly search: string;
}

/** Where the page opens: active warnings, anybody's, no search. */
export const DEFAULT_WARNING_FILTER: WarningFilterState = {
    status: 'active',
    member: null,
    search: '',
};

/** The list route's query, as the route declares it. */
export type WarningListQuery = NonNullable<ListWarningsData['query']>;

/**
 * The filter as the list route's query — and so the list's cache key, so two filters that
 * mean the same thing share one entry. `all`, no member and a blank search are absent: the
 * route reads absence as "every".
 */
export function toListFilter(filter: WarningFilterState): WarningListQuery {
    return {
        status: filter.status === 'all' ? undefined : filter.status,
        userId: filter.member?.id,
        search: filter.search.trim() || undefined,
    };
}

/**
 * Whether a filter could be hiding warnings that exist: a member or a search. The status is
 * not one — the server-wide counts already say how many of each status there are, so an
 * empty status is "none of those", never "your filters hid them".
 */
export function filtersHideWarnings(filter: WarningFilterState): boolean {
    return filter.member !== null || filter.search.trim() !== '';
}
