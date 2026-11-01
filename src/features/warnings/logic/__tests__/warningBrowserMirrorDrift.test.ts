import { describe, expect, it } from 'vitest';
import {
    addCalendarMonths as browserAddCalendarMonths,
    pacificToday,
    WARNING_DEFAULT_DURATION_MONTHS as BROWSER_DEFAULT_DURATION_MONTHS,
    WARNING_TIME_ZONE as BROWSER_TIME_ZONE,
} from '../../../../../web/src/warnings/warningDates';
import { dateRefusalField, type WarningDateField } from '../../../../../web/src/warnings/warningPresentation';
import { WARNING_DEFAULT_DURATION_MONTHS, WARNING_TIMEZONE } from '../../constants';
import { addCalendarMonths, formatCalendarDate, getPacificCalendarDate, parseWarningDateInput, type WarningDateErrorKind } from '../warningDates';
import { editInputRefusalSentence, warningInputRefusalSentence } from '../warningRefusals';

/**
 * The warnings dashboard's two mirrors of this feature, held to it.
 *
 * - **Where a date refusal is shown.** The routes answer a date rule with a sentence only, and
 *   the dashboard places it under its field by how it opens (`dateRefusalField`). Every date
 *   sentence either surface can send is run through it here, so rewording one moves this test,
 *   not the refusal on screen from under its field into a toast.
 * - **The form's date defaults.** The issue form fills in today and six months on, and sends
 *   them; a browser that disagreed would issue warnings the server accepts with the wrong dates.
 */

/** Which field each date refusal belongs under. A `Record`, so a new kind is a compile error here. */
const FIELD_OF: Readonly<Record<WarningDateErrorKind, WarningDateField>> = {
    'invalid-issued': 'issuedOn',
    'issued-in-future': 'issuedOn',
    'invalid-expires': 'dropsOffOn',
    'expires-not-after-issued': 'dropsOffOn',
    'expires-already-passed': 'dropsOffOn',
};

describe('the dashboard placing a date refusal', () => {
    for (const [kind, field] of Object.entries(FIELD_OF) as [WarningDateErrorKind, WarningDateField][]) {
        it(`puts ${kind} under ${field}, on issue and on edit`, () => {
            expect(dateRefusalField(warningInputRefusalSentence(kind))).toBe(field);
            expect(dateRefusalField(editInputRefusalSentence(kind))).toBe(field);
        });
    }

    it('places neither of the other field refusals under a date', () => {
        expect(dateRefusalField(warningInputRefusalSentence('empty-rule'))).toBeNull();
        expect(dateRefusalField(warningInputRefusalSentence('empty-description'))).toBeNull();
    });
});

describe("the dashboard's date defaults", () => {
    it('use the same zone and the same default length', () => {
        expect(BROWSER_TIME_ZONE).toBe(WARNING_TIMEZONE);
        expect(BROWSER_DEFAULT_DURATION_MONTHS).toBe(WARNING_DEFAULT_DURATION_MONTHS);
    });

    it('agree on today, either side of the Pacific midnight', () => {
        for (const instant of ['2026-10-29T06:59:59Z', '2026-10-29T07:00:00Z', '2026-03-08T09:30:00Z', '2026-12-31T23:00:00Z']) {
            const now = new Date(instant);
            expect(pacificToday(now)).toBe(formatCalendarDate(getPacificCalendarDate(now)));
        }
    });

    it('agree on months later, month ends and leap Februaries included', () => {
        for (const date of ['2026-10-29', '2026-08-31', '2027-08-31', '2026-12-31', '2026-01-31', '2028-02-29']) {
            const parsed = parseWarningDateInput(date);
            if (!parsed || parsed === 'invalid') throw new Error(`${date} is not a date.`);
            for (const months of [1, 6, 12, -1]) {
                expect(browserAddCalendarMonths(date, months)).toBe(formatCalendarDate(addCalendarMonths(parsed, months)));
            }
        }
    });
});
