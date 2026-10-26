import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, Events, type Interaction, type PermissionsString } from 'discord.js';
import { Migrator, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { DISCORD_CLIENT } from '../../../discordClient';
import { ACTION_SEND_MESSAGE } from '../../../features/flows/blocks/actionSendMessage';
import { TRIGGER_BUTTON_CLICK } from '../../../features/flows/blocks/triggerButtonClick';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../../features/flows/data/flowGraph';
import { resetFlowRunSchedulerForTests } from '../../../features/flows/engine/flowRunScheduler';
import { RETIRED_BUTTON_MESSAGE } from '../../../features/flows/engine/flowTriggerDispatch';
import { initFlows } from '../../../features/flows/initFlows';
import { buildFlowCustomId } from '../../../features/flows/utils/customId';
import { installJourney, journeysRepo, previewDrift, previewInstall, repairDrift } from '../../../features/provisioning';
import type { JourneyDeclaration } from '../../../features/provisioning';
import {
    TestDiscord,
    type RecordedRequest,
    type ServerChannel,
    type ServerGuild,
    type ServerInteraction,
    type ServerMember,
} from '../../../shared/__tests__/support/testDiscord';
import { interactionsRegistry } from '../../commands';
import { database } from '../database';
import { FileMigrationProvider } from '../fileMigrationProvider';
import { migrateTestDatabase } from './support/migrateTestDatabase';

/**
 * The changeover on the data `2026-10-26-Button_Click_Listens_To_Message` writes, end to end
 * (`docs/plans/message-resource-step-3.md`, "After the deploy, each converted journey goes"):
 * the bot's own `DISCORD_CLIENT` against TestDiscord, wired by the real `initFlows()`, on the
 * real migrated schema, with presses routed through the real `interactionsRegistry` as
 * `bot.ts` routes them.
 *
 * TestDiscord holds what the retired Deploy left: `**Welcome**` and a `flow:` button, posted
 * by the bot, recorded in `flow_button_messages`. The migration runs over it; then the
 * operator's three steps — Install (adopts the channel, reuses the message, posts nothing),
 * Drift (the message is out of date, nothing else is), Repair (the same message, edited to an
 * `mbtn:` button) — with a press before the repair going through the `flow:` bridge and one
 * after going through the message's binding.
 */

const BEFORE = '2026-10-25-Resource_Binding_Message_Post';
const FLOW_ID = 'flow-welcome';
/** A flow whose button Deploy posted before `flow_button_messages` existed: no row names it. */
const RETIRED_FLOW_ID = 'flow-old-door';
const BOT_PERMISSIONS: readonly PermissionsString[] = ['ManageChannels', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'];

const discord = new TestDiscord();
const handling: Promise<void>[] = [];
const migrator = new Migrator({ db: database, provider: new FileMigrationProvider() });

async function migrateOrThrow(run: Promise<{ error?: unknown }>): Promise<void> {
    const { error } = await run;
    if (error) throw error;
}

/** Button Click "I agree" in `rules`, as the old block held it, then a line in `lounge`. */
function oldGraph(rules: ServerChannel, lounge: ServerChannel): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            {
                id: 'agree',
                type: TRIGGER_BUTTON_CLICK,
                position: { x: 0, y: 0 },
                data: { channelId: rules.id, label: 'I agree', style: 'Success' },
            },
            {
                id: 'say',
                type: ACTION_SEND_MESSAGE,
                position: { x: 0, y: 100 },
                data: { channelId: lounge.id, message: 'consent noted' },
            },
        ],
        edges: [{ id: 'e1', source: 'agree', target: 'say' }],
    };
}

/** Button Click "Knock" in `attic`, as the old block held it, then a line in `attic` that must never be said. */
function retiredGraph(attic: ServerChannel): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            {
                id: 'knock',
                type: TRIGGER_BUTTON_CLICK,
                position: { x: 0, y: 0 },
                data: { channelId: attic.id, label: 'Knock', style: 'Primary' },
            },
            {
                id: 'answer',
                type: ACTION_SEND_MESSAGE,
                position: { x: 0, y: 100 },
                data: { channelId: attic.id, message: 'who goes there' },
            },
        ],
        edges: [{ id: 'e1', source: 'knock', target: 'answer' }],
    };
}

/** `member` pressing `customId` under `messageId` in `channel`, once the registry has answered it. */
async function press(channel: ServerChannel, member: ServerMember, customId: string, messageId: string): Promise<ServerInteraction> {
    const interaction = channel.pressButton({ by: member, messageId, customId });
    await Promise.all(handling.splice(0));
    return interaction;
}

/** Every request the bot sent since `from`. */
function requestsSince(from: number): readonly RecordedRequest[] {
    return discord.requests.slice(from);
}

function isMessagePost(request: RecordedRequest): boolean {
    return request.method === 'POST' && /^\/channels\/\d+\/messages$/.test(request.path);
}

interface Scenario {
    readonly guild: ServerGuild;
    readonly rules: ServerChannel;
    readonly lounge: ServerChannel;
    readonly messageId: string;
    readonly attic: ServerChannel;
    /** The old door's message, posted with no `flow_button_messages` row. */
    readonly retiredMessageId: string;
}

/** The bot's own client posting `content` with one `flow:` button, as Deploy did. */
async function postAsDeploy(guild: ServerGuild, into: ServerChannel, content: string, customId: string, label: string): Promise<string> {
    const channel = discord.clientGuild(guild).channels.cache.get(into.id);
    if (!channel?.isSendable()) throw new Error(`#${into.name} is not sendable.`);
    const posted = await channel.send({
        content,
        components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(ButtonStyle.Success)
            ),
        ],
        allowedMentions: { parse: [] },
    });
    discord.flushGateway();
    return posted.id;
}

/**
 * A guild where Deploy posted the welcome flow's button, then the migration: the old flow,
 * the old message the bot sent through its own client, and the row that recorded it. Beside
 * it, the old door: a flow whose button Deploy posted before the table existed, so nothing
 * recorded it and the migration empties its trigger.
 */
async function migratedWorld(): Promise<Scenario> {
    const guild = discord.createGuild({ bot: { permissions: BOT_PERMISSIONS } });
    const rules = guild.createTextChannel({ name: 'rules' });
    const lounge = guild.createTextChannel({ name: 'lounge' });
    const attic = guild.createTextChannel({ name: 'attic' });
    discord.flushGateway();

    await migrateOrThrow(migrator.migrateTo(BEFORE));
    await sql`
        INSERT INTO flows (flow_id, guild_id, name, enabled, graph)
        VALUES (${FLOW_ID}, ${guild.id}, 'Welcome', 1, ${JSON.stringify(oldGraph(rules, lounge))})
    `.execute(database);
    await sql`
        INSERT INTO flows (flow_id, guild_id, name, enabled, graph)
        VALUES (${RETIRED_FLOW_ID}, ${guild.id}, 'Old door', 1, ${JSON.stringify(retiredGraph(attic))})
    `.execute(database);

    const messageId = await postAsDeploy(guild, rules, '**Welcome**', buildFlowCustomId(FLOW_ID, 'agree'), 'I agree');
    await sql`
        INSERT INTO flow_button_messages (guild_id, flow_id, channel_id, message_id, node_ids)
        VALUES (${guild.id}, ${FLOW_ID}, ${rules.id}, ${messageId}, ${JSON.stringify(['agree'])})
    `.execute(database);
    const retiredMessageId = await postAsDeploy(guild, attic, '**Old door**', buildFlowCustomId(RETIRED_FLOW_ID, 'knock'), 'Knock');

    await migrateOrThrow(migrator.migrateToLatest());
    return { guild, rules, lounge, messageId, attic, retiredMessageId };
}

async function migratedJourney(scenario: Scenario): Promise<JourneyDeclaration> {
    const row = await journeysRepo.getByKey(scenario.guild.id, FLOW_ID);
    if (!row) throw new Error('The migration made no journey for the welcome flow.');
    return { journeyKey: row.journeyKey, name: row.name, resources: row.resources };
}

let warnings: MockInstance<typeof console.warn>;

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await migrateTestDatabase();
    await initFlows();
    DISCORD_CLIENT.on(Events.InteractionCreate, (interaction: Interaction) => {
        handling.push(interactionsRegistry.handleInteraction(interaction));
    });
    await discord.start({ client: DISCORD_CLIENT });
}, 30_000);

afterAll(async () => {
    resetFlowRunSchedulerForTests();
    for (const event of [Events.ClientReady, Events.InteractionCreate, Events.MessageReactionAdd, Events.GuildMemberAdd, Events.GuildMemberRemove] as const) {
        DISCORD_CLIENT.removeAllListeners(event);
    }
    vi.restoreAllMocks();
    await discord.destroy();
});

describe('a converted journey, Install → Drift → Repair, on what Deploy left', () => {
    let scenario: Scenario;

    beforeAll(async () => {
        scenario = await migratedWorld();
    });

    /**
     * Answer 7's other half: a trigger no row names is emptied, but a button Deploy posted for
     * it before the table existed is still in its channel. Through the bridge it answers that
     * it is retired — not "Something went wrong" from a run that cannot parse its trigger —
     * runs nothing, and is logged with its flow and node so a mod can find the message.
     */
    it('answers a flow: press on a trigger the migration emptied that the button is retired, running nothing', async () => {
        const { guild, attic, retiredMessageId } = scenario;
        const member = guild.createMember({ username: 'late_knocker' });
        warnings.mockClear();

        const pressed = await press(attic, member, buildFlowCustomId(RETIRED_FLOW_ID, 'knock'), retiredMessageId);

        expect(pressed.responses).toEqual([{ kind: 'ephemeralReply', content: RETIRED_BUTTON_MESSAGE }]);
        discord.flushGateway();
        expect(attic.messages.map((message) => message.id)).toEqual([retiredMessageId]);
        expect(warnings.mock.calls.map((call) => String(call[0]))).toContainEqual(
            expect.stringContaining(`flow ${RETIRED_FLOW_ID}, node knock, message ${retiredMessageId}`)
        );
    });

    it('adopts the channel and reuses the message, then repairs that same message into an mbtn: button a press runs the flow from', async () => {
        const { guild, rules, lounge, messageId } = scenario;
        const journey = await migratedJourney(scenario);
        expect(journey.resources.map((resource) => `${resource.kind} ${resource.key}`)).toEqual([
            'textChannel welcome-channel',
            'message welcome',
        ]);
        const liveGuild = discord.clientGuild(guild);
        const member = guild.createMember({ username: 'eager_sub' });

        // Before anything: the old `flow:` button still runs the converted node, through the bridge.
        const bridged = await press(rules, member, buildFlowCustomId(FLOW_ID, 'agree'), messageId);
        expect(bridged.responses).toEqual([{ kind: 'deferUpdate' }]);
        expect(lounge.messages.map((message) => message.content)).toEqual(['consent noted']);

        // Install: the channel is adopted and the message reused — nothing is posted.
        const plan = await previewInstall({ guild: liveGuild, journey, staffRoleIds: [] });
        expect(plan.items.map((item) => `${item.resourceKey} ${item.action}`)).toEqual(['welcome-channel adopt', 'welcome reuse']);
        const beforeInstall = discord.requests.length;
        const installed = await installJourney({ guild: liveGuild, journey, staffRoleIds: [], approvedPlan: plan });
        expect(installed.failure).toBeUndefined();
        expect(requestsSince(beforeInstall).filter(isMessagePost)).toEqual([]);
        discord.flushGateway();
        expect(rules.messages.map((message) => message.id)).toEqual([messageId]);

        // Drift: the message is out of date — its digest is null — and nothing else is drifted.
        const drift = await previewDrift({ guild: liveGuild, journey, staffRoleIds: [] });
        expect(drift.unchecked).toEqual([]);
        expect(drift.drifted).toEqual([
            expect.objectContaining({
                resourceKey: 'welcome',
                kind: 'message',
                discordId: messageId,
                drift: [expect.objectContaining({ kind: 'outOfDate' })],
                repairable: true,
            }),
        ]);

        // Repair: one edit, of the same message, to the message button's id.
        const beforeRepair = discord.requests.length;
        const repaired = await repairDrift({ guild: liveGuild, journey, staffRoleIds: [], approvedPlan: drift, approvedKeys: new Set(['welcome']) });
        expect(repaired.refusal).toBeUndefined();
        expect(repaired.results).toEqual([expect.objectContaining({ resourceKey: 'welcome', outcome: 'repaired' })]);
        const sent = requestsSince(beforeRepair).filter((request) => request.method !== 'GET');
        expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([`PATCH /channels/${rules.id}/messages/${messageId}`]);
        discord.flushGateway();
        const message = rules.message(messageId);
        expect(message.content).toBe('**Welcome**');
        expect(message.components).toEqual([
            {
                type: ComponentType.ActionRow,
                components: [expect.objectContaining({ type: ComponentType.Button, custom_id: 'mbtn:i-agree', label: 'I agree', style: ButtonStyle.Success })],
            },
        ]);

        // Drift is clean now.
        const after = await previewDrift({ guild: liveGuild, journey, staffRoleIds: [] });
        expect(after.drifted).toEqual([]);
        expect(after.unchecked).toEqual([]);

        // A press on the repaired button runs the flow through the message's binding.
        const pressed = await press(rules, member, 'mbtn:i-agree', messageId);
        expect(pressed.responses).toEqual([{ kind: 'deferUpdate' }]);
        expect(lounge.messages.map((said) => said.content)).toEqual(['consent noted', 'consent noted']);
    });
});
