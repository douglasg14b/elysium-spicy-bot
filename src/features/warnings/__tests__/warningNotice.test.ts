import { describe, expect, it } from 'vitest';
import { warningNoticeNote } from '../logic/warningNotice';

describe('warningNoticeNote', () => {
    it('names the command and what was saved, and says nothing when the notice went out', () => {
        const surface = { command: 'warn-clear', saved: 'Release' };

        expect(warningNoticeNote('sent', surface)).toBeNull();
        expect(warningNoticeNote('unconfigured', surface)).toBe(
            'No mod channel is configured, so this stayed in /warn-clear. Set one with /warnings-config.'
        );
        expect(warningNoticeNote('skipped', surface)).toMatch(/^Release is saved, but I cannot reach/);
        expect(warningNoticeNote('failed', surface)).toBe('Release is saved, but posting to the mod channel blew up.');
    });
});
