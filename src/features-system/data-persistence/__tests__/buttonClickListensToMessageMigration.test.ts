import { Migrator, sql } from 'kysely';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureBlocksDiscovered } from '../../../features/flows/blocks/registry';
import type { FlowGraph, FlowNode } from '../../../features/flows/data/flowGraph';
import { flowReadinessIssues } from '../../../features/flows/logic/flowReadiness';
import { messageResourceProblems } from '../../../features/provisioning/logic/messageResourceProblems';
import {
    validateJourneyDeclaration,
    type ResourceDeclaration,
} from '../../../features/provisioning/logic/resourceDeclaration';
import { declarationsRefusal, JourneyUpdateSchema } from '../../../web/api/journeyBody';
import { database } from '../database';
import { FileMigrationProvider } from '../fileMigrationProvider';
import { up as buttonClickListensToMessage } from '../migrations/2026-10-26-Button_Click_Listens_To_Message';
import { migrateTestDatabase } from './support/migrateTestDatabase';

/**
 * `2026-10-26-Button_Click_Listens_To_Message` on SQLite, through a real `Migrator` on the
 * production `database` stack, after the pattern of `postEmbedMessageShapeMigration.test.ts`
 * (`docs/plans/message-resource-step-3.md`, slice C's proof).
 *
 * The old world is seeded with raw SQL after migrating down to the migration before: Button
 * Click nodes owning their own button, the `flow_button_messages` rows the retired Deploy
 * wrote, and the journeys, links and bindings around them. Two guilds:
 *
 *  - **Guild one**, the single-flow cases: a live flow with two buttons in one channel (a raw
 *    snowflake), one in another (a sidecar naming a declared, bound channel), a node no row
 *    names, and a draft with a changed button and a draft-only one; an off flow with no
 *    journey and a label holding a token; a flow on a shared journey whose channel is bound
 *    under a key no longer declared, and whose message's slug is a stale binding's key; a flow
 *    with an older and a newer post in one channel, a post in a second channel naming the
 *    same node, and a post naming only a deleted node; a post whose flow is gone; and a
 *    journey nothing touches.
 *  - **Guild two**, the merge cases (Douglas's answer 1): two journey-less flows in one
 *    channel; a flow on a fallback journey and a journey-less one in one channel; two flows on
 *    different journeys in one channel (the hazard); three flows joined transitively through
 *    one that posted into two channels; and a flow linked to a journey that is gone.
 *
 * What the migration writes is then held to the **live** rules: `validateJourneyDeclaration`,
 * `messageResourceProblems`, the journey PUT's request schema (which must hand every resource
 * back unchanged), and `flowReadinessIssues` for every converted flow.
 *
 * Postgres is not covered here: CI runs SQLite only. It was run by hand against a throwaway
 * `postgres:16` — see the slice C report.
 */

const BEFORE = '2026-10-25-Resource_Binding_Message_Post';
const OLD_VERSION = '2026-10-01T00:00:00.000Z';
const BUTTON_CLICK = 'trigger.buttonClick';

const GUILD_ONE = '900000000000000001';
const GUILD_TWO = '900000000000000002';
const ROLE = '1300000000000000001';
const GATE = { principal: 'roles', roleIds: [ROLE] };

const CHANNEL = {
    rules: '1100000000000000001',
    verify: '1100000000000000002',
    off: '1100000000000000003',
    lobby: '1100000000000000004',
    twice: '1100000000000000005',
    also: '1100000000000000006',
    pager: '2100000000000000001',
    rope: '2100000000000000002',
    tease: '2100000000000000003',
    vanillaP: '2100000000000000004',
    vanillaQ: '2100000000000000005',
    yieldRoom: '2100000000000000006',
} as const;

const MESSAGE = {
    welcome: '1200000000000000001',
    verify: '1200000000000000002',
    off: '1200000000000000003',
    lobby: '1200000000000000004',
    also: '1200000000000000005',
    twiceOld: '1200000000000000006',
    twiceNew: '1200000000000000007',
    ghost: '1200000000000000008',
    gone: '1200000000000000009',
    pager: '2200000000000000001',
    queue: '2200000000000000002',
    rope: '2200000000000000003',
    silk: '2200000000000000004',
    tease: '2200000000000000005',
    undo: '2200000000000000006',
    vanillaP: '2200000000000000007',
    vanillaQ: '2200000000000000008',
    wax: '2200000000000000009',
    xtra: '2200000000000000010',
    yieldPost: '2200000000000000011',
} as const;

const migrator = new Migrator({ db: database, provider: new FileMigrationProvider() });

async function migrateOrThrow(run: Promise<{ error?: unknown }>): Promise<void> {
    const { error } = await run;
    if (error) throw error;
}

function node(id: string, type: string, data: Record<string, unknown>): FlowNode {
    return { id, type, position: { x: 0, y: 0 }, data };
}

function button(id: string, data: Record<string, unknown>): FlowNode {
    return node(id, BUTTON_CLICK, data);
}

function graphOf(nodes: FlowNode[]): FlowGraph {
    return { version: 1, nodes, edges: [] };
}

const SAY = node('say', 'action.sendMessage', { channelId: CHANNEL.rules, message: 'Behave.' });

/** Every Button Click as it stood, by flow. */
const OLD = {
    welcome: [
        button('b1', { channelId: CHANNEL.rules, label: 'I agree', style: 'Success', eligibility: GATE }),
        button('b2', { channelId: CHANNEL.rules, label: 'Nope', style: 'Danger' }),
        button('b3', { channelId: '', channelIdKey: 'verify-room', label: 'Verify me', style: 'Primary' }),
        button('b4', { channelId: CHANNEL.rules, label: 'Never posted', style: 'Secondary' }),
        SAY,
    ],
    off: [button('x1', { channelId: CHANNEL.off, label: 'Tap {{me}}' })],
    shared: [button('g1', { channelId: CHANNEL.lobby, label: 'Hello', style: 'Secondary' })],
    helper: [SAY],
    twice: [button('t1', { channelId: CHANNEL.twice, label: 'Again', style: 'Primary' })],
    pager: [button('p1', { channelId: CHANNEL.pager, label: 'Page me', style: 'Primary' })],
    queue: [button('q1', { channelId: CHANNEL.pager, label: 'Queue up', style: 'Success' })],
    rope: [button('r1', { channelId: CHANNEL.rope, label: 'Tie me', style: 'Danger' })],
    silk: [button('s1', { channelId: CHANNEL.rope, label: 'Untie me', style: 'Secondary' })],
    tease: [button('te1', { channelId: CHANNEL.tease, label: 'Tease', style: 'Primary' })],
    undo: [button('u1', { channelId: CHANNEL.tease, label: 'Undo', style: 'Danger' })],
    vanilla: [
        button('v1', { channelId: CHANNEL.vanillaP, label: 'Plain', style: 'Primary' }),
        button('v2', { channelId: CHANNEL.vanillaQ, label: 'Simple', style: 'Secondary' }),
    ],
    wax: [button('w1', { channelId: CHANNEL.vanillaP, label: 'Drip', style: 'Danger' })],
    xtra: [button('xt1', { channelId: CHANNEL.vanillaQ, label: 'More', style: 'Success' })],
    yieldFlow: [button('y1', { channelId: CHANNEL.yieldRoom, label: 'Yield', style: 'Primary' })],
} as const;

/** The live welcome flow's draft: b1 relabelled, and a Button Click only the draft has. */
const OLD_DRAFT = [
    button('b1', { channelId: CHANNEL.rules, label: 'I agree!!', style: 'Success', eligibility: GATE }),
    button('b2', { channelId: CHANNEL.rules, label: 'Nope', style: 'Danger' }),
    button('b3', { channelId: '', channelIdKey: 'verify-room', label: 'Verify me', style: 'Primary' }),
    button('b4', { channelId: CHANNEL.rules, label: 'Never posted', style: 'Secondary' }),
    button('d9', { channelId: CHANNEL.rules, label: 'Draft only', style: 'Primary' }),
    SAY,
];

async function insertFlow(guildId: string, flowId: string, name: string, enabled: boolean, nodes: readonly FlowNode[]): Promise<void> {
    await sql`
        INSERT INTO flows (flow_id, guild_id, name, enabled, graph)
        VALUES (${flowId}, ${guildId}, ${name}, ${enabled ? 1 : 0}, ${JSON.stringify(graphOf([...nodes]))})
    `.execute(database);
}

async function insertJourney(
    guildId: string,
    journeyKey: string,
    name: string,
    resources: readonly ResourceDeclaration[],
    createdForFlowId: string | null
): Promise<void> {
    await sql`
        INSERT INTO journeys (journey_key, guild_id, name, resources, created_for_flow_id, created_at, updated_at)
        VALUES (${journeyKey}, ${guildId}, ${name}, ${JSON.stringify(resources)}, ${createdForFlowId}, ${OLD_VERSION}, ${OLD_VERSION})
    `.execute(database);
}

async function insertLink(guildId: string, flowId: string, journeyKey: string): Promise<void> {
    await sql`INSERT INTO flow_journey_links (guild_id, flow_id, journey_key) VALUES (${guildId}, ${flowId}, ${journeyKey})`.execute(
        database
    );
}

async function insertBinding(row: {
    readonly guildId: string;
    readonly ownerKey: string;
    readonly resourceKey: string;
    readonly kind: string;
    readonly state: string;
    readonly discordId: string;
    readonly name: string;
}): Promise<void> {
    await sql`
        INSERT INTO resource_bindings (guild_id, owner_kind, owner_key, resource_key, kind, state, discord_id, name)
        VALUES (${row.guildId}, 'journey', ${row.ownerKey}, ${row.resourceKey}, ${row.kind}, ${row.state}, ${row.discordId}, ${row.name})
    `.execute(database);
}

async function insertPost(guildId: string, flowId: string, channelId: string, messageId: string, nodeIds: readonly string[]): Promise<void> {
    await sql`
        INSERT INTO flow_button_messages (guild_id, flow_id, channel_id, message_id, node_ids)
        VALUES (${guildId}, ${flowId}, ${channelId}, ${messageId}, ${JSON.stringify(nodeIds)})
    `.execute(database);
}

/** The old world, in insertion order — which is `flows.id` and `flow_button_messages.id` order. */
async function seedOldWorld(): Promise<void> {
    // --- Guild one.
    await insertFlow(GUILD_ONE, 'flow-welcome', 'Welcome', true, OLD.welcome);
    await insertFlow(GUILD_ONE, 'flow-off', 'Off duty', false, OLD.off);
    await insertFlow(GUILD_ONE, 'flow-shared', 'Lobby greeter', true, OLD.shared);
    await insertFlow(GUILD_ONE, 'flow-helper', 'Lobby helper', true, OLD.helper);
    await insertFlow(GUILD_ONE, 'flow-twice', 'Double tap', true, OLD.twice);

    await insertJourney(GUILD_ONE, 'welcome-journey', 'Welcome journey', [{ key: 'verify-room', kind: 'textChannel', defaultName: 'verify-room' }], 'flow-welcome');
    await insertLink(GUILD_ONE, 'flow-welcome', 'welcome-journey');
    await insertBinding({ guildId: GUILD_ONE, ownerKey: 'welcome-journey', resourceKey: 'verify-room', kind: 'textChannel', state: 'created', discordId: CHANNEL.verify, name: 'verify-room' });

    await insertJourney(GUILD_ONE, 'lobby', 'Lobby', [], null);
    await insertLink(GUILD_ONE, 'flow-shared', 'lobby');
    await insertLink(GUILD_ONE, 'flow-helper', 'lobby');
    // Bound, and no longer declared: the channel is declared again under this key.
    await insertBinding({ guildId: GUILD_ONE, ownerKey: 'lobby', resourceKey: 'old-lobby', kind: 'textChannel', state: 'adopted', discordId: CHANNEL.lobby, name: 'old-lobby' });
    // A stale binding under the key the message would otherwise take.
    await insertBinding({ guildId: GUILD_ONE, ownerKey: 'lobby', resourceKey: 'lobby-greeter', kind: 'role', state: 'adopted', discordId: '1300000000000000009', name: 'Greeter' });

    await insertJourney(GUILD_ONE, 'bystander', 'Bystander', [{ key: 'bystander-room', kind: 'textChannel', defaultName: 'bystander-room' }], null);

    await sql`
        INSERT INTO flow_drafts (flow_id, guild_id, author_id, author_name, name, graph, base_updated_at)
        VALUES ('flow-welcome', ${GUILD_ONE}, 'user-1', 'domme', 'Welcome', ${JSON.stringify(graphOf([...OLD_DRAFT]))}, '2026-10-20T12:00:00.000Z')
    `.execute(database);

    await insertPost(GUILD_ONE, 'flow-welcome', CHANNEL.rules, MESSAGE.welcome, ['b1', 'b2']);
    await insertPost(GUILD_ONE, 'flow-welcome', CHANNEL.verify, MESSAGE.verify, ['b3']);
    await insertPost(GUILD_ONE, 'flow-off', CHANNEL.off, MESSAGE.off, ['x1']);
    await insertPost(GUILD_ONE, 'flow-shared', CHANNEL.lobby, MESSAGE.lobby, ['g1']);
    await insertPost(GUILD_ONE, 'flow-twice', CHANNEL.also, MESSAGE.also, ['t1']);
    await insertPost(GUILD_ONE, 'flow-twice', CHANNEL.twice, MESSAGE.twiceOld, ['t1']);
    await insertPost(GUILD_ONE, 'flow-twice', CHANNEL.twice, MESSAGE.twiceNew, ['t1']);
    await insertPost(GUILD_ONE, 'flow-twice', CHANNEL.twice, MESSAGE.ghost, ['deleted-node']);
    await insertPost(GUILD_ONE, 'flow-gone', CHANNEL.rules, MESSAGE.gone, ['n1']);

    // --- Guild two.
    await insertFlow(GUILD_TWO, 'flow-pager', 'Pager', true, OLD.pager);
    await insertFlow(GUILD_TWO, 'flow-queue', 'Queue', true, OLD.queue);
    await insertFlow(GUILD_TWO, 'flow-rope', 'Rope', true, OLD.rope);
    await insertFlow(GUILD_TWO, 'flow-silk', 'Silk', true, OLD.silk);
    await insertFlow(GUILD_TWO, 'flow-tease', 'Tease', true, OLD.tease);
    await insertFlow(GUILD_TWO, 'flow-undo', 'Undo {{it}}', true, OLD.undo);
    await insertFlow(GUILD_TWO, 'flow-vanilla', 'Vanilla', true, OLD.vanilla);
    await insertFlow(GUILD_TWO, 'flow-wax', 'Wax', true, OLD.wax);
    await insertFlow(GUILD_TWO, 'flow-xtra', 'Xtra', true, OLD.xtra);
    await insertFlow(GUILD_TWO, 'flow-yield', 'Yield', true, OLD.yieldFlow);

    // The pre-link fallback: keyed by the flow's id, no link row.
    await insertJourney(GUILD_TWO, 'flow-rope', 'Rope journey', [], 'flow-rope');
    await insertJourney(GUILD_TWO, 'tease-j', 'Tease', [], null);
    await insertLink(GUILD_TWO, 'flow-tease', 'tease-j');
    await insertJourney(GUILD_TWO, 'undo-j', 'Undo', [], null);
    await insertLink(GUILD_TWO, 'flow-undo', 'undo-j');
    await insertLink(GUILD_TWO, 'flow-yield', 'ghost-journey');

    await insertPost(GUILD_TWO, 'flow-pager', CHANNEL.pager, MESSAGE.pager, ['p1']);
    await insertPost(GUILD_TWO, 'flow-queue', CHANNEL.pager, MESSAGE.queue, ['q1']);
    await insertPost(GUILD_TWO, 'flow-rope', CHANNEL.rope, MESSAGE.rope, ['r1']);
    await insertPost(GUILD_TWO, 'flow-silk', CHANNEL.rope, MESSAGE.silk, ['s1']);
    await insertPost(GUILD_TWO, 'flow-tease', CHANNEL.tease, MESSAGE.tease, ['te1']);
    await insertPost(GUILD_TWO, 'flow-undo', CHANNEL.tease, MESSAGE.undo, ['u1']);
    await insertPost(GUILD_TWO, 'flow-vanilla', CHANNEL.vanillaP, MESSAGE.vanillaP, ['v1']);
    await insertPost(GUILD_TWO, 'flow-vanilla', CHANNEL.vanillaQ, MESSAGE.vanillaQ, ['v2']);
    await insertPost(GUILD_TWO, 'flow-wax', CHANNEL.vanillaP, MESSAGE.wax, ['w1']);
    await insertPost(GUILD_TWO, 'flow-xtra', CHANNEL.vanillaQ, MESSAGE.xtra, ['xt1']);
    await insertPost(GUILD_TWO, 'flow-yield', CHANNEL.yieldRoom, MESSAGE.yieldPost, ['y1']);
}

const TABLES = ['flows', 'flow_drafts', 'journeys', 'flow_journey_links', 'resource_bindings', 'flow_button_messages'] as const;

async function clearSeeds(): Promise<void> {
    for (const table of TABLES) {
        await sql`DELETE FROM ${sql.table(table)}`.execute(database);
    }
}

// --- What up writes, exactly.

function adoptedChannel(key: string, defaultName: string, adoptDiscordId: string): ResourceDeclaration {
    return { key, kind: 'textChannel', defaultName, adoptDiscordId };
}

function postedMessage(
    key: string,
    name: string,
    parentKey: string,
    buttons: readonly { key: string; label: string; style: 'Primary' | 'Secondary' | 'Success' | 'Danger' }[]
): ResourceDeclaration {
    return { key, kind: 'message', defaultName: name, parentKey, message: { content: `**${name}**`, embeds: [] }, buttons };
}

const AGAIN = { key: 'again', label: 'Again', style: 'Primary' } as const;

/** Every journey after up, by guild then key, with its creator — `bystander` untouched. */
const JOURNEYS_UP = {
    [GUILD_ONE]: {
        bystander: {
            name: 'Bystander',
            createdForFlowId: null,
            resources: [{ key: 'bystander-room', kind: 'textChannel', defaultName: 'bystander-room' }],
        },
        'flow-off': {
            name: 'Off duty',
            createdForFlowId: 'flow-off',
            resources: [
                adoptedChannel('off-duty-channel', 'off-duty-channel', CHANNEL.off),
                postedMessage('off-duty', 'Off duty', 'off-duty-channel', [{ key: 'tap-me', label: 'Tap me', style: 'Primary' }]),
            ],
        },
        'flow-twice': {
            name: 'Double tap',
            createdForFlowId: 'flow-twice',
            resources: [
                adoptedChannel('double-tap-channel', 'double-tap-channel', CHANNEL.also),
                postedMessage('double-tap', 'Double tap', 'double-tap-channel', [AGAIN]),
                adoptedChannel('double-tap-channel-2', 'double-tap-channel', CHANNEL.twice),
                postedMessage('double-tap-2', 'Double tap', 'double-tap-channel-2', [AGAIN]),
            ],
        },
        lobby: {
            name: 'Lobby',
            createdForFlowId: null,
            resources: [
                { key: 'old-lobby', kind: 'textChannel', defaultName: 'old-lobby' },
                postedMessage('lobby-greeter-2', 'Lobby greeter', 'old-lobby', [{ key: 'hello', label: 'Hello', style: 'Secondary' }]),
            ],
        },
        'welcome-journey': {
            name: 'Welcome journey',
            createdForFlowId: 'flow-welcome',
            resources: [
                { key: 'verify-room', kind: 'textChannel', defaultName: 'verify-room' },
                adoptedChannel('welcome-channel', 'welcome-channel', CHANNEL.rules),
                postedMessage('welcome', 'Welcome', 'welcome-channel', [
                    { key: 'i-agree', label: 'I agree', style: 'Success' },
                    { key: 'nope', label: 'Nope', style: 'Danger' },
                ]),
                postedMessage('welcome-2', 'Welcome', 'verify-room', [{ key: 'verify-me', label: 'Verify me', style: 'Primary' }]),
            ],
        },
    },
    [GUILD_TWO]: {
        'flow-pager': {
            name: 'Pager',
            createdForFlowId: 'flow-pager',
            resources: [
                adoptedChannel('pager-channel', 'pager-channel', CHANNEL.pager),
                postedMessage('pager', 'Pager', 'pager-channel', [{ key: 'page-me', label: 'Page me', style: 'Primary' }]),
                postedMessage('queue', 'Queue', 'pager-channel', [{ key: 'queue-up', label: 'Queue up', style: 'Success' }]),
            ],
        },
        'flow-rope': {
            name: 'Rope journey',
            createdForFlowId: 'flow-rope',
            resources: [
                adoptedChannel('rope-channel', 'rope-channel', CHANNEL.rope),
                postedMessage('rope', 'Rope', 'rope-channel', [{ key: 'tie-me', label: 'Tie me', style: 'Danger' }]),
                postedMessage('silk', 'Silk', 'rope-channel', [{ key: 'untie-me', label: 'Untie me', style: 'Secondary' }]),
            ],
        },
        'flow-vanilla': {
            name: 'Vanilla',
            createdForFlowId: 'flow-vanilla',
            resources: [
                adoptedChannel('vanilla-channel', 'vanilla-channel', CHANNEL.vanillaP),
                postedMessage('vanilla', 'Vanilla', 'vanilla-channel', [{ key: 'plain', label: 'Plain', style: 'Primary' }]),
                adoptedChannel('vanilla-channel-2', 'vanilla-channel', CHANNEL.vanillaQ),
                postedMessage('vanilla-2', 'Vanilla', 'vanilla-channel-2', [{ key: 'simple', label: 'Simple', style: 'Secondary' }]),
                postedMessage('wax', 'Wax', 'vanilla-channel', [{ key: 'drip', label: 'Drip', style: 'Danger' }]),
                postedMessage('xtra', 'Xtra', 'vanilla-channel-2', [{ key: 'more', label: 'More', style: 'Success' }]),
            ],
        },
        'flow-yield': {
            name: 'Yield',
            createdForFlowId: 'flow-yield',
            resources: [
                adoptedChannel('yield-channel', 'yield-channel', CHANNEL.yieldRoom),
                postedMessage('yield', 'Yield', 'yield-channel', [{ key: 'yield', label: 'Yield', style: 'Primary' }]),
            ],
        },
        'tease-j': {
            name: 'Tease',
            createdForFlowId: null,
            resources: [
                adoptedChannel('tease-channel', 'tease-channel', CHANNEL.tease),
                postedMessage('tease', 'Tease', 'tease-channel', [{ key: 'tease', label: 'Tease', style: 'Primary' }]),
            ],
        },
        'undo-j': {
            name: 'Undo',
            createdForFlowId: null,
            resources: [
                adoptedChannel('undo-it-channel', 'undo-it-channel', CHANNEL.tease),
                postedMessage('undo-it', 'Undo it', 'undo-it-channel', [{ key: 'undo', label: 'Undo', style: 'Danger' }]),
            ],
        },
    },
} as const;

/** Every link after up, as `guild flow → journey`. */
const LINKS_UP = [
    `${GUILD_ONE} flow-helper → lobby`,
    `${GUILD_ONE} flow-off → flow-off`,
    `${GUILD_ONE} flow-shared → lobby`,
    `${GUILD_ONE} flow-twice → flow-twice`,
    `${GUILD_ONE} flow-welcome → welcome-journey`,
    `${GUILD_TWO} flow-pager → flow-pager`,
    `${GUILD_TWO} flow-queue → flow-pager`,
    `${GUILD_TWO} flow-rope → flow-rope`,
    `${GUILD_TWO} flow-silk → flow-rope`,
    `${GUILD_TWO} flow-tease → tease-j`,
    `${GUILD_TWO} flow-undo → undo-j`,
    `${GUILD_TWO} flow-vanilla → flow-vanilla`,
    `${GUILD_TWO} flow-wax → flow-vanilla`,
    `${GUILD_TWO} flow-xtra → flow-vanilla`,
    `${GUILD_TWO} flow-yield → flow-yield`,
];

/** Every message binding up writes: `guild journey/key → message in channel, named`. */
const MESSAGE_BINDINGS_UP = [
    `${GUILD_ONE} flow-off/off-duty → ${MESSAGE.off} in ${CHANNEL.off} "Off duty"`,
    `${GUILD_ONE} flow-twice/double-tap → ${MESSAGE.also} in ${CHANNEL.also} "Double tap"`,
    `${GUILD_ONE} flow-twice/double-tap-2 → ${MESSAGE.twiceNew} in ${CHANNEL.twice} "Double tap"`,
    `${GUILD_ONE} lobby/lobby-greeter-2 → ${MESSAGE.lobby} in ${CHANNEL.lobby} "Lobby greeter"`,
    `${GUILD_ONE} welcome-journey/welcome → ${MESSAGE.welcome} in ${CHANNEL.rules} "Welcome"`,
    `${GUILD_ONE} welcome-journey/welcome-2 → ${MESSAGE.verify} in ${CHANNEL.verify} "Welcome"`,
    `${GUILD_TWO} flow-pager/pager → ${MESSAGE.pager} in ${CHANNEL.pager} "Pager"`,
    `${GUILD_TWO} flow-pager/queue → ${MESSAGE.queue} in ${CHANNEL.pager} "Queue"`,
    `${GUILD_TWO} flow-rope/rope → ${MESSAGE.rope} in ${CHANNEL.rope} "Rope"`,
    `${GUILD_TWO} flow-rope/silk → ${MESSAGE.silk} in ${CHANNEL.rope} "Silk"`,
    `${GUILD_TWO} flow-vanilla/vanilla → ${MESSAGE.vanillaP} in ${CHANNEL.vanillaP} "Vanilla"`,
    `${GUILD_TWO} flow-vanilla/vanilla-2 → ${MESSAGE.vanillaQ} in ${CHANNEL.vanillaQ} "Vanilla"`,
    `${GUILD_TWO} flow-vanilla/wax → ${MESSAGE.wax} in ${CHANNEL.vanillaP} "Wax"`,
    `${GUILD_TWO} flow-vanilla/xtra → ${MESSAGE.xtra} in ${CHANNEL.vanillaQ} "Xtra"`,
    `${GUILD_TWO} flow-yield/yield → ${MESSAGE.yieldPost} in ${CHANNEL.yieldRoom} "Yield"`,
    `${GUILD_TWO} tease-j/tease → ${MESSAGE.tease} in ${CHANNEL.tease} "Tease"`,
    `${GUILD_TWO} undo-j/undo-it → ${MESSAGE.undo} in ${CHANNEL.tease} "Undo it"`,
];

function picked(messageKey: string, buttonKey: string, rest: Record<string, unknown> = {}): Record<string, unknown> {
    return { button: { messageKey, buttonKey }, ...rest };
}

/** Each converted flow's Button Click nodes after up, by node id. */
const NODES_UP: Record<string, Record<string, Record<string, unknown>>> = {
    'flow-welcome': {
        b1: picked('welcome', 'i-agree', { eligibility: GATE }),
        b2: picked('welcome', 'nope'),
        b3: picked('welcome-2', 'verify-me'),
        // Never posted: emptied.
        b4: {},
    },
    'flow-off': { x1: picked('off-duty', 'tap-me') },
    'flow-shared': { g1: picked('lobby-greeter-2', 'hello') },
    // Posted in two channels: it listens to the newer.
    'flow-twice': { t1: picked('double-tap-2', 'again') },
    'flow-pager': { p1: picked('pager', 'page-me') },
    'flow-queue': { q1: picked('queue', 'queue-up') },
    'flow-rope': { r1: picked('rope', 'tie-me') },
    'flow-silk': { s1: picked('silk', 'untie-me') },
    'flow-tease': { te1: picked('tease', 'tease') },
    'flow-undo': { u1: picked('undo-it', 'undo') },
    'flow-vanilla': { v1: picked('vanilla', 'plain'), v2: picked('vanilla-2', 'simple') },
    'flow-wax': { w1: picked('wax', 'drip') },
    'flow-xtra': { xt1: picked('xtra', 'more') },
    'flow-yield': { y1: picked('yield', 'yield') },
};

/** The welcome draft's nodes after up: the live mapping, and the draft-only node emptied. */
const DRAFT_NODES_UP = {
    b1: picked('welcome', 'i-agree', { eligibility: GATE }),
    b2: picked('welcome', 'nope'),
    b3: picked('welcome-2', 'verify-me'),
    b4: {},
    d9: {},
};

// --- Reading back.

async function journeysAfter(): Promise<Record<string, Record<string, { name: string; createdForFlowId: string | null; resources: unknown }>>> {
    const rows = await database.selectFrom('journeys').selectAll().orderBy('journeyKey').execute();
    const byGuild: Record<string, Record<string, { name: string; createdForFlowId: string | null; resources: unknown }>> = {};
    for (const row of rows) {
        byGuild[row.guildId] ??= {};
        (byGuild[row.guildId] as Record<string, unknown>)[row.journeyKey] = {
            name: row.name,
            createdForFlowId: row.createdForFlowId,
            resources: row.resources,
        };
    }
    return byGuild;
}

async function linksAfter(): Promise<string[]> {
    const rows = await database.selectFrom('flow_journey_links').selectAll().execute();
    return rows.map((row) => `${row.guildId} ${row.flowId} → ${row.journeyKey}`).sort();
}

async function messageBindingsAfter(): Promise<string[]> {
    const rows = await database.selectFrom('resource_bindings').selectAll().where('kind', '=', 'message').execute();
    for (const row of rows) {
        expect(row).toMatchObject({ ownerKind: 'journey', state: 'created', messageDigest: null });
    }
    return rows
        .map((row) => `${row.guildId} ${row.ownerKey}/${row.resourceKey} → ${row.discordId} in ${row.messageChannelId} "${row.name}"`)
        .sort();
}

async function graphOfFlow(flowId: string): Promise<FlowGraph> {
    const row = await database.selectFrom('flows').select('graph').where('flowId', '=', flowId).executeTakeFirstOrThrow();
    return row.graph;
}

function buttonDataOf(graph: FlowGraph): Record<string, Record<string, unknown>> {
    return Object.fromEntries(graph.nodes.filter((candidate) => candidate.type === BUTTON_CLICK).map((candidate) => [candidate.id, candidate.data]));
}

/** Every row of the six tables this touches, in id order, as the stack reads them. */
async function everyRow(): Promise<Record<string, unknown[]>> {
    const tables: Record<string, unknown[]> = {};
    for (const table of TABLES) {
        tables[table] = await database.selectFrom(table).selectAll().orderBy('id').execute();
    }
    return tables;
}

/** The six tables without what a re-insert renumbers or restamps, for comparing two ups. */
async function everyRowByContent(): Promise<Record<string, unknown[]>> {
    const rows = await everyRow();
    return Object.fromEntries(
        Object.entries(rows).map(([table, tableRows]) => [
            table,
            tableRows
                .map((row) => {
                    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...content } = row as Record<string, unknown>;
                    return table === 'journeys' ? row : content;
                })
                .map((row) => JSON.stringify(row))
                .sort(),
        ])
    );
}

let warnings: string[] = [];
let summaries: string[] = [];

async function runUp(seed: () => Promise<void> = seedOldWorld): Promise<void> {
    await migrateOrThrow(migrator.migrateTo(BEFORE));
    await seed();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await migrateOrThrow(migrator.migrateToLatest());
    warnings = warn.mock.calls.map((call) => String(call[0]));
    summaries = log.mock.calls.map((call) => String(call[0]));
}

beforeAll(async () => {
    await ensureBlocksDiscovered();
    await migrateTestDatabase();
});

afterEach(async () => {
    vi.restoreAllMocks();
    // Every case leaves the schema at latest and the tables empty, whatever it did.
    await migrateOrThrow(migrator.migrateToLatest());
    await clearSeeds();
});

describe('2026-10-26-Button_Click_Listens_To_Message (sqlite, through Migrator)', () => {
    it('writes exactly the journeys, links, message bindings, nodes and drafts the posted rows call for', async () => {
        await runUp();

        expect(await journeysAfter()).toEqual(JOURNEYS_UP);
        expect(await linksAfter()).toEqual(LINKS_UP);
        expect(await messageBindingsAfter()).toEqual(MESSAGE_BINDINGS_UP);

        for (const [flowId, nodes] of Object.entries(NODES_UP)) {
            expect(buttonDataOf(await graphOfFlow(flowId)), flowId).toEqual(nodes);
        }
        // Everything that is not a Button Click is left as it was.
        expect((await graphOfFlow('flow-welcome')).nodes.find((candidate) => candidate.id === 'say')).toEqual(SAY);
        expect(await graphOfFlow('flow-helper')).toEqual(graphOf([SAY]));

        const draft = await database.selectFrom('flow_drafts').select('graph').executeTakeFirstOrThrow();
        expect(buttonDataOf(draft.graph)).toEqual(DRAFT_NODES_UP);
        expect(draft.graph.nodes.find((candidate) => candidate.id === 'say')).toEqual(SAY);

        // The bindings that were there are still there, untouched.
        const others = await database.selectFrom('resource_bindings').selectAll().where('kind', '!=', 'message').orderBy('id').execute();
        expect(others.map((row) => `${row.ownerKey}/${row.resourceKey} ${row.kind} ${row.state} ${row.discordId}`)).toEqual([
            `welcome-journey/verify-room textChannel created ${CHANNEL.verify}`,
            `lobby/old-lobby textChannel adopted ${CHANNEL.lobby}`,
            'lobby/lobby-greeter role adopted 1300000000000000009',
        ]);
        // The record Deploy kept stays, unread, until the bridge-removal deploy.
        expect(await database.selectFrom('flow_button_messages').select('id').execute()).toHaveLength(20);
    });

    it('moves the version of every journey it writes, and only those', async () => {
        await runUp();

        const rows = await database.selectFrom('journeys').select(['journeyKey', 'updatedAt']).execute();
        const version = Object.fromEntries(rows.map((row) => [row.journeyKey, new Date(row.updatedAt).getTime()]));
        const old = new Date(OLD_VERSION).getTime();

        expect(version.bystander).toBe(old);
        for (const written of ['welcome-journey', 'lobby', 'flow-rope', 'tease-j', 'undo-j']) {
            expect(version[written], written).toBeGreaterThan(old);
        }
    });

    it('stores journeys every read accepts, messages install would post, and resources the journey PUT hands back unchanged', async () => {
        await runUp();

        const journeys = await database.selectFrom('journeys').selectAll().execute();
        expect(journeys).toHaveLength(11);
        for (const journey of journeys) {
            const where = `${journey.guildId} ${journey.journeyKey}`;
            expect(() =>
                validateJourneyDeclaration({ journeyKey: journey.journeyKey, name: journey.name, resources: journey.resources })
            ).not.toThrow();

            for (const resource of journey.resources.filter((candidate) => candidate.kind === 'message')) {
                expect(messageResourceProblems(resource), `${where} ${resource.key}`).toEqual([]);
            }

            const body = JourneyUpdateSchema.safeParse({ resources: journey.resources, baseUpdatedAt: new Date(journey.updatedAt).toISOString() });
            expect(body.success, where).toBe(true);
            // The schema normalises names on the way in; a migrated resource must already be what it stores.
            expect(body.data?.resources, where).toEqual(journey.resources);
            expect(declarationsRefusal(journey.resources), where).toBeUndefined();
        }
    });

    it('leaves every converted flow ready by the live readiness check, but for the node it emptied', async () => {
        await runUp();

        const links = await database.selectFrom('flow_journey_links').selectAll().execute();
        for (const flowId of Object.keys(NODES_UP)) {
            const link = links.find((candidate) => candidate.flowId === flowId);
            const journey = await database
                .selectFrom('journeys')
                .selectAll()
                .where('journeyKey', '=', link?.journeyKey ?? '')
                .executeTakeFirstOrThrow();
            const issues = flowReadinessIssues(await graphOfFlow(flowId), {
                flowId,
                declarations: journey.resources,
                journeyFlows: [],
            });

            if (flowId === 'flow-welcome') {
                expect(issues.length).toBeGreaterThan(0);
                expect(issues.map((issue) => issue.nodeId)).toEqual(issues.map(() => 'b4'));
            } else {
                expect(issues, flowId).toEqual([]);
            }
        }
    });

    it('logs every row it did not adopt, every node it emptied, every hazard and every rewritten name, with its reason', async () => {
        await runUp();

        const one = `[migration] Button Click → message, guild ${GUILD_ONE}: `;
        const two = `[migration] Button Click → message, guild ${GUILD_TWO}: `;
        const expected: RegExp[] = [
            // Rows not adopted.
            new RegExp(`^${escape(one)}flow_button_messages row \\d+ \\(message ${MESSAGE.gone} in channel ${CHANNEL.rules}\\) belongs to flow flow-gone, which is gone`),
            new RegExp(`^${escape(one)}flow_button_messages row \\d+ \\(message ${MESSAGE.ghost} .*names no Button Click still in its old shape \\(deleted-node\\)`),
            new RegExp(`^${escape(one)}flow_button_messages row \\d+ \\(message ${MESSAGE.twiceOld} .*is an older post .*\\(message ${MESSAGE.twiceNew}\\) is newer`),
            new RegExp(`^${escape(one)}node t1 of flow "Double tap" \\(flow-twice\\) is on message ${MESSAGE.also} .*the newer message ${MESSAGE.twiceNew}`),
            // Nodes emptied, live and drafted.
            new RegExp(`^${escape(one)}node b4 of flow "Welcome" \\(flow-welcome\\) was never posted`),
            new RegExp(`^${escape(one)}draft \\d+ of flow "Welcome" \\(flow-welcome\\): node d9 exists only in the draft`),
            new RegExp(`^${escape(one)}draft \\d+ of flow "Welcome" \\(flow-welcome\\): node b4 was never posted`),
            new RegExp(`^${escape(one)}draft \\d+ of flow "Welcome" \\(flow-welcome\\): node b1 had its button changed in the draft \\(.*"I agree!!".*live: .*"I agree"`),
            // Names a posted message refuses.
            new RegExp(`^${escape(one)}node x1 of flow "Off duty" \\(flow-off\\): its label "Tap \\{\\{me\\}\\}" won't do .* says "Tap me"`),
            new RegExp(`^${escape(two)}flow "Undo \\{\\{it\\}\\}" \\(flow-undo\\): its name holds \\{\\{ or \\}\\}.*named "Undo it"`),
            // Journeys.
            new RegExp(`^${escape(two)}flow "Yield" \\(flow-yield\\) is linked to journey "ghost-journey", which is gone`),
            new RegExp(`^${escape(two)}flow "Tease" \\(flow-tease\\), flow "Undo \\{\\{it\\}\\}" \\(flow-undo\\) posted buttons into shared channels \\(${CHANNEL.tease}\\) that different journeys already hold or sit in \\("tease-j", "undo-j"\\)`),
            new RegExp(`^${escape(two)}journey "undo-j" adopts channel ${CHANNEL.tease}, which journey "tease-j" \\(declared\\) already hold\\(s\\)`),
        ];

        expect(warnings).toHaveLength(expected.length);
        for (const pattern of expected) {
            expect(warnings.filter((line) => pattern.test(line)), pattern.source).toHaveLength(1);
        }
    });

    it('logs one summary per guild naming every journey, flow, channel and adopted message', async () => {
        await runUp();

        expect(summaries).toHaveLength(2);
        const [first, second] = summaries as [string, string];
        expect(first).toMatch(new RegExp(`^\\[migration\\] Button Click → message, guild ${GUILD_ONE}: 6 trigger\\(s\\) converted and 1 emptied, in 4 flow\\(s\\); 6 message\\(s\\) adopted; 1 draft\\(s\\) rewritten\\.`));
        expect(second).toMatch(new RegExp(`^\\[migration\\] Button Click → message, guild ${GUILD_TWO}: 11 trigger\\(s\\) converted and 0 emptied, in 10 flow\\(s\\); 11 message\\(s\\) adopted; 0 draft\\(s\\) rewritten\\.`));
        for (const line of MESSAGE_BINDINGS_UP) {
            const [guildId, , , messageId, , channelId] = line.split(' ');
            expect(guildId === GUILD_ONE ? first : second).toContain(`→ message ${messageId} in channel ${channelId}`);
        }
        expect(first).toContain(`journey "flow-off" ("Off duty", created for flow flow-off): flow "Off duty" (flow-off) (linked now)`);
        expect(first).toContain(`channel "old-lobby" → ${CHANNEL.lobby} (declared again under the key it is bound to)`);
        expect(first).toContain(`channel "verify-room" → ${CHANNEL.verify} (bound to this journey)`);
        expect(first).toContain(`channel "welcome-channel" → ${CHANNEL.rules} (declared, adopting it by id as "welcome-channel"`);
        expect(second).toContain(
            `journey "flow-vanilla" ("Vanilla", created for flow flow-vanilla): flow "Vanilla" (flow-vanilla) (linked now), ` +
                'flow "Wax" (flow-wax) (linked now), flow "Xtra" (flow-xtra) (linked now)'
        );
        expect(second).toContain('journey "flow-rope" ("Rope journey", existing, updated): flow "Rope" (flow-rope) (linked now), flow "Silk" (flow-silk) (linked now)');
    });

    it('changes nothing when run again', async () => {
        await runUp();
        const before = await everyRow();

        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        await buttonClickListensToMessage(database);

        expect(await everyRow()).toEqual(before);
    });

    it('goes down to Button Clicks owning their buttons, forgetting only the bindings it wrote, and back up to the same place', async () => {
        await runUp();
        const firstUp = await everyRowByContent();
        const journeysUp = await database.selectFrom('journeys').selectAll().orderBy('id').execute();

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await migrateOrThrow(migrator.migrateTo(BEFORE));

        // Each converted node owns its button again, from the declaration it pointed at.
        expect(buttonDataOf(await graphOfFlow('flow-welcome'))).toEqual({
            b1: { eligibility: GATE, channelId: CHANNEL.rules, label: 'I agree', style: 'Success' },
            b2: { channelId: CHANNEL.rules, label: 'Nope', style: 'Danger' },
            // Its channel is bound, not adopted: the binding's id.
            b3: { channelId: CHANNEL.verify, label: 'Verify me', style: 'Primary' },
            // What up emptied, down cannot give back.
            b4: {},
        });
        expect(buttonDataOf(await graphOfFlow('flow-off'))).toEqual({ x1: { channelId: CHANNEL.off, label: 'Tap me', style: 'Primary' } });
        expect(buttonDataOf(await graphOfFlow('flow-twice'))).toEqual({ t1: { channelId: CHANNEL.twice, label: 'Again', style: 'Primary' } });
        expect(buttonDataOf(await graphOfFlow('flow-shared'))).toEqual({ g1: { channelId: CHANNEL.lobby, label: 'Hello', style: 'Secondary' } });
        const draft = await database.selectFrom('flow_drafts').select('graph').executeTakeFirstOrThrow();
        expect(buttonDataOf(draft.graph)).toMatchObject({ b1: { channelId: CHANNEL.rules, label: 'I agree' }, d9: {} });
        expect(warn).not.toHaveBeenCalled();

        // The message bindings it wrote are gone; nothing else is.
        expect(await database.selectFrom('resource_bindings').select('id').where('kind', '=', 'message').execute()).toEqual([]);
        expect(await database.selectFrom('resource_bindings').select('id').execute()).toHaveLength(3);
        expect(await database.selectFrom('journeys').selectAll().orderBy('id').execute()).toEqual(journeysUp);
        expect(await linksAfter()).toEqual(LINKS_UP);

        await migrateOrThrow(migrator.migrateToLatest());

        // Back up, every row says what the first up said — journeys' versions included, since
        // nothing in their resources changed.
        expect(await everyRowByContent()).toEqual(firstUp);
    });

    it('is silent, and writes nothing, when every Button Click already names a button', async () => {
        await migrateOrThrow(migrator.migrateTo(BEFORE));
        await insertFlow(GUILD_ONE, 'flow-new', 'New shape', true, [button('n1', { button: { messageKey: 'panel', buttonKey: 'go' } })]);
        const before = await everyRow();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        await migrateOrThrow(migrator.migrateToLatest());

        expect(await everyRow()).toEqual(before);
        expect(warn).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();

        // Down cannot give it a label — its journey declares no such button — so it leaves
        // it naming the button, rather than strip the one thing that says what it was.
        await migrateOrThrow(migrator.migrateTo(BEFORE));
        expect(buttonDataOf(await graphOfFlow('flow-new'))).toEqual({ n1: { button: { messageKey: 'panel', buttonKey: 'go' } } });
        expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
            `[migration] Button Click → message (down), guild ${GUILD_ONE}: flow "New shape" (flow-new), node n1: its journey ` +
                'declares no button "go" on a message "panel", so it is left naming it. Step 2 reads it as unfinished.',
        ]);
    });
});

/** Channels and messages of the cases below, each seeded on its own. */
const HELD = {
    channel: '3100000000000000001',
    elsewhere: '3100000000000000002',
    sub: '3200000000000000001',
    a: '3200000000000000002',
    b: '3200000000000000003',
    c: '3200000000000000004',
    bow: '3200000000000000005',
    page: '3200000000000000006',
    ok: '3200000000000000007',
    bad: '3200000000000000008',
} as const;

async function journeyKeys(): Promise<string[]> {
    return (await database.selectFrom('journeys').select('journeyKey').orderBy('journeyKey').execute()).map((row) => row.journeyKey);
}

async function resourcesOf(journeyKey: string): Promise<unknown> {
    return (await database.selectFrom('journeys').select('resources').where('journeyKey', '=', journeyKey).executeTakeFirstOrThrow())
        .resources;
}

describe('2026-10-26-Button_Click_Listens_To_Message, channels another journey holds', () => {
    /**
     * Grouping counts a journey holding a channel a flow posted into, though none of its flows
     * posted there. A journey of the flow's own would adopt a channel another journey has
     * installed, and Install would refuse it — the flow stuck at Install, which Douglas's
     * answer 1 merges to avoid. Joining the holder reuses its binding: nothing moves.
     */
    it('puts a journey-less flow that posted into a channel another journey has bound into that journey', async () => {
        await runUp(async () => {
            await insertFlow(GUILD_ONE, 'flow-keeper', 'Keeper', true, [SAY]);
            await insertJourney(GUILD_ONE, 'dungeon', 'Dungeon', [{ key: 'dungeon-room', kind: 'textChannel', defaultName: 'dungeon-room' }], null);
            await insertLink(GUILD_ONE, 'flow-keeper', 'dungeon');
            await insertBinding({ guildId: GUILD_ONE, ownerKey: 'dungeon', resourceKey: 'dungeon-room', kind: 'textChannel', state: 'created', discordId: HELD.channel, name: 'dungeon-room' });
            await insertFlow(GUILD_ONE, 'flow-sub', 'Sub', true, [button('s1', { channelId: HELD.channel, label: 'Kneel', style: 'Primary' })]);
            await insertPost(GUILD_ONE, 'flow-sub', HELD.channel, HELD.sub, ['s1']);
        });

        expect(await journeyKeys()).toEqual(['dungeon']);
        expect(await linksAfter()).toEqual([`${GUILD_ONE} flow-keeper → dungeon`, `${GUILD_ONE} flow-sub → dungeon`]);
        expect(await resourcesOf('dungeon')).toEqual([
            { key: 'dungeon-room', kind: 'textChannel', defaultName: 'dungeon-room' },
            postedMessage('sub', 'Sub', 'dungeon-room', [{ key: 'kneel', label: 'Kneel', style: 'Primary' }]),
        ]);
        expect(buttonDataOf(await graphOfFlow('flow-sub'))).toEqual({ s1: picked('sub', 'kneel') });
        expect(await messageBindingsAfter()).toEqual([`${GUILD_ONE} dungeon/sub → ${HELD.sub} in ${HELD.channel} "Sub"`]);
        expect(summaries.join('\n')).toContain(`channel "dungeon-room" → ${HELD.channel} (bound to this journey)`);
        expect(warnings).toEqual([]);
    });

    /**
     * Two flows in two journeys posted into one channel, and a third in none: the hazard. The
     * third joins one of the two it shares the channel with rather than becoming a third
     * journey adopting it — the oldest poster's.
     */
    it('puts a journey-less flow in a hazard group into a journey it shares a channel with, not a new one', async () => {
        await runUp(async () => {
            await insertJourney(GUILD_ONE, 'a-j', 'A', [], null);
            await insertJourney(GUILD_ONE, 'b-j', 'B', [], null);
            await insertFlow(GUILD_ONE, 'flow-a', 'Alpha', true, [button('a1', { channelId: HELD.channel, label: 'One', style: 'Primary' })]);
            await insertFlow(GUILD_ONE, 'flow-b', 'Beta', true, [button('b1', { channelId: HELD.channel, label: 'Two', style: 'Primary' })]);
            await insertFlow(GUILD_ONE, 'flow-c', 'Gamma', true, [button('c1', { channelId: HELD.channel, label: 'Three', style: 'Primary' })]);
            await insertLink(GUILD_ONE, 'flow-a', 'a-j');
            await insertLink(GUILD_ONE, 'flow-b', 'b-j');
            await insertPost(GUILD_ONE, 'flow-a', HELD.channel, HELD.a, ['a1']);
            await insertPost(GUILD_ONE, 'flow-b', HELD.channel, HELD.b, ['b1']);
            await insertPost(GUILD_ONE, 'flow-c', HELD.channel, HELD.c, ['c1']);
        });

        expect(await journeyKeys()).toEqual(['a-j', 'b-j']);
        expect(await linksAfter()).toEqual([
            `${GUILD_ONE} flow-a → a-j`,
            `${GUILD_ONE} flow-b → b-j`,
            `${GUILD_ONE} flow-c → a-j`,
        ]);
        expect(buttonDataOf(await graphOfFlow('flow-c'))).toEqual({ c1: picked('gamma', 'three') });
        expect(warnings.filter((line) => line.includes('that different journeys already hold or sit in ("a-j", "b-j")'))).toHaveLength(1);
    });

    /**
     * Review L1: a key whose declaration adopts the channel but which this journey installed as
     * another one. A message under it would be in the wrong channel — Install blocks that — and
     * a second declaration may not adopt the same channel. So the post is not adopted, loudly,
     * rather than the migration throwing or parenting the message wrong. Rule 2 (the node's
     * sidecar names the key) and rule 3 (the key adopts the channel) would both have picked it.
     */
    it('never parents a message on a key installed as another channel, and says why it adopted nothing', async () => {
        await runUp(async () => {
            await insertJourney(GUILD_ONE, 'stage-j', 'Stage', [{ key: 'stage', kind: 'textChannel', defaultName: 'stage', adoptDiscordId: HELD.channel }], null);
            await insertBinding({ guildId: GUILD_ONE, ownerKey: 'stage-j', resourceKey: 'stage', kind: 'textChannel', state: 'adopted', discordId: HELD.elsewhere, name: 'stage' });
            await insertFlow(GUILD_ONE, 'flow-bow', 'Bow', true, [button('w1', { channelId: '', channelIdKey: 'stage', label: 'Bow down', style: 'Primary' })]);
            await insertLink(GUILD_ONE, 'flow-bow', 'stage-j');
            await insertPost(GUILD_ONE, 'flow-bow', HELD.channel, HELD.bow, ['w1']);
        });

        expect(await resourcesOf('stage-j')).toEqual([{ key: 'stage', kind: 'textChannel', defaultName: 'stage', adoptDiscordId: HELD.channel }]);
        expect(await messageBindingsAfter()).toEqual([]);
        expect(buttonDataOf(await graphOfFlow('flow-bow'))).toEqual({ w1: {} });
        expect(warnings).toEqual([
            expect.stringMatching(
                new RegExp(
                    `flow_button_messages row \\d+ \\(message ${HELD.bow} in channel ${HELD.channel}\\) of flow "Bow" \\(flow-bow\\) ` +
                        `can't be adopted: journey "stage-j" declares "stage" adopting channel ${HELD.channel}, but installed that key ` +
                        `as channel ${HELD.elsewhere}.*Its triggers w1 are emptied`
                )
            ),
        ]);
    });

    /** Review L2: an adopted row naming nodes that are gone loses their buttons at Repair, and says so. */
    it('logs the node ids an adopted row names that are no longer waiting Button Clicks', async () => {
        await runUp(async () => {
            await insertFlow(GUILD_ONE, 'flow-page', 'Page', true, [button('p1', { channelId: HELD.channel, label: 'Page', style: 'Primary' })]);
            await insertPost(GUILD_ONE, 'flow-page', HELD.channel, HELD.page, ['p1', 'p-gone', 'p-also-gone']);
        });

        expect(buttonDataOf(await graphOfFlow('flow-page'))).toEqual({ p1: picked('page', 'page') });
        expect(warnings).toEqual([
            expect.stringMatching(
                new RegExp(`flow_button_messages row \\d+ \\(message ${HELD.page} .*\\) of flow "Page" \\(flow-page\\) also names p-gone, p-also-gone,`)
            ),
        ]);
    });
});

describe('2026-10-26-Button_Click_Listens_To_Message, its log', () => {
    /**
     * Review L3: one guild converted, the next throws, and every guild is rolled back — so the
     * first guild's summary must not be in the log saying it was converted.
     */
    it('prints nothing when a later guild throws and rolls every guild back', async () => {
        await migrateOrThrow(migrator.migrateTo(BEFORE));
        await insertFlow(GUILD_ONE, 'flow-ok', 'Fine', true, [button('k1', { channelId: HELD.channel, label: 'Fine', style: 'Primary' })]);
        await insertPost(GUILD_ONE, 'flow-ok', HELD.channel, HELD.ok, ['k1']);
        // Guild two's message is already bound to a journey its flow is not in: impossible, so it throws.
        await insertFlow(GUILD_TWO, 'flow-bad', 'Bad', true, [button('d1', { channelId: HELD.channel, label: 'Bad', style: 'Primary' })]);
        await insertPost(GUILD_TWO, 'flow-bad', HELD.channel, HELD.bad, ['d1']);
        await insertBinding({ guildId: GUILD_TWO, ownerKey: 'someone-else', resourceKey: 'theirs', kind: 'message', state: 'created', discordId: HELD.bad, name: 'Theirs' });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        await expect(migrateOrThrow(migrator.migrateToLatest())).rejects.toThrow(/message 3200000000000000008 in guild 900000000000000002 is already bound/);

        expect(log).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
        expect(buttonDataOf(await graphOfFlow('flow-ok'))).toEqual({ k1: { channelId: HELD.channel, label: 'Fine', style: 'Primary' } });
        expect(await journeyKeys()).toEqual([]);
        // Nothing left that would throw again when the next case migrates to latest.
        await clearSeeds();
    });
});

function escape(literal: string): string {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
