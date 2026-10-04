import { zSaveTicketTypeBody } from '@brattybot/web-sdk';
import { describe, expect, it } from 'vitest';
import { draftFromType, emptyTicketTypeDraft, ticketTypeRequest } from '../ticketTypeForm';

/**
 * The ticket-type editor's draft. Its rules are the server's, checked through the SDK's
 * zod (`fieldProblems.test.ts`, `ticketTemplateRuleParity.test.ts`); what is left here is
 * the draft itself and the request it becomes.
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
        const existing = {
            type: 'support',
            label: 'Support',
            nameTemplate: 'S{{####}}-{{subject}}',
            permissions: emptyTicketTypeDraft().permissions,
            autoClaimOnOpen: true,
        };

        expect(draftFromType(existing)).toEqual(existing);
    });
});
