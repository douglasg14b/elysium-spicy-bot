import { type Guild, type GuildMember, type GuildTextBasedChannel } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { BOT_FEATURES, FEATURE_GUIDES, type BotFeature } from '../botFeatures';
import type { ChatToolContext } from '../chatToolContext';
import type { Viewers } from '../visibleChannels';

/** Every feature's setup, as a reader that says which feature it was asked about. */
vi.mock('../featureSetup', async () => {
    const { BOT_FEATURES: features } = await import('../botFeatures');
    return { FEATURE_SETUP: Object.fromEntries(features.map((feature) => [feature, async () => ({ setUpFor: feature })])) };
});

vi.mock('../../../../environment', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    WEB_ENABLED: true,
    WEB_PUBLIC_URL: 'https://brattybot.example',
}));

const { getBotFeatureTool } = await import('../botFeatureTools');

const STAFF_ROLE = '300000000000000001';
const guild = { id: 'guild', ownerId: 'owner', memberCount: 2, members: { cache: { size: 2 } } };

function member(id: string, roles: string[]): GuildMember {
    return {
        id,
        guild,
        permissions: { has: () => false },
        roles: { cache: new Map(roles.map((roleId) => [roleId, { id: roleId }])) },
    } as unknown as GuildMember;
}

const mod = member('mod', [STAFF_ROLE]);
const vex = member('vex', []);

function contextFor(viewers: Viewers): ChatToolContext {
    return {
        guild: guild as unknown as Guild,
        channel: { id: 'channel', name: 'staff-room' } as unknown as GuildTextBasedChannel,
        asker: viewers[0],
        viewers,
        viewersCanReadHistory: true,
        ticket: null,
        contextChannels: [],
        serverNotes: '',
        botRules: '',
        staffRoleIds: [STAFF_ROLE],
        introsChannelId: null,
    };
}

async function ask(viewers: Viewers, feature: BotFeature) {
    const execute = getBotFeatureTool(contextFor(viewers)).execute;
    if (!execute) throw new Error('getBotFeature has no execute');
    return execute({ feature }, { toolCallId: 'call-1', messages: [], context: undefined } as never);
}

describe('getBotFeature', () => {
    it("tells staff in a staff-only channel how the feature works, its commands from the real builders, and this server's setup", async () => {
        const answer = await ask([mod], 'tickets');

        expect(answer).toMatchObject({
            answered: true,
            feature: 'Tickets',
            about: FEATURE_GUIDES.tickets.about,
            commands: [{ command: '/deploy-ticket-system' }],
            setupHere: { setUpFor: 'tickets' },
        });
        expect(JSON.stringify(answer)).toContain('https://brattybot.example/tickets/config');
    });

    it('lists a command\'s subcommands', async () => {
        const answer = await ask([mod], 'flashChat');
        expect(JSON.stringify(answer)).toContain('/flash-chat setup');
    });

    it("refuses a member who isn't staff, and hands the model nothing of the feature to repeat", async () => {
        const answer = await ask([vex, mod], 'tickets');
        expect(answer).toMatchObject({ answered: false, reason: expect.stringContaining('Only staff') });
        expect(JSON.stringify(answer)).not.toMatch(/deploy-ticket-system|moderators|setUpFor/);
    });

    it("refuses staff where someone who isn't staff can read, with nothing of the feature", async () => {
        const answer = await ask([mod, vex], 'warnings');
        expect(answer).toMatchObject({ answered: false, reason: expect.stringContaining("aren't staff") });
        expect(JSON.stringify(answer)).not.toMatch(/\/warn|mod-log|setUpFor/);
    });
});
