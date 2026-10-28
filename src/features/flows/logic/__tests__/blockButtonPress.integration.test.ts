import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, type Interaction, type PermissionsString } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DISCORD_CLIENT } from '../../../../discordClient';
import { interactionsRegistry } from '../../../../features-system/commands';
import { database } from '../../../../features-system/data-persistence/database';
import { migrateTestDatabase } from '../../../../features-system/data-persistence/__tests__/support/migrateTestDatabase';
import {
    TestDiscord,
    type ServerChannel,
    type ServerGuild,
    type ServerInteraction,
    type ServerMember,
} from '../../../../shared/__tests__/support/testDiscord';
import { flowJourneyLinksRepo, journeysRepo } from '../../../provisioning';
import { seedTicketCategorySlots } from '../../../tickets/__tests__/support/ticketTestTables';
import { PARTICIPANT_PERMISSIONS, STAFF_PERMISSIONS } from '../../../tickets/data/defaultTicketTypes';
import { ticketingRepo } from '../../../tickets/data/ticketingRepo';
import type { ConfiguredTicketingConfig } from '../../../tickets/data/ticketingSchema';
import { ACTION_CLOSE_TICKET } from '../../blocks/actionCloseTicket';
import { ACTION_OPEN_TICKET } from '../../blocks/actionOpenTicket';
import { ACTION_POST_EMBED } from '../../blocks/actionPostEmbed';
import { ACTION_SEND_MESSAGE } from '../../blocks/actionSendMessage';
import { ACTION_WAIT_FOR_EVENT } from '../../blocks/actionWaitForEvent';
import { TRIGGER_BUTTON_CLICK } from '../../blocks/triggerButtonClick';
import { TRIGGER_MEMBER_JOIN } from '../../blocks/triggerMemberJoin';
import { FLOW_GRAPH_VERSION, type FlowGraph, type FlowNode } from '../../data/flowGraph';
import { flowRunsRepo } from '../../data/flowRunsRepo';
import type { FlowRunEntity } from '../../data/flowRunsSchema';
import { flowsRepo } from '../../data/flowsRepo';
import { executeFlow } from '../../engine/executor';
import { resetFlowRunSchedulerForTests } from '../../engine/flowRunScheduler';
import { initFlows } from '../../initFlows';
import { flowPostedMessagesRepo } from '../flowPostedMessagesRepo';
import { LISTENER_DISABLED, LISTENERS_FIGHTING, NOTHING_HOOKED_UP } from '../messageButtonPress';

/**
 * A press on a button under a block's post, end to end (step 2,
 * `docs/plans/block-message-buttons-step-2.md`): the bot's own `DISCORD_CLIENT` against
 * TestDiscord, wired by the real `initFlows()`, on the real migrated schema, with presses
 * routed through the real `interactionsRegistry` as `bot.ts` routes them.
 *
 * Where a case is about the post itself (Post Embed's, Open Ticket's), the posting block runs
 * for real through the executor, under the posting flow's id, so the record the press reads
 * is the one the block wrote. Where a case is about who listens, the post is a message the
 * bot sends with one `mbtn:` button and its record written straight to the table.
 *
 * Every listener says who its run was about and who set it going, so a case reads both off
 * one line. One guild per case, so no case's flows or parked runs reach another's.
 */

const WAIT_FOR = { timeout: 10_000 };
const JOURNEY_KEY = 'house';
const BOT_PERMISSIONS: readonly PermissionsString[] = ['ManageChannels', 'ManageRoles', 'SendMessages', 'EmbedLinks'];

const discord = new TestDiscord();
const handling: Promise<void>[] = [];
const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

interface Dungeon {
    readonly guild: ServerGuild;
    /** Where every listener says its line. */
    readonly lounge: ServerChannel;
    /** Where posts go. */
    readonly notices: ServerChannel;
}

function dungeon(): Dungeon {
    const guild = discord.createGuild({ bot: { permissions: BOT_PERMISSIONS } });
    return { guild, lounge: guild.createTextChannel({ name: 'lounge' }), notices: guild.createTextChannel({ name: 'notices' }) };
}

/** A Button Click on `poster`'s `nodeId` button `buttonKey`, as the trigger's config holds it. */
function buttonTrigger(button: { flowId: string; nodeId: string; buttonKey: string }, gate?: Record<string, unknown>): FlowNode {
    return {
        id: 'press',
        type: TRIGGER_BUTTON_CLICK,
        position: { x: 0, y: 0 },
        data: { button, eligibility: gate ?? { principal: 'anyone' } },
    };
}

/** The button trigger, then a line in `lounge` naming who the run is about and who pressed. */
function listenerGraph(lounge: ServerChannel, button: { flowId: string; nodeId: string; buttonKey: string }, extra: FlowNode[] = []): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            buttonTrigger(button),
            {
                id: 'say',
                type: ACTION_SEND_MESSAGE,
                position: { x: 0, y: 100 },
                data: { channelId: lounge.id, message: 'about {{subject.id}}, pressed by {{actor.mention}}' },
            },
            ...extra,
        ],
        edges: [{ id: 'e1', source: 'press', target: 'say' }],
    };
}

/** Member Joins → Post Embed in `notices` with one `kneel` button: the posting flow. */
function posterGraph(notices: ServerChannel): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'joined', type: TRIGGER_MEMBER_JOIN, position: { x: 0, y: 0 }, data: {} },
            postNode(notices),
        ],
        edges: [{ id: 'e1', source: 'joined', target: 'post' }],
    };
}

function postNode(notices: ServerChannel): FlowNode {
    return {
        id: 'post',
        type: ACTION_POST_EMBED,
        position: { x: 0, y: 100 },
        data: {
            channelId: notices.id,
            message: { embeds: [{ title: 'Kneel, pet' }] },
            buttons: [{ key: 'kneel', label: 'Kneel', style: 'Primary' }],
        },
    };
}

/** Member joins → waits for a button click → a line in `lounge` saying who woke. */
function waitingRoomGraph(lounge: ServerChannel): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'trigger', type: TRIGGER_MEMBER_JOIN, position: { x: 0, y: 0 }, data: {} },
            { id: 'wait', type: ACTION_WAIT_FOR_EVENT, position: { x: 0, y: 100 }, data: { eventKind: 'buttonClick' } },
            {
                id: 'woke',
                type: ACTION_SEND_MESSAGE,
                position: { x: 0, y: 200 },
                data: { channelId: lounge.id, message: 'woke {{subject.username}}' },
            },
        ],
        edges: [
            { id: 'e1', source: 'trigger', target: 'wait' },
            { id: 'e2', source: 'wait', target: 'woke' },
        ],
    };
}

/** A flow written straight to the database, in `journeyKey`'s journey when one is named. */
async function storeFlow(
    guild: ServerGuild,
    input: { readonly name: string; readonly graph: FlowGraph; readonly enabled: boolean; readonly flowId?: string; readonly journeyKey?: string }
): Promise<string> {
    const flow = await flowsRepo.create({ guildId: guild.id, name: input.name, graph: input.graph, enabled: input.enabled, flowId: input.flowId });
    if (input.journeyKey) {
        await flowJourneyLinksRepo.attach({ guildId: guild.id, flowId: flow.flowId, journeyKey: input.journeyKey });
    }
    return flow.flowId;
}

async function createJourney(guild: ServerGuild, journeyKey: string): Promise<void> {
    await journeysRepo.create({ guildId: guild.id, journeyKey, name: journeyKey, resources: [] });
}

/**
 * The posting flow, switched off so no join starts it: whether the poster is live never
 * decides who hears its buttons, only whether a listener is.
 */
function storePoster(place: Dungeon, journeyKey?: string): Promise<string> {
    return storeFlow(place.guild, { name: 'Poster', graph: posterGraph(place.notices), enabled: false, journeyKey });
}

/** A message with one `mbtn:<buttonKey>` button, sent by the bot in `notices`; its id. */
async function sendButtonMessage(place: Dungeon, buttonKey: string): Promise<string> {
    const channel = discord.clientGuild(place.guild).channels.cache.get(place.notices.id);
    if (!channel?.isSendable()) throw new Error('The notices channel is not sendable.');
    const message = await channel.send({
        content: 'Press me, pet',
        components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(`mbtn:${buttonKey}`).setLabel(buttonKey).setStyle(ButtonStyle.Primary)
            ),
        ],
    });
    discord.flushGateway();
    return message.id;
}

/**
 * A message with one `mbtn:kneel` button the bot sent in `notices`, recorded as `flowId`'s
 * `post` node's — what Post Embed leaves behind, without running it.
 */
async function recordedPost(place: Dungeon, flowId: string, subjectId: string | null, recorded = true): Promise<string> {
    const messageId = await sendButtonMessage(place, 'kneel');
    if (recorded) {
        await flowPostedMessagesRepo.create({
            messageId,
            guildId: place.guild.id,
            channelId: place.notices.id,
            flowId,
            nodeId: 'post',
            runId: randomUUID(),
            subjectId,
            ticketId: null,
            postedAt: new Date().toISOString(),
        });
    }
    return messageId;
}

/** `member` pressing `customId` under `messageId` in `channel`, once the registry has answered it. */
async function press(channel: ServerChannel, member: ServerMember, customId: string, messageId: string): Promise<ServerInteraction> {
    const interaction = channel.pressButton({ by: member, messageId, customId });
    await Promise.all(handling.splice(0));
    return interaction;
}

function pressKneel(place: Dungeon, member: ServerMember, messageId: string): Promise<ServerInteraction> {
    return press(place.notices, member, 'mbtn:kneel', messageId);
}

function said(place: Dungeon): string[] {
    return place.lounge.messages.map((message) => message.content);
}

/** The one record in `guild` — the post a case made. */
async function onlyRecord(guild: ServerGuild) {
    const [record, ...others] = await database.selectFrom('flow_posted_messages').selectAll().where('guildId', '=', guild.id).execute();
    if (!record || others.length > 0) throw new Error('Expected exactly one posted-message record.');
    return record;
}

/** The run a member's join parked on the button-click wait. */
async function parkedWait(flowId: string, member: ServerMember): Promise<FlowRunEntity> {
    let parked: FlowRunEntity | undefined;
    await vi.waitFor(async () => {
        const rows = await database.selectFrom('flow_runs').select('runId').where('flowId', '=', flowId).execute();
        const runs = await Promise.all(rows.map((row) => flowRunsRepo.getByRunId(row.runId)));
        parked = runs.find((run) => run?.contextSnapshot.userId === member.id) ?? undefined;
        expect(parked?.status).toBe('suspended');
    }, WAIT_FOR);
    return parked as FlowRunEntity;
}

async function statusOf(run: FlowRunEntity): Promise<string | undefined> {
    return (await flowRunsRepo.getByRunId(run.runId))?.status;
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await migrateTestDatabase();
    await initFlows();
    // What `bot.ts` does with every interaction; `initFlows` registers handlers, not this.
    DISCORD_CLIENT.on(Events.InteractionCreate, (interaction: Interaction) => {
        handling.push(interactionsRegistry.handleInteraction(interaction));
    });
    await discord.start({ client: DISCORD_CLIENT });
}, 30_000);

afterAll(async () => {
    resetFlowRunSchedulerForTests();
    for (const event of [
        Events.ClientReady,
        Events.InteractionCreate,
        Events.MessageReactionAdd,
        Events.GuildMemberAdd,
        Events.GuildMemberRemove,
    ] as const) {
        DISCORD_CLIENT.removeAllListeners(event);
    }
    vi.restoreAllMocks();
    await discord.destroy();
});

describe("a press on a button under Post Embed's post", () => {
    it('starts a run about whoever the posting run was about, set going by the presser, closed with a deferred update', async () => {
        const place = dungeon();
        await createJourney(place.guild, JOURNEY_KEY);
        const posterId = await storePoster(place, JOURNEY_KEY);
        await storeFlow(place.guild, {
            name: 'Listener',
            graph: listenerGraph(place.lounge, { flowId: posterId, nodeId: 'post', buttonKey: 'kneel' }),
            enabled: true,
            journeyKey: JOURNEY_KEY,
        });
        const pet = place.guild.createMember({ username: 'kneeling_pet' });
        const presser = place.guild.createMember({ username: 'nosy_switch' });
        const liveGuild = discord.clientGuild(place.guild);
        const petMember = liveGuild.members.cache.get(pet.id);
        if (!petMember) throw new Error(`The client holds no member ${pet.id}.`);

        // Post Embed, run for real under the posting flow's id, about the pet.
        const posted = await executeFlow(posterId, posterGraph(place.notices), 'joined', {
            client: DISCORD_CLIENT,
            guild: liveGuild,
            subject: petMember,
            actor: petMember,
            variables: {},
        });
        expect(posted.status).toBe('success');
        const record = await onlyRecord(place.guild);
        expect(record).toMatchObject({ flowId: posterId, nodeId: 'post', subjectId: pet.id, ticketId: null });

        const pressed = await pressKneel(place, presser, record.messageId);

        expect(pressed.responses).toEqual([{ kind: 'deferUpdate' }]);
        expect(said(place)).toEqual([`about ${pet.id}, pressed by <@${presser.id}>`]);
    });

    it('starts a run about the presser when the posting run was about nobody', async () => {
        const place = dungeon();
        await createJourney(place.guild, JOURNEY_KEY);
        const posterId = await storePoster(place, JOURNEY_KEY);
        await storeFlow(place.guild, {
            name: 'Listener',
            graph: listenerGraph(place.lounge, { flowId: posterId, nodeId: 'post', buttonKey: 'kneel' }),
            enabled: true,
            journeyKey: JOURNEY_KEY,
        });
        const messageId = await recordedPost(place, posterId, null);
        const presser = place.guild.createMember({ username: 'scheduled_brat' });

        const pressed = await pressKneel(place, presser, messageId);

        expect(pressed.responses).toEqual([{ kind: 'deferUpdate' }]);
        expect(said(place)).toEqual([`about ${presser.id}, pressed by <@${presser.id}>`]);
    });

    it('starts a run about a member who has since left, as a partial member', async () => {
        const place = dungeon();
        await createJourney(place.guild, JOURNEY_KEY);
        const posterId = await storePoster(place, JOURNEY_KEY);
        await storeFlow(place.guild, {
            name: 'Listener',
            graph: listenerGraph(place.lounge, { flowId: posterId, nodeId: 'post', buttonKey: 'kneel' }),
            enabled: true,
            journeyKey: JOURNEY_KEY,
        });
        const gone = place.guild.createMember({ username: 'ghosted_dom' });
        const messageId = await recordedPost(place, posterId, gone.id);
        place.guild.removeMember(gone);
        const presser = place.guild.createMember({ username: 'left_holding_it' });

        const pressed = await pressKneel(place, presser, messageId);

        expect(pressed.responses).toEqual([{ kind: 'deferUpdate' }]);
        expect(said(place)).toEqual([`about ${gone.id}, pressed by <@${presser.id}>`]);
    });

    it('fetches the member only after acknowledging, and says so when Discord cannot find them', async () => {
        const place = dungeon();
        await createJourney(place.guild, JOURNEY_KEY);
        const posterId = await storePoster(place, JOURNEY_KEY);
        await storeFlow(place.guild, {
            name: 'Listener',
            graph: listenerGraph(place.lounge, { flowId: posterId, nodeId: 'post', buttonKey: 'kneel' }),
            enabled: true,
            journeyKey: JOURNEY_KEY,
        });
        // An id no user has: the member fetch and the user fetch both fail.
        const messageId = await recordedPost(place, posterId, '999999999999999999');
        const presser = place.guild.createMember({ username: 'pressing_a_ghost' });
        errors.mockClear();

        const pressed = await pressKneel(place, presser, messageId);

        // Acknowledged before the fetch failed — fetched first, the failure would have thrown
        // before any answer — then told quietly that the run went wrong.
        expect(pressed.responses).toEqual([
            { kind: 'deferUpdate' },
            { kind: 'ephemeralFollowUp', content: '❌ Something went wrong running this flow. A mod has been notified in the logs.' },
        ]);
        expect(said(place)).toEqual([]);
        expect(errors.mock.calls.map((call) => String(call[0])).join('\n')).toContain('member 999999999999999999');
    });

    it('lets the posting flow listen to its own post when it is on no journey', async () => {
        const place = dungeon();
        const flowId = randomUUID();
        await storeFlow(place.guild, {
            name: 'Talks to itself',
            flowId,
            graph: listenerGraph(place.lounge, { flowId, nodeId: 'post', buttonKey: 'kneel' }, [postNode(place.notices)]),
            enabled: true,
        });
        const pet = place.guild.createMember({ username: 'self_starter' });
        const messageId = await recordedPost(place, flowId, pet.id);

        const pressed = await pressKneel(place, pet, messageId);

        expect(pressed.responses).toEqual([{ kind: 'deferUpdate' }]);
        expect(said(place)).toEqual([`about ${pet.id}, pressed by <@${pet.id}>`]);
    });
});

describe('who a press on a block’s button is hooked up to', () => {
    /** A poster and a listener of its `kneel` button, both in the house journey. */
    async function grouped(enabled: boolean) {
        const place = dungeon();
        await createJourney(place.guild, JOURNEY_KEY);
        const posterId = await storePoster(place, JOURNEY_KEY);
        const listenerId = await storeFlow(place.guild, {
            name: 'Listener',
            graph: listenerGraph(place.lounge, { flowId: posterId, nodeId: 'post', buttonKey: 'kneel' }),
            enabled,
            journeyKey: JOURNEY_KEY,
        });
        return { place, posterId, listenerId };
    }

    it('hooks a message no block recorded up to nothing, whoever names its ids', async () => {
        const { place, posterId } = await grouped(true);
        const messageId = await recordedPost(place, posterId, null, false);
        const presser = place.guild.createMember({ username: 'unrecorded' });

        const pressed = await pressKneel(place, presser, messageId);

        expect(pressed.responses).toEqual([{ kind: 'ephemeralReply', content: NOTHING_HOOKED_UP }]);
        expect(said(place)).toEqual([]);
    });

    it('says the flow is disabled when only a switched-off flow listens, and runs nothing', async () => {
        const { place, posterId } = await grouped(false);
        const messageId = await recordedPost(place, posterId, null);
        const presser = place.guild.createMember({ username: 'too_eager' });

        const pressed = await pressKneel(place, presser, messageId);

        expect(pressed.responses).toEqual([{ kind: 'ephemeralReply', content: LISTENER_DISABLED }]);
        expect(said(place)).toEqual([]);
    });

    it('runs neither of two live flows on one button, says they are fighting, and logs both', async () => {
        const { place, posterId, listenerId } = await grouped(true);
        // Written straight to the database: going live would refuse the second.
        const secondId = await storeFlow(place.guild, {
            name: 'Second',
            graph: listenerGraph(place.lounge, { flowId: posterId, nodeId: 'post', buttonKey: 'kneel' }),
            enabled: true,
            journeyKey: JOURNEY_KEY,
        });
        const messageId = await recordedPost(place, posterId, null);
        const presser = place.guild.createMember({ username: 'caught_between' });
        errors.mockClear();

        const pressed = await pressKneel(place, presser, messageId);

        expect(pressed.responses).toEqual([{ kind: 'ephemeralReply', content: LISTENERS_FIGHTING }]);
        expect(said(place)).toEqual([]);
        const logged = errors.mock.calls.map((call) => String(call[0])).join('\n');
        expect(logged).toContain(listenerId);
        expect(logged).toContain(secondId);
    });

    it('hooks a post whose flow was deleted up to nothing', async () => {
        const { place, posterId } = await grouped(true);
        const messageId = await recordedPost(place, posterId, null);
        await flowsRepo.deleteByFlowId(posterId);
        const presser = place.guild.createMember({ username: 'too_late' });

        const pressed = await pressKneel(place, presser, messageId);

        expect(pressed.responses).toEqual([{ kind: 'ephemeralReply', content: NOTHING_HOOKED_UP }]);
        expect(said(place)).toEqual([]);
    });

    // Readiness and the claim check refuse these at save; a flow written straight to the table,
    // or a poster edited after its listener was saved, leaves the press's own match to decide.
    it.each([
        ['another node of the poster', (posterId: string) => ({ flowId: posterId, nodeId: 'elsewhere', buttonKey: 'kneel' })],
        ['another button of the post', (posterId: string) => ({ flowId: posterId, nodeId: 'post', buttonKey: 'beg' })],
        ['the same node and button of another poster in the journey', (_posterId: string, otherPosterId: string) => ({ flowId: otherPosterId, nodeId: 'post', buttonKey: 'kneel' })],
    ])('never runs a live listener naming %s', async (_case, named) => {
        const place = dungeon();
        await createJourney(place.guild, JOURNEY_KEY);
        const posterId = await storePoster(place, JOURNEY_KEY);
        const otherPosterId = await storePoster(place, JOURNEY_KEY);
        await storeFlow(place.guild, {
            name: 'Near miss',
            graph: listenerGraph(place.lounge, named(posterId, otherPosterId)),
            enabled: true,
            journeyKey: JOURNEY_KEY,
        });
        const messageId = await recordedPost(place, posterId, null);
        const presser = place.guild.createMember({ username: 'near_miss' });

        const pressed = await pressKneel(place, presser, messageId);

        expect(pressed.responses).toEqual([{ kind: 'ephemeralReply', content: NOTHING_HOOKED_UP }]);
        expect(said(place)).toEqual([]);
    });

    it('never runs a flow of another journey naming the exact same flow, node and button', async () => {
        const place = dungeon();
        await createJourney(place.guild, JOURNEY_KEY);
        await createJourney(place.guild, 'annex');
        const posterId = await storePoster(place, JOURNEY_KEY);
        await storeFlow(place.guild, {
            name: 'Annex door',
            graph: listenerGraph(place.lounge, { flowId: posterId, nodeId: 'post', buttonKey: 'kneel' }),
            enabled: true,
            journeyKey: 'annex',
        });
        const messageId = await recordedPost(place, posterId, null);
        const presser = place.guild.createMember({ username: 'wrong_door' });

        const pressed = await pressKneel(place, presser, messageId);

        expect(pressed.responses).toEqual([{ kind: 'ephemeralReply', content: NOTHING_HOOKED_UP }]);
        expect(said(place)).toEqual([]);
    });
});

describe('flowPostedMessagesRepo.findByMessageId', () => {
    it("finds a post's record only in the guild it was posted in", async () => {
        const place = dungeon();
        const elsewhere = dungeon();
        const messageId = await recordedPost(place, randomUUID(), null);

        expect(await flowPostedMessagesRepo.findByMessageId(place.guild.id, messageId)).toMatchObject({ messageId, nodeId: 'post' });
        expect(await flowPostedMessagesRepo.findByMessageId(elsewhere.guild.id, messageId)).toBeNull();
    });
});

describe("a press on a button under Open Ticket's post", () => {
    const BUTTON = { key: 'all-good', label: 'All good', style: 'Success' } as const;

    /** A guild with tickets deployed (an `aftercare` type), as `openTicketMessage.test.ts` builds one. */
    async function ticketDungeon(): Promise<Dungeon> {
        const place = dungeon();
        const { guild } = place;
        const moderators = guild.createRole({ name: 'Dungeon Monitors' });
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
        await ticketingRepo.upsert({ guildId: guild.id, config: stored, ticketNumberInc: 0, entityVersion: 1 });
        await seedTicketCategorySlots(guild.id, categories);
        return place;
    }

    /** Member Joins → Open Ticket with a message and one `all-good` button above the card. */
    function openingGraph(): FlowGraph {
        return {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                { id: 'joined', type: TRIGGER_MEMBER_JOIN, position: { x: 0, y: 0 }, data: {} },
                {
                    id: 'open',
                    type: ACTION_OPEN_TICKET,
                    position: { x: 0, y: 100 },
                    data: {
                        ticketType: 'aftercare',
                        title: 'Aftercare for {{subject.username}}',
                        message: { embeds: [{ title: 'Aftercare' }] },
                        buttons: [BUTTON],
                    },
                },
            ],
            edges: [{ id: 'e1', source: 'joined', target: 'open' }],
        };
    }

    /**
     * Button Click on the ticket post's `all-good`, only for the run's subject → Close Ticket on
     * the ticket it carries → a line in `lounge` naming the ticket and its channel.
     */
    function closingGraph(posterId: string, lounge: ServerChannel): FlowGraph {
        return {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                buttonTrigger({ flowId: posterId, nodeId: 'open', buttonKey: BUTTON.key }, { principal: 'subject' }),
                { id: 'close', type: ACTION_CLOSE_TICKET, position: { x: 0, y: 100 }, data: { ticketId: '{{var.ticketId}}' } },
                {
                    id: 'say',
                    type: ACTION_SEND_MESSAGE,
                    position: { x: 0, y: 200 },
                    data: { channelId: lounge.id, message: 'closed {{var.ticketId}} in {{var.ticketChannelId}}' },
                },
            ],
            edges: [
                { id: 'e1', source: 'press', target: 'close' },
                { id: 'e2', source: 'close', target: 'say' },
            ],
        };
    }

    async function ticketStatus(ticketId: number): Promise<string | undefined> {
        const row = await database.selectFrom('tickets').select('status').where('id', '=', ticketId).executeTakeFirst();
        return row?.status;
    }

    it('hands the run its ticket, lets the ticket’s subject close it, and turns a mod away without waking their wait', async () => {
        const place = await ticketDungeon();
        await createJourney(place.guild, JOURNEY_KEY);
        const posterId = await storeFlow(place.guild, { name: 'Aftercare', graph: openingGraph(), enabled: false, journeyKey: JOURNEY_KEY });
        await storeFlow(place.guild, { name: 'All good', graph: closingGraph(posterId, place.lounge), enabled: true, journeyKey: JOURNEY_KEY });
        const waitingRoomId = await storeFlow(place.guild, { name: 'Waiting room', graph: waitingRoomGraph(place.lounge), enabled: true });
        const bunny = place.guild.createMember({ username: 'rope_bunny' });
        const mod = place.guild.createMember({ username: 'dungeon_monitor' });
        const bunnyWait = await parkedWait(waitingRoomId, bunny);
        const modWait = await parkedWait(waitingRoomId, mod);

        const liveGuild = discord.clientGuild(place.guild);
        const bunnyMember = liveGuild.members.cache.get(bunny.id);
        if (!bunnyMember) throw new Error(`The client holds no member ${bunny.id}.`);
        const opened = await executeFlow(posterId, openingGraph(), 'joined', {
            client: DISCORD_CLIENT,
            guild: liveGuild,
            subject: bunnyMember,
            actor: bunnyMember,
            variables: {},
        });
        expect(opened.status).toBe('success');
        const record = await onlyRecord(place.guild);
        if (record.ticketId === null) throw new Error('Open Ticket recorded its post without its ticket.');
        expect(record).toMatchObject({ flowId: posterId, nodeId: 'open', subjectId: bunny.id });

        // TestDiscord refuses a press in a channel holding overwrites (`refuseOverwritesFor`), and
        // a ticket channel always holds them. So the presses land on a twin of the post in
        // #notices, carrying Open Ticket's own record — its flow, node, subject, ticket and
        // ticket channel — under the twin's message id.
        const twinId = await sendButtonMessage(place, BUTTON.key);
        await flowPostedMessagesRepo.create({ ...record, messageId: twinId, postedAt: new Date().toISOString() });

        // The run would be about the bunny, so a `subject` gate refuses the mod — and their wait stays parked.
        const refused = await press(place.notices, mod, `mbtn:${BUTTON.key}`, twinId);
        expect(refused.responses).toEqual([
            { kind: 'ephemeralReply', content: expect.stringMatching(/^🚫 /) as unknown as string },
        ]);
        expect(await ticketStatus(record.ticketId)).toBe('open');
        expect(await statusOf(modWait)).toBe('suspended');

        // The bunny is who it is about: admitted, their wait woken, and `{{var.ticketId}}` closes the ticket.
        const admitted = await press(place.notices, bunny, `mbtn:${BUTTON.key}`, twinId);
        expect(admitted.responses).toEqual([{ kind: 'deferUpdate' }]);
        expect(await ticketStatus(record.ticketId)).toBe('closed');
        expect(said(place)).toContain(`closed ${record.ticketId} in ${record.channelId}`);
        await vi.waitFor(async () => expect(await statusOf(bunnyWait)).toBe('completed'), WAIT_FOR);
        expect(await statusOf(modWait)).toBe('suspended');
    });
});
