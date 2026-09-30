import { describe, expect, it } from 'vitest';
import {
    builderStatusLine,
    draftLabel,
    draftOnlySaveMessage,
    formatWhen,
    orderDraftsForPicker,
    shouldAutosaveDraft,
    shouldFlushDraft,
} from '../flowDraftAutosave';

/** A local-time instant, so these read the same in every timezone the suite runs in. */
const at = (day: number, hours: number, minutes: number): Date => new Date(2026, 8, day, hours, minutes);
const NOW = at(29, 12, 30);

describe('whether the canvas is written to the draft', () => {
    it('waits until a load has set what the canvas started as', () => {
        // The window a load is still landing in: nothing to compare against, so a
        // flow arriving on the canvas cannot be mistaken for an edit of it.
        expect(shouldAutosaveDraft({ current: 'edited', baseline: undefined, lastSent: undefined, paused: false })).toBe(
            false
        );
    });

    it('writes a canvas that has moved on from what was loaded', () => {
        expect(shouldAutosaveDraft({ current: 'edited', baseline: 'loaded', lastSent: undefined, paused: false })).toBe(true);
    });

    it('does not write a canvas back where it was loaded, or one already sent', () => {
        expect(shouldAutosaveDraft({ current: 'loaded', baseline: 'loaded', lastSent: undefined, paused: false })).toBe(
            false
        );
        expect(shouldAutosaveDraft({ current: 'edited', baseline: 'loaded', lastSent: 'edited', paused: false })).toBe(
            false
        );
    });

    it('holds while a flow save is in flight', () => {
        expect(shouldAutosaveDraft({ current: 'edited', baseline: 'loaded', lastSent: undefined, paused: true })).toBe(false);
    });

    it('does not claim a loaded draft as mine until it is edited', () => {
        // Picking @alice's draft makes her graph the baseline. Only an edit of it is mine.
        const alices = '{"graph":"alice"}';
        expect(shouldAutosaveDraft({ current: alices, baseline: alices, lastSent: undefined, paused: false })).toBe(false);
        expect(shouldAutosaveDraft({ current: '{"graph":"mine"}', baseline: alices, lastSent: undefined, paused: false })).toBe(
            true
        );
    });
});

describe('whether "keep as draft" has to write', () => {
    it('writes what the draft does not hold yet', () => {
        expect(shouldFlushDraft({ current: 'edited', baseline: 'loaded', lastSent: undefined })).toBe(true);
        expect(shouldFlushDraft({ current: 'edited again', baseline: 'loaded', lastSent: 'edited' })).toBe(true);
    });

    it('does not write what was already sent', () => {
        expect(shouldFlushDraft({ current: 'edited', baseline: 'loaded', lastSent: 'edited' })).toBe(false);
    });

    it('writes a canvas undone back to where it was loaded, over the edit the draft still holds', () => {
        expect(shouldFlushDraft({ current: 'loaded', baseline: 'loaded', lastSent: 'edited' })).toBe(true);
    });

    it('does not claim a loaded draft as mine when nothing was written from here', () => {
        const alices = '{"graph":"alice"}';
        expect(shouldFlushDraft({ current: alices, baseline: alices, lastSent: undefined })).toBe(false);
    });
});

describe('the status line', () => {
    it('says when the draft was last kept while there are unsaved changes', () => {
        expect(
            builderStatusLine(
                { dirty: true, draft: { kind: 'saved', at: at(29, 12, 4).toISOString() }, savedAsDraftOnly: false },
                NOW
            )
        ).toEqual({ text: 'Unsaved changes · draft saved 12:04', tone: 'dirty' });
    });

    it('owns up to a draft that did not save', () => {
        expect(builderStatusLine({ dirty: true, draft: { kind: 'failed' }, savedAsDraftOnly: false }, NOW)).toEqual({
            text: 'Unsaved changes · draft not saved',
            tone: 'attention',
        });
    });

    it('says a draft-only save left the live flow alone, until the next edit', () => {
        const saved = { kind: 'saved', at: NOW.toISOString() } as const;
        expect(builderStatusLine({ dirty: false, draft: saved, savedAsDraftOnly: true }, NOW).text).toBe(
            'Draft saved — live flow unchanged'
        );
        expect(builderStatusLine({ dirty: true, draft: saved, savedAsDraftOnly: true }, NOW).text).toMatch(/^Unsaved changes/);
    });

    it('is plain when everything is saved to the flow', () => {
        expect(builderStatusLine({ dirty: false, draft: { kind: 'idle' }, savedAsDraftOnly: false }, NOW)).toEqual({
            text: 'All changes saved',
            tone: 'clean',
        });
    });
});

describe('the picker', () => {
    it('names the operator’s own draft, and everyone else’s by their handle', () => {
        expect(draftLabel({ mine: true, authorName: 'douglas' })).toBe('Your draft');
        expect(draftLabel({ mine: false, authorName: 'alice' })).toBe("@alice's draft");
    });

    it('puts the operator’s own draft first and keeps the rest in the order sent', () => {
        const drafts = [
            { mine: false, authorName: 'alice' },
            { mine: true, authorName: 'douglas' },
            { mine: false, authorName: 'bob' },
        ];
        expect(orderDraftsForPicker(drafts).map((draft) => draft.authorName)).toEqual(['douglas', 'alice', 'bob']);
    });

    it('gives a time for today and a date for anything older', () => {
        expect(formatWhen(at(29, 9, 5).toISOString(), NOW)).toBe('09:05');
        expect(formatWhen(at(27, 18, 40).toISOString(), NOW)).toBe('27 Sep, 18:40');
    });
});

describe('a save that landed on the draft only', () => {
    it('counts what is keeping the live flow on the old version', () => {
        expect(draftOnlySaveMessage(1, [])).toBe(
            'Saved as a draft only — the live flow keeps running the last working version until this problem is fixed.'
        );
        expect(draftOnlySaveMessage(3, [])).toMatch(/until these 3 problems are fixed\.$/);
    });

    it('names the resources still to install, alone or beside the problems', () => {
        expect(draftOnlySaveMessage(0, ['qa-channel'])).toMatch(/until "qa-channel" is installed\.$/);
        expect(draftOnlySaveMessage(2, ['qa-channel', 'vip-role'])).toMatch(
            /until these 2 problems are fixed and "qa-channel", "vip-role" are installed\.$/
        );
    });
});
