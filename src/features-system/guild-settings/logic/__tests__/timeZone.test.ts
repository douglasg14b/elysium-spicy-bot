import { describe, expect, it } from 'vitest';
import { storableTimeZone } from '../timeZone';

describe('storableTimeZone', () => {
    it('accepts an IANA zone as spelled', () => {
        expect(storableTimeZone('America/New_York')).toBe('America/New_York');
    });

    it('accepts UTC, which V8 leaves out of its own zone list', () => {
        expect(storableTimeZone('UTC')).toBe('UTC');
    });

    it('tidies a spelling that differs from the canonical name only in case', () => {
        expect(storableTimeZone('utc')).toBe('UTC');
        expect(storableTimeZone('america/new_york')).toBe('America/New_York');
    });

    it("keeps the operator's modern spelling rather than the runtime's legacy one", () => {
        // Node canonicalises these to `Asia/Calcutta` and `Europe/Kiev`. A server that
        // picked Kyiv must not be shown Kiev.
        expect(storableTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata');
        expect(storableTimeZone('Europe/Kyiv')).toBe('Europe/Kyiv');
    });

    it('trims what was sent', () => {
        expect(storableTimeZone('  Europe/London ')).toBe('Europe/London');
    });

    it('refuses a name Intl has never heard of', () => {
        expect(storableTimeZone('Mars/Olympus_Mons')).toBeNull();
        expect(storableTimeZone('')).toBeNull();
    });

    it('refuses a raw offset, which Intl accepts but is not a zone anyone picks', () => {
        expect(storableTimeZone('+05:00')).toBeNull();
    });
});
