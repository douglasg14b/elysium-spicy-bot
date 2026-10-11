import { describe, expect, it } from 'vitest';
import { resourceSchema } from '../journeyRoutes';

/**
 * A declared ticket type through the journey save schema.
 *
 * The content rules are the ticket feature's own (`ticketTypeDefinitionProblem`), so a
 * journey cannot store a type that install's create-if-absent would then refuse — and the
 * permission grid is the ticket route's schema, not a third copy.
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

describe('a declared ticket type on save', () => {
    it('is stored with its label exactly as written — a label is not a channel name', () => {
        const parsed = resourceSchema.parse(ticketType());

        expect(parsed.defaultName).toBe('Verify Me');
        expect(parsed.ticketType?.nameTemplate).toBe('verify-{{####}}');
    });

    it('refuses a template token the renderer does not know, in the ticket feature’s words', () => {
        const result = resourceSchema.safeParse(ticketType({}, { nameTemplate: 'verify-{{user}}' }));

        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.message).toContain('{{user}}');
    });

    it('refuses a label past the 45 characters the mod ticket picker shows', () => {
        const result = resourceSchema.safeParse(ticketType({ defaultName: 'x'.repeat(46) }));

        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.message).toMatch(/45 characters/);
    });

    it('refuses a permission grid with a role missing', () => {
        const result = resourceSchema.safeParse(
            ticketType({}, { permissions: { subject: PERMISSIONS.subject, opener: PERMISSIONS.opener } })
        );

        expect(result.success).toBe(false);
    });
});
