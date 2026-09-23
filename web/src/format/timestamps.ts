/**
 * Rendering a stored ISO timestamp for a person to read.
 *
 * Extracted because the same function had been written four times — `FlowsListPage`,
 * `JourneysListPage`, `TicketsListPage` and (with a year) `TicketDetailPage` — which
 * meant a format change was a four-file edit and the `NaN` guard was untested in all
 * four. It lives in `web/src/format/` rather than a feature folder because three
 * different features need it; putting it under any one of them would make the other two
 * import across a feature boundary for a date.
 *
 * Both return an em dash rather than `Invalid Date` for an unparseable value. A table
 * cell is not the place to discover that a row's timestamp is broken, and `—` reads as
 * "nothing to show" to an operator while `Invalid Date` reads as a crash.
 */

interface TimestampParts {
    readonly month: 'short';
    readonly day: 'numeric';
    readonly hour: 'numeric';
    readonly minute: '2-digit';
}

const LIST_PARTS: TimestampParts = {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
};

/** Day and time, no year — for a list column where rows are mostly recent. */
export function formatTimestamp(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString(undefined, LIST_PARTS);
}

/**
 * Day, time **and year** — for a detail page.
 *
 * Separate from `formatTimestamp` rather than an option, because the choice is about
 * where it is being read and not about the value: a list of this week's tickets does not
 * want the year on every row, and a single closed ticket from last March does.
 */
export function formatTimestampWithYear(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString(undefined, { ...LIST_PARTS, year: 'numeric' });
}
