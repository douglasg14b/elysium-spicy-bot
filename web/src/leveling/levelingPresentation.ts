/**
 * How leveling data is written on screen, in one place both pages read.
 *
 * The leaderboard and the member page each render a status, a moment and a count, and a
 * second copy of any of them would drift the moment a status gained a colour.
 */

import type { ActivityStatus, LevelingActivityChart, StatsPeriod } from '../api/types';

/** A status as a badge: the bot's own word for it, and a Mantine colour. */
export interface ActivityStatusPresentation {
    readonly label: string;
    readonly color: 'green' | 'yellow' | 'red' | 'gray';
}

/**
 * Every status, exhaustively.
 *
 * A `Record<ActivityStatus, …>` rather than a switch with a default: `ACTIVITY_STATUSES` is
 * mirrored from the bot by hand and gated by a drift test, so the moment the server starts
 * emitting a fifth status this object is a **compile error** instead of a row that renders
 * no badge at all.
 *
 * Labels are `formatActivityStatus`'s, verbatim — a member reading "Dormant" on their stats
 * card and "Inactive" on the dashboard would reasonably think they were different facts.
 * Colours are the stats card's hexes mapped onto the theme's ramps.
 */
export const ACTIVITY_STATUS_PRESENTATION: Readonly<
    Record<ActivityStatus, ActivityStatusPresentation>
> = {
    active: { label: 'Active', color: 'green' },
    quiet: { label: 'Quiet', color: 'yellow' },
    dormant: { label: 'Dormant', color: 'red' },
    none: { label: 'No activity', color: 'gray' },
};

/**
 * The period picker's options, built from the mirrored vocabulary.
 *
 * Labels match `formatStatsPeriodChartLabel`'s spans — the server computes the window from
 * `STATS_PERIOD_DAYS`, where a "year" is 52×7 days so the weekly buckets stay under the
 * chart's bar cap. Written as "1 year" rather than "365 days" for that reason: naming a day
 * count this side would be a number the bot does not actually use.
 */
export const STATS_PERIOD_LABELS: Readonly<Record<StatsPeriod, string>> = {
    week: '7 days',
    month: '30 days',
    year: '1 year',
};

/**
 * A moment, or an em dash when there has never been one.
 *
 * Null is a real answer here — a member with a progress row and no recorded activity has no
 * last-active timestamp — so it is not an error state. An unparseable string gets the same
 * dash: the server sends ISO, and a browser guessing at a malformed one would render
 * "Invalid Date" as though it were the fact.
 */
export function formatMoment(iso: string | null): string {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    });
}

/** The same, with the clock — for the one place that wants to know *when* today. */
export function formatMomentWithTime(iso: string | null): string {
    if (!iso) return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}

/**
 * A bucket's date as a short axis label.
 *
 * `activityDate` is a `YYYY-MM-DD` day key, not a timestamp, so it is split rather than fed
 * to `new Date()` — that parses a bare date as UTC midnight and a browser west of Greenwich
 * would render every bar labelled the day before.
 */
export function formatBucketDate(activityDate: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(activityDate);
    if (!match) return activityDate;
    const [, , month, day] = match;
    return `${Number(month)}/${Number(day)}`;
}

/**
 * A bucket's label, saying which *span* it covers.
 *
 * The server sets a weekly bucket's `activityDate` to the week's **first day**, so a bare
 * `9/15` on a year chart reads as a single day holding seven days of events — off by a factor
 * of seven, on the one figure someone would quote. A daily bucket needs no prefix.
 *
 * Takes the granularity rather than a boolean so the call site reads as what the server said,
 * and so a third granularity would be a compile error here rather than a silent `false`.
 */
export function bucketLabel(activityDate: string, granularity: LevelingActivityChart['granularity']): string {
    const date = formatBucketDate(activityDate);
    return granularity === 'weekly' ? `week of ${date}` : date;
}

/**
 * A rate to one decimal, because two is noise at this scale.
 *
 * No unit suffix: every call site labels its own row ("Messages / day"), and a `unit`
 * parameter every caller passed `''` to was a required argument existing only for its own
 * test.
 */
export function formatRate(value: number): string {
    return value.toFixed(1);
}

/**
 * A percentage the server already expressed as 0–100.
 *
 * No decimal, because there is none to show: every share metric is built with
 * `Math.round(… * 100)` in `statsCardMetrics.ts`, so `68.0%` would advertise a precision the
 * figure does not have. `Math.round` again rather than `toFixed`, so a float that arrives as
 * `67.99999` from JSON does not print as `67%`.
 */
export function formatPercent(value: number): string {
    return `${Math.round(value)}%`;
}

/**
 * A number the server sends as nullable, where null means "not computable".
 *
 * `avgMessageLengthRecent` and `avgXpPerMessageRecent` are null when there were no recent
 * messages to average over — a genuine "no denominator", not a zero. Rendering `0.0`
 * would claim the member sent empty messages rather than none.
 */
export function formatOptionalNumber(value: number | null, digits = 1): string {
    return value === null ? '—' : value.toFixed(digits);
}

/** Voice time as `4h 12m`, or `—` when nobody has held a channel open. */
export function formatVoiceDuration(totalSeconds: number): string {
    if (totalSeconds <= 0) return '—';
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    // Sub-minute sessions exist and rounding them to `0m` reads as a bug in the timer.
    return `${Math.floor(totalSeconds)}s`;
}
