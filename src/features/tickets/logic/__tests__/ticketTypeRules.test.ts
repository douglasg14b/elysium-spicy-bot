import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { DEFAULT_TICKET_TYPES } from '../../data/defaultTicketTypes';
import { buildTicketChannelName } from '../ticketTypes';
import {
    SUPPORTED_TOKENS,
    TICKET_TYPE_KEY_MAX_LENGTH,
    TicketNameTemplateSchema,
    TicketTypeKeySchema,
    TicketTypeLabelSchema,
} from '../ticketTypeRules';

/**
 * A ticket type's declared rules, and the sentences that travel with them.
 *
 * The sentences are asserted word for word: they reach the operator twice — from the
 * server's refusal, and from the dashboard's generated zod before they press Save — so a
 * change here is a change to what both say.
 */

const KEY_SENTENCE =
    'That will not do as a key — lowercase letters, digits, `-` and `_` only. The label is where you get to be expressive.';
const TOKEN_SENTENCE =
    'Only `{{####}}`, `{{subject}}` and `{{opener}}` render here, each with exactly two braces either side — nothing else, and no, wishing does not count.';

/** The first refusal, as the route's `defaultHook` would send it; `undefined` when accepted. */
function refusal(schema: z.ZodType, value: string): string | undefined {
    const result = schema.safeParse(value);
    return result.success ? undefined : result.error.issues[0]?.message;
}

describe('TicketTypeKeySchema', () => {
    it('refuses a blank key', () => {
        expect(refusal(TicketTypeKeySchema, '   ')).toBe('A ticket type needs a key. Blank is not a category of anything.');
    });

    it('refuses a key a channel name or a flow option cannot carry', () => {
        expect(refusal(TicketTypeKeySchema, 'Appeals & Bans')).toBe(KEY_SENTENCE);
        expect(refusal(TicketTypeKeySchema, 'Appeals')).toBe(KEY_SENTENCE);
    });

    it('accepts lowercase letters, digits, dashes and underscores', () => {
        expect(refusal(TicketTypeKeySchema, 'mod_appeals-2')).toBeUndefined();
    });

    it('refuses a key longer than the ticket list can filter on', () => {
        expect(refusal(TicketTypeKeySchema, 'a'.repeat(TICKET_TYPE_KEY_MAX_LENGTH))).toBeUndefined();
        expect(refusal(TicketTypeKeySchema, 'a'.repeat(TICKET_TYPE_KEY_MAX_LENGTH + 1))).toBe(
            'Keep the key to 64 characters or fewer. It is an identifier, not a confession.'
        );
    });

    it('trims a padded key, so the record and its map key agree', () => {
        // Validating the trimmed key and storing the untrimmed one would leave a type
        // visible in the config that every lookup misses.
        expect(TicketTypeKeySchema.parse('  appeals  ')).toBe('appeals');
    });
});

describe('TicketTypeLabelSchema', () => {
    it('refuses a blank label', () => {
        expect(refusal(TicketTypeLabelSchema, '  ')).toBe('Give the type a label — operators have to pick it out of a list.');
    });

    it('trims the label it keeps', () => {
        expect(TicketTypeLabelSchema.parse('  Appeals  ')).toBe('Appeals');
    });
});

describe('TicketNameTemplateSchema', () => {
    it('refuses a blank template', () => {
        expect(refusal(TicketNameTemplateSchema, '  ')).toBe(
            'A channel-name template cannot be empty. Discord insists on calling channels something.'
        );
    });

    it('refuses {{user}} and {{creator}}, the phantom template’s tokens', () => {
        // `S{{####}}-{{user}}-{{creator}}` named tokens nothing implemented and was
        // accepted, stored, shown to operators as the channel template, then silently dropped.
        expect(refusal(TicketNameTemplateSchema, 'S{{####}}-{{user}}')).toBe(TOKEN_SENTENCE);
        expect(refusal(TicketNameTemplateSchema, 'S{{####}}-{{creator}}')).toBe(TOKEN_SENTENCE);
    });

    it('refuses a token with one brace short', () => {
        // Discord would strip the brace and name the channel after the word "subject".
        expect(refusal(TicketNameTemplateSchema, 'A{{####}}-{{subject}')).toBe(TOKEN_SENTENCE);
    });

    it('accepts the three tokens the renderer implements, repeated or not', () => {
        expect(refusal(TicketNameTemplateSchema, 'A{{####}}-{{subject}}-{{opener}}')).toBeUndefined();
        expect(refusal(TicketNameTemplateSchema, 'A{{####}}-{{subject}}-{{subject}}')).toBeUndefined();
    });

    it('checks the trimmed template', () => {
        expect(TicketNameTemplateSchema.parse('  S{{####}}  ')).toBe('S{{####}}');
    });
});

describe('SUPPORTED_TOKENS', () => {
    /*
     * The renderer substitutes tokens by name and never reads the list, so nothing else
     * holds the two together. A token listed but not rendered would be accepted by the
     * rule above and reach Discord as literal braces — the phantom template, back.
     */
    it.each(SUPPORTED_TOKENS)('lists {{%s}}, which the renderer substitutes', (token) => {
        const rendered = buildTicketChannelName(
            { ...DEFAULT_TICKET_TYPES.support, nameTemplate: `x{{${token}}}` },
            { ticketNumber: 1, subjectName: 'subject', openerName: 'opener' }
        );

        expect(rendered).not.toMatch(/[{}]/);
    });
});
