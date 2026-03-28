/**
 * Celebration rules use the Node process local timezone (same as `Date` getters:
 * `getFullYear()`, `getMonth()`, `getDate()`).
 *
 * **Deployment contract:** Operators must align the process timezone with the community’s
 * “calendar day” for birthdays—typically by setting the `TZ` environment variable (IANA name,
 * e.g. `America/Chicago`) or equivalent container/host timezone. A mismatch yields wrong
 * eligibility, missed announcements, or inconsistent dedup versus member expectations.
 *
 * February 29 birthdays: in a leap year the observed calendar day is Feb 29; in a
 * non-leap year it is Feb 28 (not Mar 1). Used for eligibility and announcement dedup.
 */

export function isLeapYear(year: number): boolean {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Local calendar YYYY-MM-DD for dedup (process timezone). */
export function formatLocalDateKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** True when `lastAnnouncedAt` falls on the same local calendar day as `now` (announcement dedup). */
export function wasAnnouncedOnSameLocalDayAsNow(lastAnnouncedAt: Date, now: Date): boolean {
    return formatLocalDateKey(lastAnnouncedAt) === formatLocalDateKey(now);
}

/**
 * Whether `now` (local) is the observed celebration day for the stored month/day.
 */
export function isBirthdayCelebratedToday(storedMonth: number, storedDay: number, now: Date): boolean {
    const todayMonth = now.getMonth() + 1;
    const todayDay = now.getDate();
    const year = now.getFullYear();

    if (storedMonth === 2 && storedDay === 29) {
        if (isLeapYear(year)) {
            return todayMonth === 2 && todayDay === 29;
        }
        return todayMonth === 2 && todayDay === 28;
    }

    return storedMonth === todayMonth && storedDay === todayDay;
}

/**
 * (month, day) pairs to load from the DB before filtering with {@link isBirthdayCelebratedToday}.
 * Narrows rows for Feb 29 on Feb 28 (non-leap) without scanning the whole table.
 */
export function getDbMatchPairsForToday(now: Date): ReadonlyArray<readonly [number, number]> {
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const year = now.getFullYear();

    const pairs = new Map<string, readonly [number, number]>();
    pairs.set(`${month},${day}`, [month, day]);
    if (month === 2 && day === 28 && !isLeapYear(year)) {
        pairs.set('2,29', [2, 29]);
    }
    return Array.from(pairs.values());
}
