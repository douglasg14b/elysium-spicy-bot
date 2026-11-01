import { calendarDateFromUtcMidnight, compareCalendarDates, getPacificCalendarDate } from './warningDates';

/** Every status a warning can be in, in the order the dashboard lists them. */
export const WARNING_STATUSES = ['active', 'expired', 'released'] as const;

/**
 * Where a warning stands. **Derived, never stored**, and derived only here (the repo's
 * predicates in `warningsRepo.ts` are the same rule in SQL):
 *
 *  - `released` — a moderator cleared it (`clearedAt` set). Wins over expiry: releasing an
 *    expired warning is allowed, and the release is the more specific fact.
 *  - `expired` — not released, and its drop-off date is before today on the Pacific
 *    calendar. It counts through the whole of its drop-off day.
 *  - `active` — otherwise.
 */
export type WarningStatus = (typeof WARNING_STATUSES)[number];

/** The two fields a warning's status is derived from. */
export type WarningStatusFields = {
    readonly clearedAt: Date | null;
    readonly expiresAt: Date;
};

/** Whether a string from outside (a query parameter) names a {@link WarningStatus}. */
export function isWarningStatus(value: string): value is WarningStatus {
    return (WARNING_STATUSES as readonly string[]).includes(value);
}

/**
 * The status of `warning` at the moment `now`. See {@link WarningStatus} for the rule.
 *
 * @param now - A real moment; its Pacific calendar day is "today". **Not** the repo's
 *   `asOf` (`getActiveAsOfUtcMidnight`), which is that day's UTC midnight — the previous
 *   afternoon in Los Angeles, so passing it here would judge a day early.
 */
export function warningStatus(warning: WarningStatusFields, now: Date = new Date()): WarningStatus {
    if (warning.clearedAt) {
        return 'released';
    }

    const dropsOff = calendarDateFromUtcMidnight(warning.expiresAt);
    const today = getPacificCalendarDate(now);
    return compareCalendarDates(dropsOff, today) >= 0 ? 'active' : 'expired';
}

/** Whether `warning` is active at the moment `now` — {@link warningStatus}, not a second copy of its rule. */
export function isWarningActive(warning: WarningStatusFields, now: Date = new Date()): boolean {
    return warningStatus(warning, now) === 'active';
}
