import { ChannelType, Events, type ButtonInteraction, type GuildMember, type TextChannel } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DISCORD_CLIENT } from '../../../discordClient';
import { database } from '../../../features-system/data-persistence/database';
import { migrateTestDatabase } from '../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import {
    TestDiscord,
    type ServerChannel,
    type ServerGuild,
    type ServerMember,
    type ServerRole,
} from '../../../shared/__tests__/support/testDiscord';
import { TicketCloseButtonComponent } from '../../tickets/components/ticketCloseButton';
import { PARTICIPANT_PERMISSIONS, STAFF_PERMISSIONS } from '../../tickets/data/defaultTicketTypes';
import { ticketingRepo } from '../../tickets/data/ticketingRepo';
import type { ConfiguredTicketingConfig, TicketTypeDefinition } from '../../tickets/data/ticketingSchema';
import { getTicket } from '../../tickets/ticketService';
import { block as openTicketBlock } from '../blocks/actionOpenTicket';
import { ACTION_CLOSE_TICKET } from '../blocks/actionCloseTicket';
import { ACTION_OPEN_TICKET } from '../blocks/actionOpenTicket';
import { ACTION_SEND_MESSAGE } from '../blocks/actionSendMessage';
import { CONDITION_HAS_OPEN_TICKET } from '../blocks/conditionHasOpenTicket';
import { TRIGGER_MEMBER_JOIN } from '../blocks/triggerMemberJoin';
import { TRIGGER_TICKET_EVENT } from '../blocks/triggerTicketEvent';
import type { FlowVariableValue } from '../blocks/types';
import { FLOW_MAX_CHAIN_DEPTH } from '../constants';
import { FLOW_GRAPH_VERSION, type FlowEdge, type FlowGraph, type FlowNode } from '../data/flowGraph';
import { flowsRepo } from '../data/flowsRepo';
import { executeFlow } from '../engine/executor';
import { resetFlowRunSchedulerForTests } from '../engine/flowRunScheduler';
import { validateAuthoredGraph } from '../engine/graphValidation';
import { initFlows } from '../initFlows';

/**
 * Ticket Event, live and end to end: the bot's own `DISCORD_CLIENT` against TestDiscord,
 * wired by the real `initFlows()`, on the real migrated schema. Tickets are opened and
 * closed by the product's own paths — the Open Ticket and Close Ticket blocks, and the
 * Close button's handler — so every announcement a flow hears is one the ticket service
 * really made, after a real write.
 *
 * One guild per concern, all built before the client starts, each with its own ticket
 * types — none of them the seeded two, which are never special.
 */

const WAIT_FOR = { timeout: 10_000 };

const discord = new TestDiscord();

interface TicketGuild {
    readonly guild: ServerGuild;
    readonly moderators: ServerRole;
    readonly moderator: ServerMember;
    readonly subject: ServerMember;
}

function aType(type: string, label: string): TicketTypeDefinition {
    return {
        type,
        label,
        nameTemplate: `${type}-{{####}}-{{subject}}`,
        permissions: { subject: PARTICIPANT_PERMISSIONS, opener: PARTICIPANT_PERMISSIONS, staff: STAFF_PERMISSIONS },
        autoClaimOnOpen: false,
    };
}

/** A guild with tickets deployed: three bound categories, a moderation role held by one member, and `types`. */
function ticketGuild(types: readonly TicketTypeDefinition[]): TicketGuild & { readonly config: () => Promise<void> } {
    const guild = discord.createGuild({ bot: { permissions: ['ManageChannels', 'ManageRoles'] } });
    const moderators = guild.createRole({ name: 'Dungeon Monitors' });
    const moderator = guild.createMember({ username: 'mistress_of_queues', roles: [moderators] });
    const subject = guild.createMember({ username: 'rope_bunny' });
    const desk = guild.createTextChannel({ name: 'ticket-desk' });
    const open = guild.createCategory({ name: 'Tickets — Open' });
    const claimed = guild.createCategory({ name: 'Tickets — Claimed' });
    const closed = guild.createCategory({ name: 'Tickets — Closed' });

    const config: ConfiguredTicketingConfig = {
        modTicketsDeployed: true,
        modTicketsDeployedChannelId: desk.id,
        modTicketsDeployedMessageId: 'panel-message',
        categories: {
            open: { name: open.name, discordId: open.id, provenance: 'adopted' },
            claimed: { name: claimed.name, discordId: claimed.id, provenance: 'adopted' },
            closed: { name: closed.name, discordId: closed.id, provenance: 'adopted' },
        },
        moderationRoles: [moderators.id],
        ticketTypes: Object.fromEntries(types.map((definition) => [definition.type, definition])),
    };

    return {
        guild,
        moderators,
        moderator,
        subject,
        config: async () => {
            await ticketingRepo.upsert({
                guildId: guild.id,
                config: JSON.stringify(config),
                ticketNumberInc: 0,
                entityVersion: 1,
            });
        },
    };
}

function node(id: string, type: string, data: Record<string, unknown>): FlowNode {
    return { id, type, position: { x: 0, y: 0 }, data };
}

/** Nodes wired one after another, in the order given. */
function chain(nodes: FlowNode[]): FlowGraph {
    const edges: FlowEdge[] = nodes
        .slice(1)
        .map((target, index) => ({ id: `e${index}`, source: nodes[index]?.id ?? '', target: target.id }));
    return { version: FLOW_GRAPH_VERSION, nodes, edges };
}

/** A message into the ticket that started the run. */
function sayInTicket(id: string, message: string): FlowNode {
    return node(id, ACTION_SEND_MESSAGE, { channelId: '{{var.ticketChannelId}}', message });
}

/**
 * Store a live flow — after checking the product would let it go live, since the repo
 * itself stores anything, and a green run over a graph save refuses proves nothing.
 */
async function enabledFlow(guild: ServerGuild, name: string, graph: FlowGraph): Promise<string> {
    expect(validateAuthoredGraph(graph)).toMatchObject({ valid: true });
    return (await flowsRepo.create({ guildId: guild.id, name, graph, enabled: true })).flowId;
}

function liveMember(guild: ServerGuild, member: ServerMember): GuildMember {
    const found = discord.clientGuild(guild).members.cache.get(member.id);
    if (!found) throw new Error(`The client holds no member ${member.id}.`);
    return found;
}

/** Open a ticket about the guild's subject through Open Ticket, as a run one deep would. */
async function openTicket(scenario: TicketGuild, ticketType: string): Promise<{ ticketId: number; channel: ServerChannel }> {
    const outputs = new Map<string, FlowVariableValue>();
    await openTicketBlock.run(
        { ticketType, title: 'Checking in after a heavy scene' },
        {
            client: DISCORD_CLIENT,
            guild: discord.clientGuild(scenario.guild),
            subject: liveMember(scenario.guild, scenario.subject),
            variables: {},
            runId: `run-${ticketType}`,
            nodeId: 'open',
            chainDepth: 1,
            setOutput: (key, value) => outputs.set(key, value),
        }
    );
    discord.flushGateway();
    const ticketId = Number(outputs.get('ticketId'));
    const channelId = outputs.get('ticketChannelId');
    if (typeof channelId !== 'string') throw new Error('Open Ticket recorded no channel.');
    return { ticketId, channel: scenario.guild.channel(channelId) };
}

/** What the bot has posted in a channel, oldest first. */
function botSaid(guild: ServerGuild, channel: ServerChannel): string[] {
    return channel.messages.filter((message) => message.authorId === guild.bot.id).map((message) => message.content);
}

async function ticketsIn(guild: ServerGuild): Promise<number> {
    return (await database.selectFrom('tickets').select('id').where('guildId', '=', guild.id).execute()).length;
}

let pressed: TicketGuild & { readonly config: () => Promise<void> };
let flowOpened: TicketGuild & { readonly config: () => Promise<void> };
let ordered: TicketGuild & { readonly config: () => Promise<void> };
let looping: TicketGuild & { readonly config: () => Promise<void> };

beforeAll(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await migrateTestDatabase();

    pressed = ticketGuild([aType('aftercare', 'Aftercare Check-in')]);
    flowOpened = ticketGuild([aType('aftercare', 'Aftercare Check-in')]);
    ordered = ticketGuild([aType('limits', 'Limits Talk')]);
    looping = ticketGuild([aType('ping', 'Ping'), aType('pong', 'Pong')]);
    for (const scenario of [pressed, flowOpened, ordered, looping]) await scenario.config();

    await initFlows();
    await discord.start({ client: DISCORD_CLIENT });
}, 60_000);

afterAll(async () => {
    resetFlowRunSchedulerForTests();
    for (const event of [Events.ClientReady, Events.MessageReactionAdd, Events.GuildMemberAdd, Events.GuildMemberRemove] as const) {
        DISCORD_CLIENT.removeAllListeners(event);
    }
    vi.restoreAllMocks();
    await discord.destroy();
});

describe('saving flows that name ticket types', () => {
    it('saves Ticket Event, Open Ticket and Has Open Ticket naming a type the guild declared itself, or none', () => {
        const graph = chain([
            node('closed', TRIGGER_TICKET_EVENT, { event: 'closed', ticketType: 'punishment-review' }),
            node('check', CONDITION_HAS_OPEN_TICKET, { ticketType: 'punishment-review' }),
            node('open', ACTION_OPEN_TICKET, { ticketType: 'punishment-review', title: 'Round two' }),
        ]);
        graph.edges = [
            { id: 'e1', source: 'closed', target: 'check' },
            { id: 'e2', source: 'check', sourceHandle: 'false', target: 'open' },
        ];
        const anyType = chain([node('any', TRIGGER_TICKET_EVENT, { event: 'deleted' }), sayInTicket('say', 'Gone.')]);

        expect(validateAuthoredGraph(graph)).toEqual({ valid: true, graph });
        expect(validateAuthoredGraph(anyType)).toMatchObject({ valid: true });
    });
});

describe('a ticket change starting a flow', () => {
    it('pressing Close starts a Ticket Event (closed) flow, which posts in the ticket channel naming who closed it', async () => {
        const { guild, moderator } = pressed;
        await enabledFlow(
            guild,
            'Closing remarks',
            chain([
                node('closed', TRIGGER_TICKET_EVENT, { event: 'closed', ticketType: 'aftercare' }),
                sayInTicket('say', 'Closed by {{actor.mention}}. Go drink some water, you menace.'),
            ])
        );
        const { ticketId, channel } = await openTicket(pressed, 'aftercare');
        const ticket = await getTicket(ticketId);
        if (!ticket?.stateMessageId) throw new Error('The ticket has no state message to press Close on.');

        // The Close button, pressed by the moderator on the ticket's own message.
        const liveGuild = discord.clientGuild(guild);
        const liveChannel = liveGuild.channels.cache.get(channel.id);
        if (liveChannel?.type !== ChannelType.GuildText) throw new Error('The client holds no ticket channel.');
        const member = liveMember(guild, moderator);
        const interaction = {
            guild: liveGuild,
            member,
            user: member.user,
            channel: liveChannel as TextChannel,
            message: await liveChannel.messages.fetch(ticket.stateMessageId),
            replied: false,
            deferred: false,
            deferUpdate: vi.fn().mockResolvedValue(undefined),
            followUp: vi.fn().mockResolvedValue(undefined),
            reply: vi.fn().mockResolvedValue(undefined),
        } as unknown as ButtonInteraction;

        expect(await TicketCloseButtonComponent().handler(interaction)).toEqual({ status: 'success' });

        await vi.waitFor(
            () => expect(botSaid(guild, channel)).toContain(`Closed by <@${moderator.id}>. Go drink some water, you menace.`),
            WAIT_FOR
        );
    });

    it('a ticket a flow opens starts a Ticket Event (opened) flow in its channel', async () => {
        const { guild, subject } = flowOpened;
        await enabledFlow(
            guild,
            'Welcome to the confessional',
            chain([
                node('opened', TRIGGER_TICKET_EVENT, { event: 'opened', ticketType: 'aftercare' }),
                sayInTicket('say', 'Welcome in, {{subject.mention}}. Strip down your feelings and leave them here.'),
            ])
        );
        // A flow that opens the ticket, run the way a join would start it.
        const opener = chain([
            node('joined', TRIGGER_MEMBER_JOIN, {}),
            node('open', ACTION_OPEN_TICKET, { ticketType: 'aftercare', title: 'Aftercare for {{subject.username}}' }),
        ]);
        const openerId = await enabledFlow(guild, 'Opens aftercare', opener);
        const member = liveMember(guild, subject);

        const result = await executeFlow(openerId, opener, 'joined', {
            client: DISCORD_CLIENT,
            guild: discord.clientGuild(guild),
            subject: member,
            actor: member,
            variables: {},
        });
        expect(result.status).toBe('success');

        const [row] = await database.selectFrom('tickets').select(['channelId']).where('guildId', '=', guild.id).execute();
        if (!row?.channelId) throw new Error('The flow opened no ticket with a channel.');
        await vi.waitFor(
            () =>
                expect(botSaid(guild, guild.channel(row.channelId ?? ''))).toContain(
                    `Welcome in, <@${subject.id}>. Strip down your feelings and leave them here.`
                ),
            WAIT_FOR
        );
    });

    it('the flow a close starts is never nested in the closing flow’s step, nor started on its turn', async () => {
        const { guild } = ordered;
        await enabledFlow(
            guild,
            'A: closes what opens',
            chain([
                node('opened', TRIGGER_TICKET_EVENT, { event: 'opened', ticketType: 'limits' }),
                node('close', ACTION_CLOSE_TICKET, { ticketId: '{{var.ticketId}}' }),
                sayInTicket('done', 'A is done with you.'),
            ])
        );
        await enabledFlow(
            guild,
            'B: hears the close',
            chain([node('closed', TRIGGER_TICKET_EVENT, { event: 'closed', ticketType: 'limits' }), sayInTicket('heard', 'B heard the door slam.')])
        );

        const { ticketId, channel } = await openTicket(ordered, 'limits');

        await vi.waitFor(() => expect(botSaid(guild, channel)).toContain('B heard the door slam.'), WAIT_FOR);

        // Opened fired only once the embed existed, so A's close re-rendered it: the
        // record and the embed agree the ticket is closed, with no live Claim or Close.
        const ticket = await getTicket(ticketId);
        expect(ticket?.status).toBe('closed');
        const embed = channel.message(ticket?.stateMessageId ?? '');
        expect(embed.embeds[0]?.fields?.find((field) => field.name === '📊 Status')?.value).toBe('🔴 Closed');
        const said = botSaid(guild, channel);
        // Were B run inside A's Close Ticket step, it would speak before A's last block did.
        // That A's last block speaks first at all is a fact of this harness, which answers
        // without real I/O; against Discord, B can start while A still waits on it.
        expect(said.indexOf('A is done with you.')).toBeGreaterThanOrEqual(0);
        expect(said.indexOf('A is done with you.')).toBeLessThan(said.indexOf('B heard the door slam.'));
    });

    it(`two flows opening tickets at each other stop at depth ${FLOW_MAX_CHAIN_DEPTH}, refusing the next run with a log line`, async () => {
        const { guild } = looping;
        const warn = vi.spyOn(console, 'warn');
        const pingId = await enabledFlow(
            guild,
            'Ping opens pong',
            chain([
                node('opened', TRIGGER_TICKET_EVENT, { event: 'opened', ticketType: 'ping' }),
                node('open', ACTION_OPEN_TICKET, { ticketType: 'pong', title: 'Pong' }),
            ])
        );
        const pongId = await enabledFlow(
            guild,
            'Pong opens ping',
            chain([
                node('opened', TRIGGER_TICKET_EVENT, { event: 'opened', ticketType: 'pong' }),
                node('open', ACTION_OPEN_TICKET, { ticketType: 'ping', title: 'Ping' }),
            ])
        );

        try {
            // Opened one deep. Runs then go 2 (ping→pong), 3, 4, 5 — and the open the
            // depth-5 run makes would start a sixth link, which is refused.
            await openTicket(looping, 'ping');

            await vi.waitFor(
                () => expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`Refused to start flow ${pingId} `))),
                WAIT_FOR
            );
            // The first ticket plus one from each of the four runs the cap allowed.
            expect(await ticketsIn(guild)).toBe(FLOW_MAX_CHAIN_DEPTH);
        } finally {
            // Switched off whatever happened, so a broken cap cannot keep opening
            // tickets after this test has failed.
            await flowsRepo.update(pingId, { enabled: false });
            await flowsRepo.update(pongId, { enabled: false });
        }
    });
});
