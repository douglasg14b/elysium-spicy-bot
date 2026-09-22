import { describe, expect, it } from 'vitest';
import {
    draftFromType,
    emptyTicketTypeDraft,
    isTicketTypeDraftValid,
    validateTicketTypeDraft,
    type TicketTypeDraft,
} from '../ticketTypeForm';

/**
 * The client-side mirror of the template rule.
 *
 * The server is the authority and re-checks all of this. What these tests hold is the
 * property that makes a mirror worth having rather than dangerous: that it names the
 * **same token** the server names, and that it does not refuse something the server
 * would accept — a client stricter than the server leaves an operator unable to save a
 * legal type, with no message that explains why.
 */

function draft(overrides: Partial<TicketTypeDraft> = {}): TicketTypeDraft {
    return { ...emptyTicketTypeDraft(), type: 'appeals', label: 'Appeals', ...overrides };
}

describe('validateTicketTypeDraft template rules', () => {
    it('rejects {{user}} with the same token name the server uses', () => {
        // `S{{####}}-{{user}}-{{creator}}` was accepted, stored, shown to operators as the
        // channel template, and then silently dropped. Naming the token is the fix.
        const problems = validateTicketTypeDraft(draft({ nameTemplate: 'A{{####}}-{{user}}' }));

        expect(problems.nameTemplate).toContain('{{user}}');
    });

    it('rejects {{creator}}, the other half of the phantom template', () => {
        expect(validateTicketTypeDraft(draft({ nameTemplate: 'A{{####}}-{{creator}}' })).nameTemplate).toContain(
            '{{creator}}'
        );
    });

    it('accepts the three tokens the renderer implements', () => {
        expect(
            validateTicketTypeDraft(draft({ nameTemplate: 'A{{####}}-{{subject}}-{{opener}}' })).nameTemplate
        ).toBeUndefined();
    });

    it('accepts a repeated token, which the renderer substitutes everywhere', () => {
        // The server's renderer was fixed to replace every occurrence rather than the
        // first; refusing this here would be the mirror being stricter than the authority.
        expect(
            validateTicketTypeDraft(draft({ nameTemplate: 'A{{####}}-{{subject}}-{{subject}}' })).nameTemplate
        ).toBeUndefined();
    });

    it('rejects a malformed token the brace scan cannot see', () => {
        // `{{subject}` has no closing pair, so the token regex never matches it. Discord
        // would strip the brace and leave a channel named after the word "subject".
        expect(validateTicketTypeDraft(draft({ nameTemplate: 'A{{####}}-{{subject}' })).nameTemplate).toContain(
            'braces'
        );
    });

    it('rejects a template whose worst case overflows a channel name', () => {
        expect(
            validateTicketTypeDraft(draft({ nameTemplate: `${'x'.repeat(50)}-{{subject}}-{{opener}}` }))
                .nameTemplate
        ).toContain('100');
    });

    it('measures the worst case at six digits, not four', () => {
        // `{{####}}` pads to four but does not cap, and the ticket counter is unbounded —
        // the same reason the server probes at 999999.
        const problems = validateTicketTypeDraft(
            draft({ nameTemplate: `${'x'.repeat(35)}-{{####}}-{{subject}}-{{opener}}` })
        );

        expect(problems.nameTemplate).toContain('100');
    });

    it('rejects a blank template', () => {
        expect(validateTicketTypeDraft(draft({ nameTemplate: '  ' })).nameTemplate).toBeTruthy();
    });
});

describe('validateTicketTypeDraft key and label rules', () => {
    it('rejects a blank key', () => {
        expect(validateTicketTypeDraft(draft({ type: '   ' })).type).toBeTruthy();
    });

    it('rejects a key a channel name or flow option could not carry', () => {
        // Same expression the server uses: the key reaches both.
        expect(validateTicketTypeDraft(draft({ type: 'Appeals & Bans' })).type).toBeTruthy();
        expect(validateTicketTypeDraft(draft({ type: 'Appeals' })).type).toBeTruthy();
    });

    it('accepts a key of lowercase letters, digits, dashes and underscores', () => {
        expect(validateTicketTypeDraft(draft({ type: 'mod_appeals-2' })).type).toBeUndefined();
    });

    it('rejects a blank label', () => {
        expect(validateTicketTypeDraft(draft({ label: '  ' })).label).toBeTruthy();
    });

    it('reports every bad field at once rather than one per submission', () => {
        const problems = validateTicketTypeDraft(
            draft({ type: 'Bad Key', label: '', nameTemplate: 'A{{user}}' })
        );

        // An operator fixing a template should not have to re-submit to discover the
        // label was also blank.
        expect(problems.type).toBeTruthy();
        expect(problems.label).toBeTruthy();
        expect(problems.nameTemplate).toBeTruthy();
    });
});

describe('isTicketTypeDraftValid', () => {
    it('passes a draft nothing local objects to', () => {
        expect(isTicketTypeDraftValid(draft())).toBe(true);
    });

    it('fails a draft with any problem', () => {
        expect(isTicketTypeDraftValid(draft({ nameTemplate: '{{user}}' }))).toBe(false);
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

    it('seeds a template that validates, so a fresh form is not born broken', () => {
        expect(
            validateTicketTypeDraft({ ...emptyTicketTypeDraft(), type: 'x', label: 'X' }).nameTemplate
        ).toBeUndefined();
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
