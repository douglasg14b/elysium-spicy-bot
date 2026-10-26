import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
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
    type ServerRole,
} from '../../../../shared/__tests__/support/testDiscord';
import { flowJourneyLinksRepo, installJourney, journeysRepo, previewInstall, resourceBindingsRepo } from '../../../provisioning';
import type { JourneyDeclaration } from '../../../provisioning';
import { ACTION_SEND_MESSAGE } from '../../blocks/actionSendMessage';
import { ACTION_WAIT_FOR_EVENT } from '../../blocks/actionWaitForEvent';
import { TRIGGER_BUTTON_CLICK } from '../../blocks/triggerButtonClick';
import { TRIGGER_MEMBER_JOIN } from '../../blocks/triggerMemberJoin';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../data/flowGraph';
import { flowRunsRepo } from '../../data/flowRunsRepo';
import type { FlowRunEntity } from '../../data/flowRunsSchema';
import { flowsRepo } from '../../data/flowsRepo';
import { resetFlowRunSchedulerForTests } from '../../engine/flowRunScheduler';
import { initFlows } from '../../initFlows';
import { buildFlowCustomId } from '../../utils/customId';
import { JOURNEY_UNREADABLE, LISTENER_DISABLED, LISTENERS_FIGHTING, NOTHING_HOOKED_UP } from '../messageButtonPress';

/**
 * A press on a journey message's button, end to end: the bot's own `DISCORD_CLIENT` against
 * TestDiscord, wired by the real `initFlows()`, on the real migrated schema. Each case installs
 * a journey through the real provisioning service — a channel and a message with two buttons
 * — so the message a member presses is the one install posted, and its binding is the one
 * install wrote. Presses go through the real `interactionsRegistry`, as `bot.ts` routes them.
 *
 * One guild per case, so no case's flows or parked runs reach another's.
 */

const WAIT_FOR = { timeout: 10_000 };
const JOURNEY_KEY = 'house';
const RULES_KEY = 'rules';
const PANEL_KEY = 'rules-panel';
const BOT_PERMISSIONS: readonly PermissionsString[] = ['ManageChannels', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'];

const discord = new TestDiscord();
const handling: Promise<void>[] = [];
const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

/** A channel and the rules panel in it, with two buttons: `agree` and `nope`. */
function houseJourney(): JourneyDeclaration {
    return {
        journeyKey: JOURNEY_KEY,
        name: 'House',
        resources: [
            { key: RULES_KEY, kind: 'textChannel', defaultName: 'rules' },
            {
                key: PANEL_KEY,
                kind: 'message',
                defaultName: 'Rules panel',
                parentKey: RULES_KEY,
                message: { content: 'Read these, then pick.', embeds: [] },
                buttons: [
                    { key: 'agree', label: 'I agree', style: 'Success' },
                    { key: 'nope', label: 'Nope', style: 'Danger' },
                ],
            },
        ],
    };
}

/** Button Click on the panel's `buttonKey`, gated by `gate`, then a line in `lounge` saying `said`. */
function listenerGraph(input: {
    readonly buttonKey: string;
    readonly lounge: ServerChannel;
    readonly said: string;
    readonly gate?: Record<string, unknown>;
}): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            {
                id: 'trigger',
                type: TRIGGER_BUTTON_CLICK,
                position: { x: 0, y: 0 },
                data: {
                    button: { messageKey: PANEL_KEY, buttonKey: input.buttonKey },
                    eligibility: input.gate ?? { principal: 'anyone' },
                },
            },
            {
                id: 'say',
                type: ACTION_SEND_MESSAGE,
                position: { x: 0, y: 100 },
                data: { channelId: input.lounge.id, message: input.said },
            },
        ],
        edges: [{ id: 'e1', source: 'trigger', target: 'say' }],
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

interface House {
    readonly guild: ServerGuild;
    readonly lounge: ServerChannel;
    readonly rules: ServerChannel;
    readonly panelId: string;
    readonly verified: ServerRole;
}

/** A guild with the house journey installed, a `#lounge` flows talk in, and a `Verified` role. */
async function installHouse(): Promise<House> {
    const guild = discord.createGuild({ bot: { permissions: BOT_PERMISSIONS } });
    const lounge = guild.createTextChannel({ name: 'lounge' });
    const verified = guild.createRole({ name: 'Verified' });
    const journey = houseJourney();
    await journeysRepo.create({ guildId: guild.id, journeyKey: JOURNEY_KEY, name: journey.name, resources: journey.resources });

    const liveGuild = discord.clientGuild(guild);
    const approvedPlan = await previewInstall({ guild: liveGuild, journey, staffRoleIds: [] });
    const result = await installJourney({ guild: liveGuild, journey, staffRoleIds: [], approvedPlan });
    expect(result.failure).toBeUndefined();
    discord.flushGateway();

    const boundId = (key: string): string => {
        const applied = result.applied.find((entry) => entry.resourceKey === key);
        if (!applied) throw new Error(`The install bound nothing to "${key}".`);
        return applied.discordId;
    };
    return { guild, lounge, rules: guild.channel(boundId(RULES_KEY)), panelId: boundId(PANEL_KEY), verified };
}

/** A flow in the house journey, as the dashboard would leave one: linked, and on unless said. */
async function houseFlow(house: House, name: string, graph: FlowGraph, enabled = true): Promise<string> {
    const flow = await flowsRepo.create({ guildId: house.guild.id, name, graph, enabled });
    await flowJourneyLinksRepo.attach({ guildId: house.guild.id, flowId: flow.flowId, journeyKey: JOURNEY_KEY });
    return flow.flowId;
}

/** `member` pressing `customId` under `messageId` in `channel`, once the registry has answered it. */
async function press(
    channel: ServerChannel,
    member: ServerMember,
    customId: string,
    messageId: string
): Promise<ServerInteraction> {
    const interaction = channel.pressButton({ by: member, messageId, customId });
    await Promise.all(handling.splice(0));
    return interaction;
}

function pressPanel(house: House, member: ServerMember, buttonKey: string): Promise<ServerInteraction> {
    return press(house.rules, member, `mbtn:${buttonKey}`, house.panelId);
}

function said(house: House): string[] {
    return house.lounge.messages.map((message) => message.content);
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

describe('a press on a journey message’s button', () => {
    it('runs the one flow listening to it, closed with a deferred update and no reply; its other button is hooked up to nothing', async () => {
        const house = await installHouse();
        await houseFlow(house, 'Welcome', listenerGraph({ buttonKey: 'agree', lounge: house.lounge, said: 'consent noted' }));
        const member = house.guild.createMember({ username: 'eager_sub' });

        const agreed = await pressPanel(house, member, 'agree');
        expect(agreed.responses).toEqual([{ kind: 'deferUpdate' }]);
        expect(said(house)).toEqual(['consent noted']);

        const refused = await pressPanel(house, member, 'nope');
        expect(refused.responses).toEqual([{ kind: 'ephemeralReply', content: NOTHING_HOOKED_UP }]);
        expect(said(house)).toEqual(['consent noted']);
    });

    it('says the flow is disabled when only a switched-off flow listens, and runs nothing', async () => {
        const house = await installHouse();
        await houseFlow(house, 'Welcome', listenerGraph({ buttonKey: 'agree', lounge: house.lounge, said: 'consent noted' }), false);
        const member = house.guild.createMember({ username: 'too_early' });

        const pressed = await pressPanel(house, member, 'agree');

        expect(pressed.responses).toEqual([{ kind: 'ephemeralReply', content: LISTENER_DISABLED }]);
        expect(said(house)).toEqual([]);
    });

    it('runs neither of two live flows on one button, says they are fighting, and logs both', async () => {
        const house = await installHouse();
        // Written straight to the database: going live and grouping would both refuse the second.
        const first = await houseFlow(house, 'Welcome', listenerGraph({ buttonKey: 'agree', lounge: house.lounge, said: 'from welcome' }));
        const second = await houseFlow(house, 'Gatekeeper', listenerGraph({ buttonKey: 'agree', lounge: house.lounge, said: 'from gatekeeper' }));
        const member = house.guild.createMember({ username: 'caught_between' });
        errors.mockClear();

        const pressed = await pressPanel(house, member, 'agree');

        expect(pressed.responses).toEqual([{ kind: 'ephemeralReply', content: LISTENERS_FIGHTING }]);
        expect(said(house)).toEqual([]);
        const logged = errors.mock.calls.map((call) => String(call[0])).join('\n');
        expect(logged).toContain(first);
        expect(logged).toContain(second);
    });

    it('hooks a message whose record was forgotten up to nothing, whoever listened', async () => {
        const house = await installHouse();
        await houseFlow(house, 'Welcome', listenerGraph({ buttonKey: 'agree', lounge: house.lounge, said: 'consent noted' }));
        const row = await resourceBindingsRepo.get(house.guild.id, JOURNEY_KEY, PANEL_KEY);
        expect(await resourceBindingsRepo.forget(row!.id)).toBe(true);
        const member = house.guild.createMember({ username: 'forgotten' });

        const pressed = await pressPanel(house, member, 'agree');

        expect(pressed.responses).toEqual([{ kind: 'ephemeralReply', content: NOTHING_HOOKED_UP }]);
        expect(said(house)).toEqual([]);
    });

    it('never runs another journey’s flow naming the same keys', async () => {
        const house = await installHouse();
        await journeysRepo.create({ guildId: house.guild.id, journeyKey: 'annex', name: 'Annex', resources: [] });
        const stranger = await flowsRepo.create({
            guildId: house.guild.id,
            name: 'Annex door',
            graph: listenerGraph({ buttonKey: 'nope', lounge: house.lounge, said: 'wrong house' }),
            enabled: true,
        });
        await flowJourneyLinksRepo.attach({ guildId: house.guild.id, flowId: stranger.flowId, journeyKey: 'annex' });
        const member = house.guild.createMember({ username: 'wrong_door' });

        const pressed = await pressPanel(house, member, 'nope');

        expect(pressed.responses).toEqual([{ kind: 'ephemeralReply', content: NOTHING_HOOKED_UP }]);
        expect(said(house)).toEqual([]);
    });
});

describe('the gate and the wake', () => {
    /** The house, a flow on `agree` admitting only Verified members, and a waiting room every joiner parks in. */
    async function gatedHouse(enabled: boolean) {
        const house = await installHouse();
        await houseFlow(
            house,
            'Welcome',
            listenerGraph({
                buttonKey: 'agree',
                lounge: house.lounge,
                said: 'consent noted',
                gate: { principal: 'roles', roleIds: [house.verified.id] },
            }),
            enabled
        );
        const waitingRoom = await flowsRepo.create({ guildId: house.guild.id, name: 'Waiting room', graph: waitingRoomGraph(house.lounge), enabled: true });
        return { house, waitingRoomId: waitingRoom.flowId };
    }

    it('turns away a member the gate refuses, runs nothing, and leaves their parked button-click wait parked', async () => {
        const { house, waitingRoomId } = await gatedHouse(true);
        const stranger = house.guild.createMember({ username: 'unverified_brat' });
        const waiting = await parkedWait(waitingRoomId, stranger);

        const pressed = await pressPanel(house, stranger, 'agree');

        expect(pressed.responses).toEqual([
            { kind: 'ephemeralReply', content: expect.stringMatching(/^🚫 /) as unknown as string },
        ]);
        expect(said(house)).toEqual([]);
        expect(await statusOf(waiting)).toBe('suspended');
    });

    it('wakes the parked wait of a member the gate admits, and runs the flow', async () => {
        const { house, waitingRoomId } = await gatedHouse(true);
        const member = house.guild.createMember({ username: 'verified_good_pet', roles: [house.verified] });
        const waiting = await parkedWait(waitingRoomId, member);

        const pressed = await pressPanel(house, member, 'agree');

        expect(pressed.responses).toEqual([{ kind: 'deferUpdate' }]);
        await vi.waitFor(async () => expect(await statusOf(waiting)).toBe('completed'), WAIT_FOR);
        expect(said(house).sort()).toEqual(['consent noted', 'woke verified_good_pet']);
    });

    it('lets a switched-off listener’s gate still decide the wake (review item 7)', async () => {
        const { house, waitingRoomId } = await gatedHouse(false);
        const stranger = house.guild.createMember({ username: 'still_unverified' });
        const member = house.guild.createMember({ username: 'verified_but_early', roles: [house.verified] });
        const strangerWait = await parkedWait(waitingRoomId, stranger);
        const memberWait = await parkedWait(waitingRoomId, member);

        const refused = await pressPanel(house, stranger, 'agree');
        expect(refused.responses).toEqual([{ kind: 'ephemeralReply', content: LISTENER_DISABLED }]);
        expect(await statusOf(strangerWait)).toBe('suspended');

        const admitted = await pressPanel(house, member, 'agree');
        expect(admitted.responses).toEqual([{ kind: 'ephemeralReply', content: LISTENER_DISABLED }]);
        await vi.waitFor(async () => expect(await statusOf(memberWait)).toBe('completed'), WAIT_FOR);
        expect(said(house)).toEqual(['woke verified_but_early']);
    });

    it('wakes the presser’s wait when nothing listens: there is no gate to ask', async () => {
        const { house, waitingRoomId } = await gatedHouse(true);
        const member = house.guild.createMember({ username: 'pressing_anything' });
        const waiting = await parkedWait(waitingRoomId, member);

        const pressed = await pressPanel(house, member, 'nope');

        expect(pressed.responses).toEqual([{ kind: 'ephemeralReply', content: NOTHING_HOOKED_UP }]);
        await vi.waitFor(async () => expect(await statusOf(waiting)).toBe('completed'), WAIT_FOR);
    });

    it('wakes the presser’s wait on a message whose record was forgotten, whoever’s gate listened', async () => {
        const { house, waitingRoomId } = await gatedHouse(true);
        const row = await resourceBindingsRepo.get(house.guild.id, JOURNEY_KEY, PANEL_KEY);
        expect(await resourceBindingsRepo.forget(row!.id)).toBe(true);
        const stranger = house.guild.createMember({ username: 'unverified_but_forgotten' });
        const waiting = await parkedWait(waitingRoomId, stranger);

        const pressed = await pressPanel(house, stranger, 'agree');

        expect(pressed.responses).toEqual([{ kind: 'ephemeralReply', content: NOTHING_HOOKED_UP }]);
        await vi.waitFor(async () => expect(await statusOf(waiting)).toBe('completed'), WAIT_FOR);
        expect(said(house)).toEqual(['woke unverified_but_forgotten']);
    });

    it('wakes nothing when either of two fighting flows’ gates refuses the presser', async () => {
        const { house, waitingRoomId } = await gatedHouse(true);
        // A second live listener on `agree`, letting anyone in: the Verified gate still refuses.
        await houseFlow(house, 'Open door', listenerGraph({ buttonKey: 'agree', lounge: house.lounge, said: 'open door' }));
        const stranger = house.guild.createMember({ username: 'caught_unverified' });
        const waiting = await parkedWait(waitingRoomId, stranger);

        const pressed = await pressPanel(house, stranger, 'agree');

        expect(pressed.responses).toEqual([{ kind: 'ephemeralReply', content: LISTENERS_FIGHTING }]);
        expect(said(house)).toEqual([]);
        expect(await statusOf(waiting)).toBe('suspended');
    });

    it('asks only the live listener’s gate when a switched-off flow names the same button', async () => {
        const house = await installHouse();
        await houseFlow(house, 'Open door', listenerGraph({ buttonKey: 'agree', lounge: house.lounge, said: 'open door' }));
        await houseFlow(
            house,
            'Old gate',
            listenerGraph({
                buttonKey: 'agree',
                lounge: house.lounge,
                said: 'old gate',
                gate: { principal: 'roles', roleIds: [house.verified.id] },
            }),
            false
        );
        const waitingRoom = await flowsRepo.create({ guildId: house.guild.id, name: 'Waiting room', graph: waitingRoomGraph(house.lounge), enabled: true });
        const stranger = house.guild.createMember({ username: 'walks_right_in' });
        const waiting = await parkedWait(waitingRoom.flowId, stranger);

        const pressed = await pressPanel(house, stranger, 'agree');

        expect(pressed.responses).toEqual([{ kind: 'deferUpdate' }]);
        await vi.waitFor(async () => expect(await statusOf(waiting)).toBe('completed'), WAIT_FOR);
        expect(said(house).sort()).toEqual(['open door', 'woke walks_right_in']);
    });

    it('logs a switched-off listener’s unreadable gate, naming its flow and node, and wakes nothing', async () => {
        const house = await installHouse();
        const flowId = await houseFlow(
            house,
            'Broken gate',
            listenerGraph({ buttonKey: 'agree', lounge: house.lounge, said: 'never', gate: { principal: 'nobody-knows' } }),
            false
        );
        const waitingRoom = await flowsRepo.create({ guildId: house.guild.id, name: 'Waiting room', graph: waitingRoomGraph(house.lounge), enabled: true });
        const member = house.guild.createMember({ username: 'pressing_a_broken_lock' });
        const waiting = await parkedWait(waitingRoom.flowId, member);
        errors.mockClear();

        const pressed = await pressPanel(house, member, 'agree');

        // The presser hears the press's answer; the broken rule is the log's to tell.
        expect(pressed.responses).toEqual([{ kind: 'ephemeralReply', content: LISTENER_DISABLED }]);
        expect(await statusOf(waiting)).toBe('suspended');
        expect(errors.mock.calls.map((call) => String(call[0]))).toContain(
            `[flows] A button press found an unreadable eligibility rule — flow ${flowId}, node trigger.`
        );
    });

    it('says the journey is broken, runs nothing and wakes nothing when its row cannot be read', async () => {
        const { house, waitingRoomId } = await gatedHouse(true);
        const member = house.guild.createMember({ username: 'verified_but_stuck', roles: [house.verified] });
        const waiting = await parkedWait(waitingRoomId, member);
        // What a hand edit or an older schema could leave: resources that are not a list.
        await database
            .updateTable('journeys')
            .set({ resources: JSON.stringify({ broken: true }) })
            .where('guildId', '=', house.guild.id)
            .where('journeyKey', '=', JOURNEY_KEY)
            .execute();
        errors.mockClear();

        const pressed = await pressPanel(house, member, 'agree');

        expect(pressed.responses).toEqual([{ kind: 'ephemeralReply', content: JOURNEY_UNREADABLE }]);
        expect(said(house)).toEqual([]);
        expect(await statusOf(waiting)).toBe('suspended');
        expect(errors.mock.calls.map((call) => String(call[0])).join('\n')).toContain(`journey "${JOURNEY_KEY}"`);
    });
});

describe('the flow: bridge', () => {
    it('still runs a converted node from an old flow: button, and logs the press', async () => {
        const house = await installHouse();
        const flowId = await houseFlow(house, 'Welcome', listenerGraph({ buttonKey: 'agree', lounge: house.lounge, said: 'bridged' }));
        // What the retired Deploy left in the channel: a message carrying a `flow:` button.
        const channel = discord.clientGuild(house.guild).channels.cache.get(house.rules.id);
        if (!channel?.isSendable()) throw new Error('The rules channel is not sendable.');
        const customId = buildFlowCustomId(flowId, 'trigger');
        const old = await channel.send({
            content: '**Welcome**',
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(customId).setLabel('I agree').setStyle(ButtonStyle.Success)
                ),
            ],
        });
        discord.flushGateway();
        const member = house.guild.createMember({ username: 'old_school' });
        info.mockClear();

        const pressed = await press(house.rules, member, customId, old.id);

        expect(pressed.responses).toEqual([{ kind: 'deferUpdate' }]);
        expect(said(house)).toEqual(['bridged']);
        expect(info.mock.calls.map((call) => String(call[0]))).toContain(
            `[flows] flow: bridge press — flow ${flowId}, node trigger, message ${old.id}, channel ${house.rules.id}`
        );
    });
});

describe('Deploy is gone', () => {
    /** A source file of the boot path, read as text. */
    function source(...segments: string[]): string {
        return readFileSync(join(dirname(fileURLToPath(import.meta.url)), ...segments), 'utf8');
    }

    it('leaves /flow-deploy out of the slash commands the bot registers with Discord', () => {
        // `bot.ts` hands this list to `registerCommandsWithDiscord`, which PUTs the full global
        // list, so a command missing from it leaves Discord on the next boot. `initFlows` has run.
        const names = interactionsRegistry
            .getSlashCommandBuilders()
            .map((builder) => ('name' in builder ? builder.name : undefined));
        expect(names).not.toContain('flow-deploy');

        // `initFlows` now registers no slash command at all, so the list above is empty here and
        // cannot fail on its own. What carries the proof is that nothing on the boot path still
        // names the command or its builder.
        for (const file of [source('..', '..', 'initFlows.ts'), source('..', '..', 'index.ts'), source('..', '..', '..', '..', 'bot.ts')]) {
            expect(file).not.toMatch(/flow-deploy|flowDeploy/i);
        }
    });
});
