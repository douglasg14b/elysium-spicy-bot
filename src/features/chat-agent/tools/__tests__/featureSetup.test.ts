import { ChannelType, type Guild, type GuildMember } from 'discord.js';
import type { ChatToolContext } from '../chatToolContext';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../flows/blocks/registry', () => ({
    getBlockDefinition: (type: string) =>
        ({
            'trigger.memberJoin': { kind: 'trigger', label: 'Member Joins' },
            'action.sendMessage': { kind: 'action', label: 'Send Message' },
        })[type],
}));
vi.mock('../../../flows/data/flowsRepo', () => ({
    flowsRepo: {
        getByGuildId: async () => [
            {
                flowId: 'flow-1',
                name: 'Welcome',
                enabled: true,
                graph: { nodes: [{ type: 'trigger.memberJoin' }, { type: 'action.sendMessage' }, { type: 'trigger.retired' }] },
            },
            { flowId: 'flow-2', name: 'Draft idea', enabled: false, graph: { nodes: [] } },
        ],
    },
}));
vi.mock('../../../provisioning/data/journeysRepo', () => ({
    journeysRepo: { listNamesByGuildId: async () => [{ journeyKey: 'onboarding', name: 'Onboarding' }] },
}));
vi.mock('../../../provisioning/data/flowJourneyLinksRepo', () => ({
    flowJourneyLinksRepo: { listLinksForGuild: async () => [{ flowId: 'flow-1', journeyKey: 'onboarding' }] },
}));
vi.mock('../../../tickets/data/ticketingRepo', () => ({
    ticketingRepo: {
        get: async () => ({
            config: {
                modTicketsDeployed: true,
                modTicketsDeployedChannelId: 'gone-channel',
                modTicketsDeployedMessageId: 'message',
                categories: {
                    open: { name: 'Open Tickets', discordId: 'c1', provenance: 'created' },
                    claimed: { name: 'Claimed', discordId: null },
                    closed: null,
                },
                typeCategories: new Map([['verification', { open: { name: 'Verify Here', discordId: 'c2', provenance: 'created' } }]]),
                moderationRoles: ['role-mods'],
                ticketTypes: {
                    support: { type: 'support', label: 'Support', autoClaimOnOpen: true },
                    verification: { type: 'verification', label: 'Verification', autoClaimOnOpen: false },
                },
            },
        }),
    },
}));

vi.mock('../../../warnings/data/warningsConfigRepo', () => ({
    warningsConfigRepo: { getByGuildId: async () => ({ modChannelId: 'admins-only' }) },
}));
vi.mock('../../../birthday-tracker/data/birthdayConfigRepo', () => ({
    birthdayConfigRepo: { getByGuildId: async () => ({ announcementChannelId: 'general', contextChannelId: null }) },
}));

const { FEATURE_SETUP } = await import('../featureSetup');

/** A channel only the members named can see. */
function channel(id: string, name: string, seenBy: readonly string[]) {
    return [id, { id, name, type: ChannelType.GuildText, permissionsFor: (who: { id: string }) => ({ has: () => seenBy.includes(who.id) }) }] as const;
}

const guild = {
    id: 'guild',
    channels: {
        cache: new Map([
            channel('general', 'general', ['mod', 'admin']),
            channel('admins-only', 'admin-log', ['admin']),
            // Renamed in Discord since it was bound: the live name is the one told.
            channel('c1', 'Tickets', ['mod']),
            channel('c2', 'Verify Desk', ['mod']),
        ]),
    },
    roles: { cache: new Map([['role-mods', { id: 'role-mods', name: 'Mods' }]]) },
} as unknown as Guild;
const mod = { id: 'mod' } as GuildMember;

/** A turn asked by the mod, alone in the channel. */
const CONTEXT = {
    guild,
    viewers: [mod],
    contextChannels: [{ channelId: 'admins-only', isRules: false }],
    botRules: 'Never ping @everyone.',
    serverNotes: '',
    staffRoleIds: ['role-mods'],
} as unknown as ChatToolContext;

describe('feature setup', () => {
    it('lists flows by name, on or off, by their triggers and journey', async () => {
        expect(await FEATURE_SETUP.flows(CONTEXT)).toEqual({
            flows: [
                { name: 'Welcome', on: true, startsOn: ['Member Joins', 'trigger.retired'], journey: 'Onboarding' },
                { name: 'Draft idea', on: false, startsOn: [], journey: null },
            ],
            journeys: ['Onboarding'],
        });
    });

    it('names tickets\' channels, categories and roles, never their ids', async () => {
        const setup = await FEATURE_SETUP.tickets(CONTEXT);

        expect(setup).toEqual({
            setUp: true,
            panelPostedIn: 'a channel that has been deleted',
            categories: {
                'open tickets': '#Tickets',
                'claimed tickets': 'not linked — tickets stop until it is linked on Tickets config',
                'closed tickets': 'not set',
                '"Verification" open tickets': '#Verify Desk',
            },
            moderationRoles: ['@Mods'],
            ticketTypes: [
                { name: 'Support', claimedOnOpen: true },
                { name: 'Verification', claimedOnOpen: false },
            ],
        });
        expect(JSON.stringify(setup)).not.toMatch(/gone-channel|role-mods|c1|Open Tickets/);
    });

    it('names a channel only when every reader can see it', async () => {
        expect(await FEATURE_SETUP.birthdays(CONTEXT)).toEqual({ setUp: true, announcementChannel: '#general', contextChannel: 'not set' });
        const warnings = await FEATURE_SETUP.warnings(CONTEXT);
        expect(warnings).toEqual({ modLogChannel: 'a channel not everyone here can see' });
        expect(JSON.stringify(warnings)).not.toContain('admin-log');
    });

    it("tells the chat agent's setup and the staff roles from the turn, its hidden context channel unnamed", async () => {
        expect(await FEATURE_SETUP.chatAgent(CONTEXT)).toEqual({
            contextChannels: [{ channel: 'a channel not everyone here can see', rulesChannel: false }],
            introsChannel: 'not set',
            staffRoles: ['@Mods'],
            botRules: 'Never ping @everyone.',
            serverNotes: 'not set',
        });
    });
});
