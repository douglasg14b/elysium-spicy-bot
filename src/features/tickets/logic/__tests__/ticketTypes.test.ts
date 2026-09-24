import { describe, expect, it } from 'vitest';
import { DEFAULT_TICKET_TYPES } from '../../data/defaultTicketTypes';
import type { TicketingConfig, TicketTypeDefinition } from '../../data/ticketingSchema';
import { buildTicketChannelName, getTicketTypeDefinition } from '../ticketTypes';

/**
 * The lookup and the renderer, which used to be one function reading a source
 * constant and are now two reading a guild's own config.
 */

function config(overrides: Partial<TicketingConfig> = {}): TicketingConfig {
    return {
        modTicketsDeployed: true,
        modTicketsDeployedChannelId: 'channel-1',
        modTicketsDeployedMessageId: 'message-1',
        supportTicketCategoryName: 'Support',
        claimedTicketCategoryName: 'Claimed',
        closedTicketCategoryName: 'Closed',
        moderationRoles: ['role-1'],
        ticketTypes: { ...DEFAULT_TICKET_TYPES },
        ...overrides,
    };
}

function definition(nameTemplate: string): TicketTypeDefinition {
    return {
        type: 'custom',
        label: 'Custom',
        nameTemplate,
        permissions: DEFAULT_TICKET_TYPES.support.permissions,
        autoClaimOnOpen: false,
    };
}

describe('getTicketTypeDefinition', () => {
    it('returns undefined for a type the guild has not declared', () => {
        // The whole point of the optional return: absence is nameable rather than a
        // crash or a substituted default, and it is what a hand-edited config blob or
        // a row typed before a type was removed produces.
        expect(getTicketTypeDefinition(config(), 'appeals')).toBeUndefined();
    });

    it('returns undefined when the guild has no ticketTypes member at all', () => {
        // A row written before the seed migration. `config` is a JSON blob with no
        // schema behind it, so this shape can genuinely arrive.
        expect(getTicketTypeDefinition(config({ ticketTypes: undefined }), 'support')).toBeUndefined();
    });

    it('returns the guild’s own declaration, not a source constant', () => {
        const mine = definition('X{{####}}');
        const found = getTicketTypeDefinition(config({ ticketTypes: { custom: mine } }), 'custom');

        expect(found).toEqual(mine);
    });
});

describe('buildTicketChannelName', () => {
    it('pads the number to four digits and lowercases the substituted names', () => {
        // Only the *names* are lowercased — the template's own literals are left as
        // the operator typed them, and Discord lowercases the channel name its end.
        expect(
            buildTicketChannelName(DEFAULT_TICKET_TYPES.support, {
                ticketNumber: 43,
                subjectName: 'SomeUser',
                openerName: 'ModPerson',
            })
        ).toBe('S0043-someuser-modperson');
    });

    it('strips characters Discord would not accept in a channel name', () => {
        expect(
            buildTicketChannelName(DEFAULT_TICKET_TYPES.verification, {
                ticketNumber: 7,
                subjectName: 'kitten.brat_99',
                openerName: null,
            })
        ).toBe('V0007-kittenbrat99');
    });

    it('collapses the separator rather than leaving a trailing hyphen when there is no opener', () => {
        // A flow-opened ticket has no human opener. The template still names
        // `{{opener}}`, so without the collapse the channel is `S0043-subject-`.
        expect(
            buildTicketChannelName(DEFAULT_TICKET_TYPES.support, {
                ticketNumber: 43,
                subjectName: 'someuser',
                openerName: null,
            })
        ).toBe('S0043-someuser');
    });

    it('substitutes every occurrence of a repeated token, not just the first', () => {
        // `String.prototype.replace` with a string needle replaces only the first match,
        // so this used to render `S0001-alice-{{subject}}` — and Discord strips braces, so
        // the operator silently got a channel ending in `-subject`. Templates are
        // operator-authored free text now, so it was reachable through the supported path.
        expect(
            buildTicketChannelName(definition('S{{####}}-{{subject}}-{{subject}}'), {
                ticketNumber: 1,
                subjectName: 'Alice',
                openerName: null,
            })
        ).toBe('S0001-alice-alice');
    });

    it('does not pad a ticket number past four digits — the width is a minimum, not a cap', () => {
        // Which is why the save-time length check probes six digits rather than 9999.
        expect(
            buildTicketChannelName(definition('T{{####}}'), {
                ticketNumber: 123456,
                subjectName: 'alice',
                openerName: null,
            })
        ).toBe('T123456');
    });

    it('renders a template that names no tokens at all verbatim', () => {
        expect(
            buildTicketChannelName(definition('appeals'), {
                ticketNumber: 1,
                subjectName: 'someuser',
                openerName: 'mod',
            })
        ).toBe('appeals');
    });
});
