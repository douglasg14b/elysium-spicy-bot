import { describe, expect, it } from 'vitest';
import { sanitizeBirthdayAnnouncementText } from '../birthdayMessageUtils';

describe('sanitizeBirthdayAnnouncementText', () => {
    it('neutralizes @everyone and @here', () => {
        const raw = 'Hey @everyone and @here party time';
        expect(sanitizeBirthdayAnnouncementText(raw)).toBe('Hey everyone and here party time');
    });

    it('caps length', () => {
        const long = 'word '.repeat(200);
        expect(sanitizeBirthdayAnnouncementText(long, 20).length).toBeLessThanOrEqual(20);
    });
});
