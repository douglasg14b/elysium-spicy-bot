import { zSaveTicketTypeBody } from '@brattybot/web-sdk';
import { describe, expect, it } from 'vitest';
import {
    draftFromType,
    emptyTicketTypeDraft,
    ticketTypeRequest,
    validateTicketTypeDraft,
    type TicketTypeDraft,
} from '../ticketTypeForm';

/**
 * The ticket-type editor's draft: the request it becomes, and `validateTicketTypeDraft`,
 * the one browser path to its rules. The rules themselves are the server's, held to the
 * SDK's zod elsewhere (`fieldProblems.test.ts`, `ticketTemplateRuleParity.test.ts`).
 */

describe('ticketTypeRequest', () => {
    it('trims the key, label and template, as the server does before its rules see them', () => {
        const request = ticketTypeRequest({
            ...emptyTicketTypeDraft(),
            type: '  appeals ',
            label: ' Appeals  ',
            nameTemplate: '  A{{####}}  ',
        });

        expect(request.type).toBe('appeals');
        expect(request.body.label).toBe('Appeals');
        expect(request.body.nameTemplate).toBe('A{{####}}');
    });

    it('turns a blank label into the empty one the server refuses', () => {
        // The browser's zod has no trim, so `"   "` would pass it unless checked as sent.
        const request = ticketTypeRequest({ ...emptyTicketTypeDraft(), type: 'x', label: '   ' });

        expect(zSaveTicketTypeBody.safeParse(request.body).success).toBe(false);
    });
});

/** A draft the server's declared rules accept, with what a case changes. */
function draft(overrides: Partial<TicketTypeDraft> = {}): TicketTypeDraft {
    return { ...emptyTicketTypeDraft(), type: 'appeals', label: 'Appeals', ...overrides };
}

/*
 * The SDK's generated zod, through `validateTicketTypeDraft` — the one place both the
 * tickets editor and a journey's declared ticket type ask. The sentences are the server's.
 */
describe('validateTicketTypeDraft', () => {
    it('passes a draft the server would take', () => {
        expect(validateTicketTypeDraft(draft())).toEqual({});
    });

    it('rejects a blank key, label or template, measured after trimming', () => {
        const problems = validateTicketTypeDraft(draft({ type: '   ', label: '  ', nameTemplate: '  ' }));

        expect(problems.type).toBe('A ticket type needs a key. Blank is not a category of anything.');
        expect(problems.label).toBe('Give the type a label — operators have to pick it out of a list.');
        expect(problems.nameTemplate).toBe(
            'A channel-name template cannot be empty. Discord insists on calling channels something.'
        );
    });

    it('rejects a key a channel name or flow option could not carry, and accepts one it could', () => {
        expect(validateTicketTypeDraft(draft({ type: 'Appeals & Bans' })).type).toContain('lowercase letters');
        expect(validateTicketTypeDraft(draft({ type: 'mod_appeals-2' })).type).toBeUndefined();
    });

    it('rejects a key over 64 characters and accepts one of exactly 64, as the server does', () => {
        expect(validateTicketTypeDraft(draft({ type: 'a'.repeat(65) })).type).toContain('64 characters');
        expect(validateTicketTypeDraft(draft({ type: 'a'.repeat(64) })).type).toBeUndefined();
    });

    it('rejects a label over 45 characters, measured after trimming, as the server does', () => {
        expect(validateTicketTypeDraft(draft({ label: 'A'.repeat(46) })).label).toContain('45 characters');
        expect(validateTicketTypeDraft(draft({ label: `  ${'A'.repeat(45)}  ` })).label).toBeUndefined();
    });

    it('reports every bad field at once rather than one per submission', () => {
        const problems = validateTicketTypeDraft(draft({ type: 'Bad Key', label: '', nameTemplate: 'A{{user}}' }));

        // An operator fixing a template should not have to re-submit to discover the
        // label was also blank.
        expect(problems.type).toBeTruthy();
        expect(problems.label).toBeTruthy();
        expect(problems.nameTemplate).toBeTruthy();
    });
});

describe('emptyTicketTypeDraft', () => {
    it('seeds a permission model somebody can actually read the channel under', () => {
        const fresh = emptyTicketTypeDraft();

        // All-false would produce a type whose tickets nobody can see, which is not what
        // an operator opening a blank form has asked for.
        expect(fresh.permissions.subject.view).toBe(true);
        expect(fresh.permissions.staff.manageMessages).toBe(true);
    });

    it('seeds a template the server’s rules accept, so a fresh form is not born broken', () => {
        const request = ticketTypeRequest({ ...emptyTicketTypeDraft(), type: 'x', label: 'X' });

        expect(zSaveTicketTypeBody.safeParse(request.body).success).toBe(true);
    });
});

describe('draftFromType', () => {
    it('round-trips an existing type without altering it', () => {
        const settings = {
            type: 'support',
            label: 'Support',
            nameTemplate: 'S{{####}}-{{subject}}',
            permissions: emptyTicketTypeDraft().permissions,
            autoClaimOnOpen: true,
        };

        // Its categories are the dialog's, held beside the draft: a journey's type has none.
        expect(draftFromType({ ...settings, categories: { open: null, claimed: null, closed: null } })).toEqual(settings);
    });
});
