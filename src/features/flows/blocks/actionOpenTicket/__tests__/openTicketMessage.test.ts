import { randomUUID } from 'node:crypto';
import { MessageType, type Client } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { database } from '../../../../../features-system/data-persistence/database';
import { migrateTestDatabase } from '../../../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import {
    TestDiscord,
    type ServerChannel,
    type ServerGuild,
    type ServerMember,
} from '../../../../../shared/__tests__/support/testDiscord';
import { seedTicketCategorySlots } from '../../../../tickets/__tests__/support/ticketTestTables';
import { PARTICIPANT_PERMISSIONS, STAFF_PERMISSIONS } from '../../../../tickets/data/defaultTicketTypes';
import { ticketingRepo } from '../../../../tickets/data/ticketingRepo';
import type { ConfiguredTicketingConfig } from '../../../../tickets/data/ticketingSchema';
import { TRIGGER_MEMBER_JOIN } from '../../triggerMemberJoin';
import { ensureBlocksDiscovered } from '../../registry';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../../data/flowGraph';
import { executeFlow, type FlowRunResult } from '../../../engine/executor';
import { ACTION_OPEN_TICKET, openTicketConfigSchema } from '..';

/**
 * Open Ticket with a message of the flow's own, run for real: the executor, the ticket
 * service on the migrated schema, and discord.js against TestDiscord — so the order things
 * land in the ticket channel is the order Discord received them, and the state message the
 * ticket records is the one really posted.
 *
 * One guild per case, each with tickets deployed, so every ticket channel and row a case
 * finds is its own.
 */

const discord = new TestDiscord();
let client: Client<true>;

const EMBED = { embeds: [{ title: 'Aftercare', description: 'Water, snacks, and a blanket. Talk to us.' }] };
const BUTTONS = [
    { key: 'all-good', label: 'All good', style: 'Success' },
    { key: 'need-a-mod', label: 'Need a mod', style: 'Danger', emoji: { name: '🚨' } },
] as const;

interface TicketScenario {
    readonly guild: ServerGuild;
    readonly subject: ServerMember;
}

const scenarios: Record<'buttons' | 'plain' | 'none' | 'broken', TicketScenario> = {} as Record<
    'buttons' | 'plain' | 'none' | 'broken',
    TicketScenario
>;

function ticketGuild(): TicketScenario & { readonly config: () => Promise<void> } {
    const guild = discord.createGuild({ bot: { permissions: ['ManageChannels', 'ManageRoles', 'SendMessages', 'EmbedLinks'] } });
    const moderators = guild.createRole({ name: 'Dungeon Monitors' });
    const subject = guild.createMember({ username: 'rope_bunny' });
    const desk = guild.createTextChannel({ name: 'ticket-desk' });
    const open = guild.createCategory({ name: 'Tickets — Open' });
    const claimed = guild.createCategory({ name: 'Tickets — Claimed' });
    const closed = guild.createCategory({ name: 'Tickets — Closed' });

    const { categories, ...stored }: ConfiguredTicketingConfig = {
        modTicketsDeployed: true,
        modTicketsDeployedChannelId: desk.id,
        modTicketsDeployedMessageId: 'panel-message',
        categories: {
            open: { name: open.name, discordId: open.id, provenance: 'adopted' },
            claimed: { name: claimed.name, discordId: claimed.id, provenance: 'adopted' },
            closed: { name: closed.name, discordId: closed.id, provenance: 'adopted' },
        },
        typeCategories: new Map(),
        moderationRoles: [moderators.id],
        ticketTypes: {
            aftercare: {
                type: 'aftercare',
                label: 'Aftercare Check-in',
                nameTemplate: 'aftercare-{{####}}-{{subject}}',
                permissions: { subject: PARTICIPANT_PERMISSIONS, opener: PARTICIPANT_PERMISSIONS, staff: STAFF_PERMISSIONS },
                autoClaimOnOpen: false,
            },
        },
    };

    return {
        guild,
        subject,
        config: async () => {
            await ticketingRepo.upsert({ guildId: guild.id, config: stored, ticketNumberInc: 0, entityVersion: 1 });
            await seedTicketCategorySlots(guild.id, categories);
        },
    };
}

/** Member Joins → Open Ticket, holding `extra` beside its type and title. */
function opening(extra: Record<string, unknown>): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'joined', type: TRIGGER_MEMBER_JOIN, position: { x: 0, y: 0 }, data: {} },
            {
                id: 'open',
                type: ACTION_OPEN_TICKET,
                position: { x: 0, y: 160 },
                data: { ticketType: 'aftercare', title: 'Aftercare for {{subject.username}}', ...extra },
            },
        ],
        edges: [{ id: 'e1', source: 'joined', target: 'open' }],
    };
}

function run({ guild, subject }: TicketScenario, extra: Record<string, unknown>): Promise<FlowRunResult> {
    const member = discord.clientGuild(guild).members.cache.get(subject.id);
    if (!member) throw new Error(`The client holds no member ${subject.id}.`);
    return executeFlow('flow-aftercare', opening(extra), 'joined', {
        client,
        guild: discord.clientGuild(guild),
        subject: member,
        actor: member,
        variables: {},
    });
}

async function ticketsIn(guild: ServerGuild) {
    return database.selectFrom('tickets').select(['id', 'channelId', 'stateMessageId']).where('guildId', '=', guild.id).execute();
}

/** The one ticket a case opened, and its channel. */
async function onlyTicket(guild: ServerGuild): Promise<{ id: number; channel: ServerChannel; stateMessageId: string | null }> {
    const [ticket, ...others] = await ticketsIn(guild);
    if (!ticket?.channelId || others.length > 0) throw new Error('Expected exactly one ticket with a channel.');
    return { id: ticket.id, channel: guild.channel(ticket.channelId), stateMessageId: ticket.stateMessageId };
}

/** What the bot posted in a channel, oldest first, leaving out Discord's own pin notices. */
function botPosts(guild: ServerGuild, channel: ServerChannel) {
    return channel.messages.filter((message) => message.authorId === guild.bot.id && message.type === MessageType.Default);
}

async function recordsIn(guild: ServerGuild) {
    return database.selectFrom('flow_posted_messages').selectAll().where('guildId', '=', guild.id).execute();
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    // The executor logs every failed run, and one case fails on purpose.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await ensureBlocksDiscovered();
    await migrateTestDatabase();

    for (const name of ['buttons', 'plain', 'none', 'broken'] as const) {
        const scenario = ticketGuild();
        await scenario.config();
        scenarios[name] = scenario;
    }
    client = await discord.start();
}, 60_000);

afterAll(async () => {
    vi.restoreAllMocks();
    await discord.destroy();
});

describe("Open Ticket's own message", () => {
    it('posts it, buttons and all, before the ticket card, and records the card as the state message', async () => {
        const scenario = scenarios.buttons;
        const result = await run(scenario, { message: EMBED, buttons: BUTTONS });

        expect(result.status).toBe('success');
        const ticket = await onlyTicket(scenario.guild);
        const [flowMessage, card, ...rest] = botPosts(scenario.guild, ticket.channel);
        expect(rest).toEqual([]);

        expect(flowMessage?.embeds).toMatchObject([{ title: 'Aftercare' }]);
        expect(flowMessage?.components).toMatchObject([
            {
                components: [
                    { custom_id: 'mbtn:all-good', label: 'All good' },
                    { custom_id: 'mbtn:need-a-mod', label: 'Need a mod', emoji: { name: '🚨' } },
                ],
            },
        ]);
        expect(card?.content).toBe(`<@${scenario.subject.id}>`);

        // The card is what the ticket is run from: its id is the state message, and only it is pinned.
        expect(ticket.stateMessageId).toBe(card?.id);
        expect(card?.pinned).toBe(true);
        expect(flowMessage?.pinned).toBe(false);

        // The message carrying buttons is recorded against the flow, node, run, member and ticket.
        expect(await recordsIn(scenario.guild)).toEqual([
            {
                messageId: flowMessage?.id,
                guildId: scenario.guild.id,
                channelId: ticket.channel.id,
                flowId: 'flow-aftercare',
                nodeId: 'open',
                runId: result.runId,
                subjectId: scenario.subject.id,
                ticketId: ticket.id,
                postedAt: expect.any(Date),
            },
        ]);
    });

    it('posts a message without buttons above the card too, and records nothing', async () => {
        const scenario = scenarios.plain;
        const result = await run(scenario, { message: EMBED });

        expect(result.status).toBe('success');
        const ticket = await onlyTicket(scenario.guild);
        const [flowMessage, card] = botPosts(scenario.guild, ticket.channel);
        expect(flowMessage?.embeds).toMatchObject([{ title: 'Aftercare' }]);
        expect(flowMessage?.components).toEqual([]);
        expect(ticket.stateMessageId).toBe(card?.id);
        expect(await recordsIn(scenario.guild)).toEqual([]);
    });

    it('posts the card alone when the node has no message', async () => {
        const scenario = scenarios.none;
        const result = await run(scenario, {});

        expect(result.status).toBe('success');
        const ticket = await onlyTicket(scenario.guild);
        const posts = botPosts(scenario.guild, ticket.channel);
        expect(posts.map((post) => post.content)).toEqual([`<@${scenario.subject.id}>`]);
        expect(ticket.stateMessageId).toBe(posts[0]?.id);
        expect(await recordsIn(scenario.guild)).toEqual([]);
    });

    it('fails before any ticket exists when its message cannot post — no row, no channel', async () => {
        const scenario = scenarios.broken;
        const writesBefore = discord.writesTo(scenario.guild).length;

        const result = await run(scenario, {
            message: { embeds: [{ title: 'Ghost', image: `upload:${randomUUID()}` }] },
            buttons: BUTTONS,
        });

        expect(result.status).toBe('error');
        expect(result.error).toContain(`"Message" embed 1 image: That uploaded picture isn't in this server.`);
        expect(await ticketsIn(scenario.guild)).toEqual([]);
        // Not a channel made, nor anything else written to the server.
        expect(discord.writesTo(scenario.guild)).toHaveLength(writesBefore);
        expect(await recordsIn(scenario.guild)).toEqual([]);
    });
});

describe("Open Ticket's config", () => {
    it('still takes a node saved before it had a message or buttons', () => {
        expect(openTicketConfigSchema.safeParse({ ticketType: 'aftercare', title: 'Check in' }).success).toBe(true);
    });

    it('refuses buttons with no message to sit under', () => {
        const parsed = openTicketConfigSchema.safeParse({ ticketType: 'aftercare', title: 'Check in', buttons: BUTTONS });

        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues).toEqual([
            expect.objectContaining({ path: ['buttons'], message: expect.stringMatching(/^Buttons need a message to hang off/) }),
        ]);
    });

    it('takes an empty button list with no message, which posts nothing extra', () => {
        expect(openTicketConfigSchema.safeParse({ ticketType: 'aftercare', title: 'Check in', buttons: [] }).success).toBe(true);
    });
});
