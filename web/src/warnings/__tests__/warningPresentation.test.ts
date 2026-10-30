import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_WARNING_FILTER } from '../warningFilters';
import {
    dateRefusalField,
    emptyListCopy,
    formatWarningDay,
    noticeProblem,
    warningIsOpen,
    warningPersonLabel,
    warningWriteDone,
} from '../warningPresentation';

/*
 * Every server date sentence is run through `dateRefusalField` by the root drift test
 * (`src/features/warnings/logic/__tests__/warningBrowserMirrorDrift.test.ts`), against the
 * server's own functions rather than a copy here.
 */
describe('dateRefusalField', () => {
    it('leaves refusals about anything but a date to a notification', () => {
        expect(dateRefusalField('Nothing changed. Edit something or leave it be.')).toBeNull();
        expect(dateRefusalField("They're not in this server. Warnings are for members, not ghosts.")).toBeNull();
        expect(dateRefusalField('Rule cannot be empty. Name the line they crossed.')).toBeNull();
    });
});

describe('warningPersonLabel', () => {
    it('is the recorded name, or the id for a warning written before names were', () => {
        expect(warningPersonLabel({ id: '400000000000000004', name: 'Kitten' })).toBe('Kitten');
        expect(warningPersonLabel({ id: '400000000000000004', name: null })).toBe('400000000000000004');
        expect(warningPersonLabel({ id: '400000000000000004', name: '' })).toBe('400000000000000004');
    });
});

describe('formatWarningDay', () => {
    it('prints the calendar day sent, in a browser west of Greenwich too', () => {
        // Los Angeles, where a date read as UTC midnight is the evening before. Node re-reads
        // `TZ` when it is assigned, so the next date formatted uses it.
        vi.stubEnv('TZ', 'America/Los_Angeles');
        try {
            const printed = formatWarningDay('2026-10-29');

            expect(printed).toContain('29');
            expect(printed).toContain('2026');
            expect(printed).not.toContain('28');
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('is an em dash for anything that is not a date', () => {
        expect(formatWarningDay('soon')).toBe('—');
    });
});

describe('warningIsOpen', () => {
    it('is false only for a released warning', () => {
        expect(warningIsOpen({ status: 'active' })).toBe(true);
        expect(warningIsOpen({ status: 'expired' })).toBe(true);
        expect(warningIsOpen({ status: 'released' })).toBe(false);
    });
});

describe('warningWriteDone', () => {
    it('names the slug for every write', () => {
        for (const write of ['issue', 'edit', 'release'] as const) {
            expect(warningWriteDone(write, 'rope-burn-42')).toContain('rope-burn-42');
        }
    });
});

describe('noticeProblem', () => {
    it('says nothing when the notice went out', () => {
        expect(noticeProblem('sent')).toBeNull();
    });

    it('says something different for each way it did not', () => {
        const said = (['unconfigured', 'skipped', 'failed'] as const).map((notice) => noticeProblem(notice)?.message);

        expect(said.every(Boolean)).toBe(true);
        expect(new Set(said).size).toBe(3);
        expect(noticeProblem('unconfigured')?.message).toContain('Warning settings');
    });
});

describe('emptyListCopy', () => {
    const none = { active: 0, expired: 0, released: 0 };

    it('offers to clear a member or a search that hides warnings', () => {
        expect(emptyListCopy({ ...DEFAULT_WARNING_FILTER, search: 'brat' }, none)).toMatchObject({
            title: 'Nothing matches that',
            action: 'clear',
        });
        expect(emptyListCopy({ ...DEFAULT_WARNING_FILTER, member: { id: '1', name: 'x' } }, none).action).toBe('clear');
    });

    it('says a server has none at all whatever status is picked, All included', () => {
        for (const status of ['active', 'expired', 'released', 'all'] as const) {
            expect(emptyListCopy({ ...DEFAULT_WARNING_FILTER, status }, none).title).toBe('No warnings yet');
        }
    });

    it('says a server with warnings has none of the status picked, not that a filter hid them', () => {
        const some = { ...none, active: 3 };

        expect(emptyListCopy(DEFAULT_WARNING_FILTER, { ...none, expired: 2 }).title).toBe("Nobody's on thin ice");
        expect(emptyListCopy({ ...DEFAULT_WARNING_FILTER, status: 'expired' }, some).title).toBe('Nothing has aged out yet');
        expect(emptyListCopy({ ...DEFAULT_WARNING_FILTER, status: 'released' }, some)).toMatchObject({
            title: "Nobody's been let off the hook",
            action: 'issue',
        });
    });
});
