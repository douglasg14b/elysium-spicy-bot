import { describe, expect, it } from 'vitest';
import { zSaveTicketTypeBody } from '../../../../packages/web-sdk/src/gen/zod.gen';
import { DEFAULT_TICKET_TYPES } from '../../../features/tickets/data/defaultTicketTypes';
import { buildTicketChannelName } from '../../../features/tickets/logic/ticketTypes';
import { SUPPORTED_TOKENS, TicketNameTemplateSchema } from '../../../features/tickets/logic/ticketTypeRules';

/**
 * The channel-name template rule, three ways, over one table of templates.
 *
 *  - **What the server used to accept.** Two hand checks in `upsertTicketType`: every
 *    `{{…}}` names a known token, and no brace survives a full render. Kept here as the
 *    reference, because the one pattern that replaced them claims to mean exactly that.
 *  - **The server's rule now**, `TicketNameTemplateSchema`.
 *  - **The browser's rule**, the committed SDK's generated zod — the pattern after it has
 *    been through the spec and hey-api, where a brace or a backslash could be mangled.
 *
 * The browser may under-report a refusal (the renderer's own checks stay server-only) but
 * must never refuse a template the server accepts; on the token rule they must agree.
 */

/** The token and brace checks `upsertTicketType` made before the rule was declared. */
function formerlyAccepted(template: string): boolean {
    if (!template) return false;

    const tokens = [...template.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1]);
    if (tokens.some((token) => !(SUPPORTED_TOKENS as readonly string[]).includes(token))) return false;

    const longest = buildTicketChannelName(
        { ...DEFAULT_TICKET_TYPES.support, nameTemplate: template },
        { ticketNumber: 999999, subjectName: 'a'.repeat(32), openerName: 'b'.repeat(32) }
    );
    return !/[{}]/.test(longest);
}

const ACCEPTED = [
    'S{{####}}-{{subject}}',
    'A{{####}}-{{subject}}-{{opener}}',
    'A{{####}}-{{subject}}-{{subject}}',
    '{{####}}',
    '{{opener}}',
    'plain-name',
    'a--b---c',
    '-{{opener}}-',
    '#####',
    'with spaces in it',
    'émoji-🔥-{{subject}}',
    'ünïcödé-名前',
    '$^.*+?()[]|\\',
];

const REFUSED = [
    '{{user}}',
    'S{{####}}-{{creator}}',
    '{{{subject}}}',
    '{{{{subject}}}}',
    '{{subject}',
    '{subject}}',
    '{{subject}}}',
    'A{{####}}}',
    '{{####}}{',
    '{}',
    '{',
    '}',
    '{{}}',
    '{{ subject }}',
    '{{SUBJECT}}',
    '{{#}}',
    '{{####',
    '{{opener}x}}',
    'a{b}c',
];

const browserTemplateRule = zSaveTicketTypeBody.shape.nameTemplate;

describe('the channel-name template rule', () => {
    it('the table means what it says under the former server checks', () => {
        // A sample in the wrong list would make the comparisons below agree for nothing.
        expect(ACCEPTED.filter((template) => !formerlyAccepted(template))).toEqual([]);
        expect(REFUSED.filter((template) => formerlyAccepted(template))).toEqual([]);
    });

    it.each([...ACCEPTED, ...REFUSED])('the server rule agrees with the former checks on %s', (template) => {
        expect(TicketNameTemplateSchema.safeParse(template).success).toBe(formerlyAccepted(template));
    });

    it.each([...ACCEPTED, ...REFUSED])(
        'the browser pattern never refuses what the server accepts and agrees with the server on refusals: %s',
        (template) => {
            const server = TicketNameTemplateSchema.safeParse(template);
            const browser = browserTemplateRule.safeParse(template);

            expect(browser.success).toBe(server.success);
            expect(browser.error?.issues[0]?.message).toBe(server.error?.issues[0]?.message);
        }
    );
});
