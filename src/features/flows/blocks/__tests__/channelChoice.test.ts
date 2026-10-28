import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeGuild } from '../../__tests__/support/fakeGuild';
import { FLOW_GRAPH_VERSION, type FlowGraph, type FlowNode } from '../../data/flowGraph';
import { authoredGraphIssues } from '../../engine/graphValidation';
import { validateNodeData } from '../../engine/nodeDataValidation';
import { effectiveRequirements } from '../../engine/nodeRequirements';
import { block as closeTicket } from '../actionCloseTicket';
import { ACTION_DELAY } from '../actionDelay';
import { block as postEmbed } from '../actionPostEmbed';
import { block as sendMessage } from '../actionSendMessage';
import { ensureBlocksDiscovered } from '../registry';
import { TRIGGER_BUTTON_CLICK } from '../triggerButtonClick';
import { TRIGGER_SCHEDULE } from '../triggerSchedule';
import {
    CHANNEL_CHOICE_CARD_PART,
    CHANNEL_CHOICE_FIELD,
    CHANNEL_PICKER_FIELD,
    channelFor,
    type ChannelChoiceConfig,
} from '../channelChoice';
import { parseNodeConfig, type BlockManifest } from '../manifest';
import type { FlowRunContext } from '../types';
import { nodeRoutes, type NodeDescriptor } from '../../../../web/api/nodeRoutes';
import { summarizeFromDescriptor } from '../../../../../web/src/flows/cardSummary';
import type { GuildChannel, NodeDescriptor as BrowserNodeDescriptor } from '@brattybot/web-sdk';

/**
 * The channel choice: whether a block posts into the channel the author picked or the one
 * the run happened in.
 *
 * Every block that takes it is driven here through the config parse the executor uses, on
 * a run carrying a channel of its own, and asked where it posted — so "the chosen channel
 * is the one posted in" is one table, and a block reading the picker behind its choice's
 * back fails by name.
 */

const GUILD_ID = 'guild-1';
const PICKED_ID = 'picked-1';
const RUN_CHANNEL_ID = 'run-channel-1';
const ELSEWHERE_ID = 'elsewhere-1';

/** Every channel id a block sent into, in order — reset before each test. */
const sentTo: string[] = [];

beforeEach(() => {
    sentTo.length = 0;
});

/** A channel that records every send against its id. */
function sink(id: string) {
    return {
        id,
        send: async () => {
            sentTo.push(id);
            return { id: `message-in-${id}`, channelId: id };
        },
    };
}

/**
 * A run in a guild holding the picked channel and the run's own, whose channel is `channel`
 * — the run's own by default, `null` for a run that has lost its channel.
 */
function contextWith(channel: { readonly id: string } | null = sink(RUN_CHANNEL_ID)): FlowRunContext {
    return {
        client: {} as FlowRunContext['client'],
        guild: fakeGuild({
            id: GUILD_ID,
            channels: { [PICKED_ID]: sink(PICKED_ID), [RUN_CHANNEL_ID]: sink(RUN_CHANNEL_ID) },
        }),
        ...(channel ? { channel: channel as unknown as FlowRunContext['channel'] } : {}),
        runId: 'run-1',
        flowId: 'flow-1',
        nodeId: 'node-1',
        chainDepth: 1,
        variables: {},
        setOutput: () => {},
    };
}

/** Run a block on raw node data, parsed exactly as the executor parses it. */
async function runOn(definition: BlockManifest, data: Record<string, unknown>, context = contextWith()) {
    const parsed = parseNodeConfig(definition, data);
    if (!parsed.success) throw new Error(`${definition.type} refused ${JSON.stringify(data)}: ${parsed.error.message}`);
    return definition.run(parsed.data, context);
}

/** Every block taking the choice, with the rest of the node data it needs to run. */
const BLOCKS: readonly { readonly definition: BlockManifest; readonly data: Record<string, unknown> }[] = [
    { definition: postEmbed, data: { message: { embeds: [{ title: 'Kneel.' }] } } },
    { definition: sendMessage, data: { message: 'Kneel.' } },
];

const CASES = BLOCKS.flatMap(({ definition, data }) =>
    [
        { choice: 'left unset', data: { ...data, channelId: PICKED_ID }, expected: PICKED_ID },
        { choice: 'channel', data: { ...data, where: 'channel', channelId: PICKED_ID }, expected: PICKED_ID },
        { choice: 'here', data: { ...data, where: 'here' }, expected: RUN_CHANNEL_ID },
        // The picker still holds a channel from before the switch; hidden means absent.
        { choice: 'here, picker still holding one', data: { ...data, where: 'here', channelId: PICKED_ID }, expected: RUN_CHANNEL_ID },
    ].map((testCase) => ({ ...testCase, name: definition.type, definition }))
);

describe('a block with the channel choice posts where it names', () => {
    it.each(CASES)('$name, choice $choice, posts only in $expected', async ({ definition, data, expected }) => {
        expect(await runOn(definition, data)).toEqual({ kind: 'continue' });

        expect(sentTo).toEqual([expected]);
    });

    it.each(BLOCKS)('$definition.type fails by name, posting nothing, when the run has lost its channel', async ({ definition, data }) => {
        await expect(runOn(definition, { ...data, where: 'here' }, contextWith(null))).rejects.toThrow(
            "set to post in the channel this happened in, and this run isn't in a channel the bot can reach"
        );
        expect(sentTo).toEqual([]);
    });

    it.each(BLOCKS)(
        "$definition.type refuses a run channel that is not this server's, as it refuses a picked one",
        async ({ definition, data }) => {
            await expect(runOn(definition, { ...data, where: 'here' }, contextWith(sink(ELSEWHERE_ID)))).rejects.toThrow(
                `Channel ${ELSEWHERE_ID} is not a sendable text channel in this server`
            );
            expect(sentTo).toEqual([]);
        }
    );

    it.each(BLOCKS)('$definition.type asks for a channel only while it is picking one', ({ definition, data }) => {
        const unpicked = parseNodeConfig(definition, data);
        expect(unpicked.success).toBe(false);
        expect(unpicked.error?.issues).toEqual([
            expect.objectContaining({
                path: ['channelId'],
                message: 'Which channel? Pick one — or post in the channel this happened in.',
            }),
        ]);

        expect(parseNodeConfig(definition, { ...data, where: 'here' }).success).toBe(true);
    });
});

/**
 * An empty pick — what the picker writes when a declared channel is picked before install, or
 * when a pick is cleared — stays a *too short* complaint, so save forgives it while a declared
 * channel is on its way and refuses it otherwise, exactly as before the choice.
 */
describe('an empty pick, as save judges it', () => {
    beforeAll(ensureBlocksDiscovered);

    it.each(BLOCKS)('$definition.type forgives "" waiting on a declared channel, and refuses it otherwise', ({ definition, data }) => {
        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [{ id: 'post', type: definition.type, position: { x: 0, y: 0 }, data: { ...data, channelId: '' } }],
            edges: [],
        };

        expect(validateNodeData(graph, { pendingFields: new Map([['post', new Set(['channelId'])]]) })).toEqual({ valid: true });
        const refused = validateNodeData(graph);
        expect(refused.valid ? [] : refused.issues).toEqual([expect.objectContaining({ nodeId: 'post', field: 'channelId' })]);
    });
});

describe('what the channel choice needs from the run', () => {
    const needs = (definition: BlockManifest, data: Record<string, unknown>) =>
        effectiveRequirements(definition, data).map(({ requirement }) => requirement);

    it.each(BLOCKS)('$definition.type needs nothing for a picked channel, and the run’s channel for here', ({ definition }) => {
        expect(needs(definition, { channelId: PICKED_ID })).toEqual([]);
        expect(needs(definition, { where: 'channel', channelId: PICKED_ID })).toEqual([]);
        expect(needs(definition, { where: 'here' })).toEqual(['channel']);
    });
});

/**
 * Save, through the real validator: "here" is refused under the choice where a run can arrive
 * with no channel, and accepted where every run has one — a park above included, since resume
 * fetches the channel again. Close Ticket's "which ticket" choice rides the same requirement.
 */
describe('where save allows the channel this happened in', () => {
    beforeAll(ensureBlocksDiscovered);

    const CHANNEL_ISSUE = /needs "channel" from the run/;

    function node(id: string, type: string, data: Record<string, unknown> = {}): FlowNode {
        return { id, type, position: { x: 0, y: 0 }, data };
    }

    /** `first -> … -> last`, in order. */
    function chain(...nodes: FlowNode[]): FlowGraph {
        return {
            version: FLOW_GRAPH_VERSION,
            nodes,
            edges: nodes.slice(1).map((target, index) => ({ id: `e${index}`, source: nodes[index]?.id ?? '', target: target.id })),
        };
    }

    const schedule = (): FlowNode => node('trigger', TRIGGER_SCHEDULE, { repeat: 'daily', time: '09:00' });
    const button = (): FlowNode => node('trigger', TRIGGER_BUTTON_CLICK, { button: { messageKey: 'panel', buttonKey: 'go' } });
    const channelIssuesOn = (graph: FlowGraph, nodeId: string) =>
        authoredGraphIssues(graph).filter((issue) => issue.nodeId === nodeId && CHANNEL_ISSUE.test(issue.message));

    it.each(BLOCKS)('refuses $definition.type posting "here" below a Schedule, under the choice', ({ definition, data }) => {
        const issues = channelIssuesOn(chain(schedule(), node('post', definition.type, { ...data, where: 'here' })), 'post');

        expect(issues).toHaveLength(1);
        expect(issues[0]?.field).toBe('where');
        expect(issues[0]?.message).toMatch(
            /needs "channel" from the run for "Where" set to "The channel this happened in", but it can be reached from a trigger that fires on a gateway event/
        );
    });

    it.each(BLOCKS)('leaves $definition.type posting in a picked channel below a Schedule alone', ({ definition, data }) => {
        expect(channelIssuesOn(chain(schedule(), node('post', definition.type, { ...data, channelId: PICKED_ID })), 'post')).toEqual([]);
    });

    it.each(BLOCKS)('accepts $definition.type posting "here" below a button, a wait above or not', ({ definition, data }) => {
        const post = (): FlowNode => node('post', definition.type, { ...data, where: 'here' });

        expect(channelIssuesOn(chain(button(), post()), 'post')).toEqual([]);
        expect(channelIssuesOn(chain(button(), node('wait', ACTION_DELAY, { durationMs: 60_000 }), post()), 'post')).toEqual([]);
    });

    it('refuses Close Ticket on the ticket in this channel below a Schedule, and takes it below a button', () => {
        const close = (): FlowNode => node('close', closeTicket.type, { source: 'here' });

        const issues = channelIssuesOn(chain(schedule(), close()), 'close');
        expect(issues).toHaveLength(1);
        expect(issues[0]?.field).toBe('source');
        expect(issues[0]?.message).toMatch(/for "Which ticket" set to "The ticket in this channel"/);

        expect(channelIssuesOn(chain(button(), close()), 'close')).toEqual([]);
        expect(channelIssuesOn(chain(schedule(), node('close', closeTicket.type, { ticketId: '{{var.ticketId}}' })), 'close')).toEqual([]);
    });
});

/**
 * The card, as the builder draws it: each block served over the real `/api/nodes` route and
 * summarised by the browser's own interpreter. The choice speaks only when it is not the
 * default — otherwise the card names the picked channel or the id, as it always did.
 */
describe('the card names the choice only when it is not the default', () => {
    const CHANNELS: GuildChannel[] = [
        { id: PICKED_ID, name: 'dungeon', type: 'text', parentId: null, parentName: null, owner: null },
    ];
    let served: readonly NodeDescriptor[] = [];

    beforeAll(async () => {
        await ensureBlocksDiscovered();
        const response = await nodeRoutes().request('/');
        served = ((await response.json()) as { nodes: readonly NodeDescriptor[] }).nodes;
    }, 30_000);

    function cardOf(type: string, config: Record<string, unknown>): string {
        const descriptor = served.find((candidate) => candidate.type === type);
        if (!descriptor) throw new Error(`GET /api/nodes did not serve ${type}`);
        // A single assertion, for the variance reason `oneDirectoryBlock.test.ts` gives.
        return summarizeFromDescriptor(descriptor as BrowserNodeDescriptor, config, [], CHANNELS, [], []);
    }

    it.each([postEmbed.type, sendMessage.type])('%s names the picked channel, picked or left unset', (type) => {
        const message = type === postEmbed.type ? { embeds: [{ title: 'Kneel.' }] } : 'Kneel.';

        expect(cardOf(type, { channelId: PICKED_ID, message })).toBe('#dungeon · "Kneel."');
        expect(cardOf(type, { where: 'channel', channelId: PICKED_ID, message })).toBe('#dungeon · "Kneel."');
    });

    it.each([postEmbed.type, sendMessage.type])('%s says this channel instead of the one the picker still holds', (type) => {
        const message = type === postEmbed.type ? { embeds: [{ title: 'Kneel.' }] } : 'Kneel.';

        expect(cardOf(type, { where: 'here', channelId: PICKED_ID, message })).toBe('The channel this happened in · "Kneel."');
    });

    it('Close Ticket names the id by default, and the ticket in this channel otherwise', () => {
        expect(cardOf(closeTicket.type, { ticketId: '{{var.ticketId}}' })).toBe('Closes {{var.ticketId}}');
        expect(cardOf(closeTicket.type, { source: 'here', ticketId: '{{var.ticketId}}' })).toBe('The ticket in this channel');
    });
});

describe('channelFor', () => {
    it.each([
        [{ where: 'channel', channelId: PICKED_ID }, PICKED_ID],
        [{ where: 'here' }, RUN_CHANNEL_ID],
    ] as const satisfies readonly (readonly [ChannelChoiceConfig, string])[])('hands back the channel for %j', async (config, id) => {
        expect((await channelFor(contextWith(), config)).id).toBe(id);
    });

    it('fails by name for "a channel I pick" with none picked — the schema check regressed', async () => {
        await expect(channelFor(contextWith(), { where: 'channel' })).rejects.toThrow(/checkChannelChoice` has regressed/);
    });
});

/**
 * Which blocks take the choice, read off the blocks themselves rather than a list naming
 * them: a block posting through `channelFor` declares the shared field, the shared picker
 * shown by it, and the card part naming it.
 */
describe('every block posting through the channel choice declares it', () => {
    const blocksDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const blockDirectories = readdirSync(blocksDir).filter(
        (entry) => entry !== '__tests__' && statSync(join(blocksDir, entry)).isDirectory()
    );
    const sourceOf = (directory: string): string => readFileSync(join(blocksDir, directory, 'index.ts'), 'utf8');
    const choosing = blockDirectories.filter((directory) => sourceOf(directory).includes('channelFor('));

    it('finds the blocks it means to', () => {
        expect(choosing.sort()).toEqual(['actionPostEmbed', 'actionSendMessage']);
    });

    it.each(choosing)('%s declares the shared choice, its picker and its card part', async (directory) => {
        const loaded: { readonly block: BlockManifest } = await import(pathToFileURL(join(blocksDir, directory, 'index.ts')).href);
        const { block: definition } = loaded;

        expect(definition.configFields).toContainEqual(CHANNEL_CHOICE_FIELD);
        expect(definition.configFields).toContainEqual(CHANNEL_PICKER_FIELD);
        // Named on the card only while it is not the default.
        expect(definition.cardSummary).toContainEqual(CHANNEL_CHOICE_CARD_PART);
        expect(definition.requires).not.toContain('channel');
    });
});
