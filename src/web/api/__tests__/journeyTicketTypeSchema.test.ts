import { describe, expect, it } from 'vitest';
import { TICKET_TYPE_LABEL_TOO_LONG_MESSAGE } from '../../../features/tickets/logic/ticketTypeRules';
import { declarationsRefusal, ResourceDeclarationSchema } from '../journeyBody';

/**
 * A declared ticket type through the journey save: the request schema, then the refusals the
 * routes ask straight after it (`declarationsRefusal`), as the three resource routes do.
 *
 * The content rules are the ticket feature's own (`ticketTypeDefinitionProblem`), so a
 * journey cannot store a type that install's create-if-absent would then refuse — and the
 * settings are the ticket route's schema (`TicketTypeSettings`), not a third copy. The
 * template's token rule travels in that schema, so it refuses first; the label's cap spans
 * `kind` and `defaultName`, so it is the handler's.
 */

const PERMISSIONS = {
    subject: { view: true, send: true, readHistory: true, manageMessages: false },
    opener: { view: true, send: true, readHistory: true, manageMessages: false },
    staff: { view: true, send: true, readHistory: true, manageMessages: true },
};

function ticketType(overrides: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) {
    return {
        key: 'verify',
        kind: 'ticketType',
        defaultName: 'Verify Me',
        ticketType: { nameTemplate: 'verify-{{####}}', permissions: PERMISSIONS, autoClaimOnOpen: false, ...settings },
        ...overrides,
    };
}

/** The first thing the save would refuse, as the route answers it: the schema's sentence, then the handler's. */
function saveRefusal(resource: Record<string, unknown>): string | undefined {
    const parsed = ResourceDeclarationSchema.safeParse(resource);
    if (!parsed.success) return parsed.error.issues[0]?.message;
    return declarationsRefusal([parsed.data]);
}

describe('a declared ticket type on save', () => {
    it('is stored with its label exactly as written — a label is not a channel name', () => {
        const parsed = ResourceDeclarationSchema.parse(ticketType());

        expect(parsed.defaultName).toBe('Verify Me');
        expect(parsed.ticketType?.nameTemplate).toBe('verify-{{####}}');
        expect(declarationsRefusal([parsed])).toBeUndefined();
    });

    it('trims the label, as the ticket feature trims it on create', () => {
        expect(ResourceDeclarationSchema.parse(ticketType({ defaultName: '  Verify Me  ' })).defaultName).toBe('Verify Me');
    });

    it('refuses a template token the renderer does not know, in the ticket feature’s words', () => {
        expect(saveRefusal(ticketType({}, { nameTemplate: 'verify-{{user}}' }))).toMatch(
            /^Only `\{\{####\}\}`, `\{\{subject\}\}` and `\{\{opener\}\}` render here/
        );
    });

    it('refuses a label past the 45 characters the mod ticket picker shows', () => {
        expect(saveRefusal(ticketType({ defaultName: 'x'.repeat(46) }))).toBe(TICKET_TYPE_LABEL_TOO_LONG_MESSAGE);
        expect(saveRefusal(ticketType({ defaultName: 'x'.repeat(45) }))).toBeUndefined();
    });

    it('refuses a template too long to render as a channel name, which only the server can measure', () => {
        expect(saveRefusal(ticketType({}, { nameTemplate: `${'x'.repeat(95)}-{{####}}` }))).toMatch(
            /Discord caps a channel name at 100/
        );
    });

    it('refuses a permission grid with a role missing', () => {
        const result = ResourceDeclarationSchema.safeParse(
            ticketType({}, { permissions: { subject: PERMISSIONS.subject, opener: PERMISSIONS.opener } })
        );

        expect(result.success).toBe(false);
    });

    it('leaves a channel named over 45 characters alone — the cap is a ticket type label’s', () => {
        expect(saveRefusal({ key: 'lounge', kind: 'textChannel', defaultName: 'x'.repeat(60) })).toBeUndefined();
    });
});
