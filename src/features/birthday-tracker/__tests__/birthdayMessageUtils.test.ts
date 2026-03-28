import { describe, expect, it } from 'vitest';
import { finalizeBirthdayAnnouncementBody, sanitizeBirthdayAnnouncementText } from '../birthdayMessageUtils';

describe('finalizeBirthdayAnnouncementBody', () => {
    it('neutralizes @everyone and @here', () => {
        const raw = 'Hey @everyone and @here party time';
        expect(finalizeBirthdayAnnouncementBody(raw)).toBe('Hey everyone and here party time');
    });

    it('removes Discord user, role, and channel mention tokens', () => {
        const raw = 'Ping <@123456789012345678> and <@!987654321098765432> role <@&111111111111111111> chan <#222222222222222222>';
        expect(finalizeBirthdayAnnouncementBody(raw)).toBe('Ping  and  role  chan');
    });

    it('caps length', () => {
        const long = 'word '.repeat(200);
        expect(finalizeBirthdayAnnouncementBody(long, 20).length).toBeLessThanOrEqual(20);
    });
});

describe('sanitizeBirthdayAnnouncementText', () => {
    it('delegates to finalizeBirthdayAnnouncementBody', () => {
        expect(sanitizeBirthdayAnnouncementText('a')).toBe(finalizeBirthdayAnnouncementBody('a'));
    });
});
