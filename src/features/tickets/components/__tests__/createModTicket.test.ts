import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    APILabelComponent,
    APIStringSelectComponent,
    ButtonInteraction,
    ModalBuilder,
    ModalSubmitInteraction,
} from 'discord.js';
import { Collection, ComponentType, DiscordAPIError, ModalSubmitFields } from 'discord.js';
import { DEFAULT_TICKET_TYPES } from '../../data/defaultTicketTypes';
import type { TicketingConfig, TicketingConfigEntity, TicketTypeDefinition } from '../../data/ticketingSchema';

/**
 * The moderator's "Create Mod Ticket" button and modal, which used to open a
 * hardcoded `support` ticket. Seeded types are not special: the moderator picks from
 * whatever the guild declared, and a guild that never had `support` works the same.
 *
 * Unit-level rather than through TestDiscord: the harness delivers gateway events and
 * REST, not interactions, so it cannot show a modal or submit one with select values.
 */

const mockGet = vi.fn();
const mockOpenTicket = vi.fn();
const mockAttachTicketChannel = vi.fn();
const mockRecordTicketStateMessage = vi.fn();
const mockCreateTicketChannel = vi.fn();
const mockFetchUser = vi.fn();

vi.mock('../../../../discordClient', () => ({
    DISCORD_CLIENT: { users: { fetch: (...args: unknown[]) => mockFetchUser(...args) } },
}));

vi.mock('../../data/ticketingRepo', () => ({
    ticketingRepo: { get: (...args: unknown[]) => mockGet(...args) },
}));

vi.mock('../../ticketService', () => ({
    openTicket: (...args: unknown[]) => mockOpenTicket(...args),
    attachTicketChannel: (...args: unknown[]) => mockAttachTicketChannel(...args),
    recordTicketStateMessage: (...args: unknown[]) => mockRecordTicketStateMessage(...args),
}));

vi.mock('../../logic/ticketChannelOps', () => ({
    createTicketChannelForTicket: (...args: unknown[]) => mockCreateTicketChannel(...args),
}));

vi.mock('../../logic/resolveTicketIdentity', () => ({
    resolveTicketIdentity: vi.fn().mockResolvedValue({ username: 'someone', nickname: null }),
}));

vi.mock('../../logic/ticketPresentation', () => ({
    buildTicketEmbed: vi.fn().mockReturnValue({}),
    buildTicketButtons: vi.fn().mockReturnValue([]),
}));

import { CreateModTicketButtonComponent } from '../createModTicketButton';
import { CreateModTicketModalComponent } from '../createModTicketModal';

const GUILD_ID = 'guild-1';

function customType(type: string, label: string): TicketTypeDefinition {
    return {
        type,
        label,
        nameTemplate: `${type.charAt(0).toUpperCase()}{{####}}-{{subject}}`,
        permissions: DEFAULT_TICKET_TYPES.support.permissions,
        autoClaimOnOpen: false,
    };
}

/** A guild that deleted both seeded types and declared only its own. */
const APPEALS = customType('appeals', 'Appeals');
const REPORTS = customType('reports', 'Reports');

function configEntity(ticketTypes: Record<string, TicketTypeDefinition> | undefined): TicketingConfigEntity {
    const config: TicketingConfig = {
        modTicketsDeployed: true,
        modTicketsDeployedChannelId: 'channel-1',
        modTicketsDeployedMessageId: 'message-1',
        categories: {
            open: { name: 'Open', discordId: '100000000000000001', provenance: 'created' },
            claimed: { name: 'Claimed', discordId: '100000000000000002', provenance: 'created' },
            closed: { name: 'Closed', discordId: '100000000000000003', provenance: 'created' },
        },
        moderationRoles: ['role-mod'],
        ticketTypes,
    };
    return { id: 1, guildId: GUILD_ID, config, ticketNumberInc: 0, entityVersion: 1 } as TicketingConfigEntity;
}

/** The type picker inside a built modal, as Discord would receive it. */
function typeSelect(modal: ModalBuilder): APIStringSelectComponent {
    const label = modal
        .toJSON()
        .components.find(
            (component): component is APILabelComponent =>
                component.type === ComponentType.Label && component.label === 'Type',
        );
    if (label?.component.type !== ComponentType.StringSelect) {
        throw new Error('The mod ticket modal has no Type string select.');
    }
    return label.component;
}

function buttonInteraction(): ButtonInteraction & { showModal: ReturnType<typeof vi.fn> } {
    return {
        guild: { id: GUILD_ID },
        member: {
            roles: { cache: { has: (roleId: string) => roleId === 'role-mod' } },
            permissions: { has: () => false },
        },
        showModal: vi.fn().mockResolvedValue(undefined),
    } as unknown as ButtonInteraction & { showModal: ReturnType<typeof vi.fn> };
}

function submitInteraction(pickedType: string): ModalSubmitInteraction {
    return {
        guild: { id: GUILD_ID },
        user: { id: 'moderator-1', username: 'moderator' },
        fields: {
            getStringSelectValues: (id: string) => {
                if (id !== 'mod_ticket_type_input') throw new Error(`No string select ${id}`);
                return [pickedType];
            },
            getSelectedUsers: () => new Collection([['subject-1', { id: 'subject-1' }]]),
            getTextInputValue: (id: string) => (id === 'mod_ticket_title_input' ? 'A title' : ''),
        },
        reply: vi.fn().mockResolvedValue(undefined),
    } as unknown as ModalSubmitInteraction;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockFetchUser.mockResolvedValue({ id: 'subject-1', username: 'subject' });
    mockOpenTicket.mockResolvedValue({ ok: true, value: { id: 7 } });
    mockCreateTicketChannel.mockResolvedValue({
        ok: true,
        value: {
            id: 'ticket-channel-1',
            send: vi.fn().mockResolvedValue({ id: 'state-message-1', pin: vi.fn().mockResolvedValue(undefined) }),
        },
    });
    mockAttachTicketChannel.mockResolvedValue({ ok: true, value: { id: 7 } });
    mockRecordTicketStateMessage.mockResolvedValue({ ok: true, value: undefined });
});

describe('the mod ticket modal type picker', () => {
    it('offers each type by key and label, in the order given, required, one pick', () => {
        // The order is `listTicketTypes`'s, proven in `ticketTypes.test.ts` and through the
        // button below; the builder must not re-sort what it is handed.
        const select = typeSelect(CreateModTicketModalComponent().component([REPORTS, APPEALS]));

        expect(select.options.map((option) => [option.value, option.label])).toEqual([
            ['reports', 'Reports'],
            ['appeals', 'Appeals'],
        ]);
        expect(select.placeholder).toBe('Pick a ticket type');
        expect(select.required).toBe(true);
        expect(select.min_values).toBe(1);
        expect(select.max_values).toBe(1);
        // Two to choose from: nothing is chosen for the moderator.
        expect(select.options.some((option) => option.default)).toBe(false);
    });

    it('pre-selects the only type when the guild has exactly one', () => {
        const select = typeSelect(CreateModTicketModalComponent().component([APPEALS]));

        expect(select.options).toHaveLength(1);
        expect(select.options[0].default).toBe(true);
    });

    it('offers the first 25 past the Discord cap, says so, and names the rest in a warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const pad = (value: number): string => String(value).padStart(2, '0');
        const many = Array.from({ length: 27 }, (_unused, index) =>
            customType(`type-${pad(index)}`, `Type ${pad(index)}`),
        );

        const select = typeSelect(CreateModTicketModalComponent().component(many));

        expect(select.options).toHaveLength(25);
        expect(select.options[0].value).toBe('type-00');
        expect(select.options[24].value).toBe('type-24');
        expect(select.placeholder).toContain('25 of 27 shown');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('not offered: type-25, type-26'));
        warn.mockRestore();
    });

    it('cuts a label saved before the limit existed rather than throwing, keeping the key as the value', () => {
        // Saving now refuses past 45, but an older row can hold more. Discord allows 100, but
        // the builders' modal validation throws past 45; `typeSelect` serializes with toJSON,
        // as showModal does.
        const select = typeSelect(CreateModTicketModalComponent().component([customType('wordy', 'W'.repeat(60))]));

        expect(select.options[0].label).toHaveLength(45);
        expect(select.options[0].value).toBe('wordy');
    });

    it('does not split an emoji at the cut', () => {
        // The emoji's two UTF-16 halves straddle the 44th unit, where the cut lands.
        const select = typeSelect(
            CreateModTicketModalComponent().component([customType('spicy', `${'W'.repeat(43)}🌶️ and more`)]),
        );

        expect(select.options[0].label).toBe(`${'W'.repeat(43)}…`);
    });
});

describe('the Create Mod Ticket button', () => {
    it("shows a modal offering a custom-only guild's own types, by label", async () => {
        // Keys sort the other way from labels, and the record holds them in key order, so
        // only a label sort puts Appeals first.
        mockGet.mockResolvedValue(
            configEntity({
                'aa-reports': customType('aa-reports', 'Reports'),
                'zz-appeals': customType('zz-appeals', 'Appeals'),
            }),
        );
        const interaction = buttonInteraction();

        const result = await CreateModTicketButtonComponent().handler(interaction);

        expect(result.status).toBe('success');
        expect(interaction.showModal).toHaveBeenCalledTimes(1);
        const modal = interaction.showModal.mock.calls[0][0] as ModalBuilder;
        expect(typeSelect(modal).options.map((option) => option.value)).toEqual(['zz-appeals', 'aa-reports']);
    });

    it('logs a modal that fails to build and tells the moderator a type is misconfigured', async () => {
        // A key over Discord's 100 can only be a row saved before the key limit existed.
        // The builder throws on it, and the guild's mods deserve better than a generic error.
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const longKey = 'k'.repeat(101);
        mockGet.mockResolvedValue(configEntity({ appeals: APPEALS, [longKey]: customType(longKey, 'Long') }));
        const interaction = buttonInteraction();

        const result = await CreateModTicketButtonComponent().handler(interaction);

        expect(result.status).toBe('error');
        expect(result.message).toContain('misconfigured');
        expect(interaction.showModal).not.toHaveBeenCalled();
        const logged = String(error.mock.calls[0][0]);
        expect(logged).toContain(GUILD_ID);
        expect(logged).toContain(`appeals, ${longKey}`);
        // The validator's own words, which say what was wrong.
        expect(logged).toContain('Invalid string length');
        error.mockRestore();
    });

    it('throws a Discord refusal on to the registry rather than blaming a ticket type', async () => {
        mockGet.mockResolvedValue(configEntity({ appeals: APPEALS }));
        const interaction = buttonInteraction();
        const expired = new DiscordAPIError(
            { code: 10062, message: 'Unknown interaction' },
            10062,
            404,
            'POST',
            '/interactions/1/token/callback',
            { body: undefined, files: undefined },
        );
        interaction.showModal.mockRejectedValue(expired);

        await expect(CreateModTicketButtonComponent().handler(interaction)).rejects.toBe(expired);
    });

    it('refuses with a clear error instead of a modal when the guild declared no types', async () => {
        mockGet.mockResolvedValue(configEntity({}));
        const interaction = buttonInteraction();

        const result = await CreateModTicketButtonComponent().handler(interaction);

        expect(result.status).toBe('error');
        expect(result.message).toContain('ticket type');
        expect(interaction.showModal).not.toHaveBeenCalled();
    });

    it('treats a config with no ticketTypes member the same as an empty one', async () => {
        mockGet.mockResolvedValue(configEntity(undefined));
        const interaction = buttonInteraction();

        const result = await CreateModTicketButtonComponent().handler(interaction);

        expect(result.status).toBe('error');
        expect(interaction.showModal).not.toHaveBeenCalled();
    });
});

describe('a mod ticket modal submit', () => {
    it('opens the picked type on a guild that has no support type at all', async () => {
        mockGet.mockResolvedValue(configEntity({ appeals: APPEALS, reports: REPORTS }));

        const result = await CreateModTicketModalComponent().handler(submitInteraction('appeals'));

        expect(result.status).toBe('success');
        expect(mockOpenTicket).toHaveBeenCalledTimes(1);
        expect(mockOpenTicket.mock.calls[0][0]).toMatchObject({ type: 'appeals', definition: APPEALS });
        // Unchanged: the moderator is the actor, at the root of any chain.
        expect(mockRecordTicketStateMessage).toHaveBeenCalledWith(7, 'state-message-1', {
            actorId: 'moderator-1',
            chainDepth: 0,
        });
    });

    it('refuses by name when the picked type was deleted after the modal opened', async () => {
        mockGet.mockResolvedValue(configEntity({ reports: REPORTS }));

        const result = await CreateModTicketModalComponent().handler(submitInteraction('appeals'));

        expect(result.status).toBe('error');
        expect(result.message).toContain('`appeals`');
        expect(mockOpenTicket).not.toHaveBeenCalled();
        expect(mockCreateTicketChannel).not.toHaveBeenCalled();
    });

    it('tells the moderator to reopen a form opened before the picker existed', async () => {
        // The real fields class, so the error is the one discord.js actually throws for a
        // submit that carries no type field.
        const staleFields = new (ModalSubmitFields as unknown as new (components: unknown[]) => ModalSubmitFields)(
            [],
        );
        const interaction = {
            ...submitInteraction('appeals'),
            fields: staleFields,
        } as unknown as ModalSubmitInteraction;

        const result = await CreateModTicketModalComponent().handler(interaction);

        expect(result.status).toBe('error');
        expect(result.message).toContain('out of date');
        expect(mockOpenTicket).not.toHaveBeenCalled();
    });
});
