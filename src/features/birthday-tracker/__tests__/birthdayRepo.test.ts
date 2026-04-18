import { describe, expect, it } from 'vitest';
import { isWithinBirthdayAnnouncementWindow } from '../data/birthdayRepo';

describe('isWithinBirthdayAnnouncementWindow', () => {
    it('allows the Pacific morning start hour', () => {
        expect(isWithinBirthdayAnnouncementWindow(new Date('2026-04-17T14:00:00.000Z'))).toBe(true);
    });

    it('allows the Pacific evening cutoff minus one minute', () => {
        expect(isWithinBirthdayAnnouncementWindow(new Date('2026-04-18T04:59:00.000Z'))).toBe(true);
    });

    it('blocks before 7 a.m. Pacific', () => {
        expect(isWithinBirthdayAnnouncementWindow(new Date('2026-04-17T13:59:59.000Z'))).toBe(false);
    });

    it('blocks at 10 p.m. Pacific', () => {
        expect(isWithinBirthdayAnnouncementWindow(new Date('2026-04-18T05:00:00.000Z'))).toBe(false);
    });
});
