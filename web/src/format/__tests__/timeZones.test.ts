import { describe, expect, it } from 'vitest';
import {
    browserTimeZoneSpelling,
    timeZoneGenericName,
    timeZoneLabelMatches,
    timeZoneOffsetLabel,
    timeZoneOptions,
} from '../timeZones';

// Mid-July: New York is on daylight time, so its offset is −4, not −5.
const SUMMER = new Date('2026-07-15T12:00:00Z');

describe('timeZoneOffsetLabel', () => {
    it('spells a negative offset with a true minus sign', () => {
        expect(timeZoneOffsetLabel('America/New_York', SUMMER)).toBe('UTC−04:00');
    });

    it('spells a positive offset, half hours included', () => {
        expect(timeZoneOffsetLabel('Asia/Kolkata', SUMMER)).toBe('UTC+05:30');
    });

    it('spells zero out rather than leaving a bare UTC', () => {
        expect(timeZoneOffsetLabel('UTC', SUMMER)).toBe('UTC+00:00');
    });
});

describe('timeZoneGenericName', () => {
    it("names the bot's default zone the way people say it", () => {
        expect(timeZoneGenericName('America/Los_Angeles', SUMMER)).toBe('Pacific Time');
    });
});

describe('timeZoneOptions', () => {
    it('offers UTC, which the runtime leaves out of its own list', () => {
        expect(timeZoneOptions(null, SUMMER).map((option) => option.value)).toContain('UTC');
    });

    it('labels each zone with its current offset', () => {
        const newYork = timeZoneOptions(null, SUMMER).find((option) => option.value === 'America/New_York');
        expect(newYork?.label).toBe('America/New_York (UTC−04:00)');
    });

    it("offers a saved zone this browser's list does not hold, once", () => {
        // A backward-compatibility link: `Intl` accepts it, but no runtime lists it.
        const values = timeZoneOptions('US/Eastern', SUMMER).map((option) => option.value);
        expect(values.filter((value) => value === 'US/Eastern')).toHaveLength(1);
    });

    it("labels a saved zone this browser's tz data does not know, rather than crashing", () => {
        // A zone newer than the browser: valid on the server, a RangeError here.
        const unknown = timeZoneOptions('Not/AZone', SUMMER).find((option) => option.value === 'Not/AZone');
        expect(unknown?.label).toBe('Not/AZone (offset unknown in this browser)');
    });
});

describe('browserTimeZoneSpelling', () => {
    it('keeps a zone this browser lists as it is', () => {
        expect(browserTimeZoneSpelling('America/New_York')).toBe('America/New_York');
        expect(browserTimeZoneSpelling('UTC')).toBe('UTC');
    });

    it("maps another browser's spelling onto this one's equivalent", () => {
        const listed = Intl.supportedValuesOf('timeZone');
        const spelled = browserTimeZoneSpelling(listed.includes('Asia/Kolkata') ? 'Asia/Calcutta' : 'Asia/Kolkata');
        expect(listed).toContain(spelled);
    });

    it('leaves a zone this browser cannot resolve as saved', () => {
        expect(browserTimeZoneSpelling('Not/AZone')).toBe('Not/AZone');
    });
});

describe('timeZoneLabelMatches', () => {
    const label = 'America/New_York (UTC−04:00)';

    it('finds a zone typed with spaces for underscores, in any case', () => {
        expect(timeZoneLabelMatches(label, 'new york')).toBe(true);
        expect(timeZoneLabelMatches(label, 'NEW_YORK')).toBe(true);
    });

    it('finds an offset typed with a plain hyphen', () => {
        expect(timeZoneLabelMatches(label, 'utc-04')).toBe(true);
    });

    it('does not find what is not there', () => {
        expect(timeZoneLabelMatches(label, 'london')).toBe(false);
    });
});
