import { describe, expect, it } from 'vitest';
import type { Warning } from '@brattybot/web-sdk';
import {
    draftFromWarning,
    editIsPristine,
    issueProblems,
    issueRequest,
    newWarningDraft,
    updateProblems,
    updateRequest,
    withDropsOffOn,
    withIssuedOn,
} from '../warningForm';

const WARNING: Warning = {
    slug: 'rope-burn-42',
    rule: 'No means no',
    description: 'Kept going after the safeword.',
    member: { id: '400000000000000004', name: 'Kitten' },
    issuedBy: { id: '500000000000000005', name: 'velvet_admin' },
    issuedOn: '2026-10-01',
    dropsOffOn: '2027-04-01',
    status: 'active',
    edited: null,
    released: null,
};

describe('a new warning', () => {
    it("is issued today on the Pacific calendar and drops off six months on", () => {
        const draft = newWarningDraft(new Date('2026-10-29T06:30:00Z'));

        expect(draft.issuedOn).toBe('2026-10-28');
        expect(draft.dropsOffOn).toBe('2027-04-28');
    });

    it('carries the drop-off along with a backdated issued day, until somebody picks a drop-off', () => {
        const draft = newWarningDraft(new Date('2026-10-29T12:00:00Z'));

        const backdated = withIssuedOn(draft, '2026-08-31');
        expect(backdated.dropsOffOn).toBe('2027-02-28');

        const picked = withIssuedOn(withDropsOffOn(backdated, '2027-01-01'), '2026-09-01');
        expect(picked.dropsOffOn).toBe('2027-01-01');
    });

    it('keeps the last drop-off while the issued day is half typed', () => {
        const draft = withIssuedOn(newWarningDraft(new Date('2026-10-29T12:00:00Z')), '2026-1');

        expect(draft.dropsOffOn).toBe('2027-04-29');
    });

    it("is refused, in the server's words, until a member is picked and a rule and description given", () => {
        const problems = issueProblems(newWarningDraft());

        expect(problems.userId).toBe('Pick a member to warn.');
        expect(problems.rule).toBe('Rule cannot be empty. Name the line they crossed.');
        expect(problems.description).toBe('Description cannot be empty. Tell the story.');
        expect(problems.issuedOn).toBeUndefined();
        expect(problems.dropsOffOn).toBeUndefined();
    });

    it('is checked as sent, trimmed — so a rule of spaces is refused', () => {
        const draft = { ...newWarningDraft(), memberId: WARNING.member.id, rule: '   ', description: ' Brat. ' };

        expect(issueProblems(draft).rule).toBe('Rule cannot be empty. Name the line they crossed.');
        expect(issueRequest(draft).description).toBe('Brat.');
    });

    it('sends a blank date as absent, so the route uses its default', () => {
        const draft = { ...newWarningDraft(), memberId: WARNING.member.id, rule: 'r', description: 'd', dropsOffOn: '  ' };

        expect(issueRequest(draft).dropsOffOn).toBeUndefined();
        expect(issueProblems(draft)).toEqual({});
    });

    it('refuses a date that is not YYYY-MM-DD', () => {
        const draft = { ...newWarningDraft(), memberId: WARNING.member.id, rule: 'r', description: 'd', dropsOffOn: '1/2/27' };

        expect(issueProblems(draft)).toEqual({ dropsOffOn: 'Drop-off date has to be YYYY-MM-DD.' });
    });
});

describe('an edit', () => {
    it('is pristine as loaded, and with nothing but trailing spaces added', () => {
        const draft = draftFromWarning(WARNING);

        expect(editIsPristine(draft, WARNING)).toBe(true);
        expect(editIsPristine({ ...draft, rule: `${WARNING.rule}  ` }, WARNING)).toBe(true);
        expect(editIsPristine({ ...draft, dropsOffOn: '2027-05-01' }, WARNING)).toBe(false);
    });

    it('sends the edit it was loaded from as its base, or null for a warning never edited', () => {
        const draft = draftFromWarning(WARNING);
        const edited = { ...WARNING, edited: { by: WARNING.issuedBy, at: '2026-10-20T10:00:00.000Z' } };

        expect(updateRequest(draft, WARNING).baseEditedAt).toBeNull();
        expect(updateRequest(draft, edited).baseEditedAt).toBe('2026-10-20T10:00:00.000Z');
        expect(updateProblems(draft, edited)).toEqual({});
    });

    it('does not move the drop-off when the issued day would', () => {
        expect(withIssuedOn(draftFromWarning(WARNING), '2026-09-01').dropsOffOn).toBe(WARNING.dropsOffOn);
    });
});
