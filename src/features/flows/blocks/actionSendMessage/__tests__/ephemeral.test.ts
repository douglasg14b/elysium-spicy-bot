import type { EmbedBuilder } from 'discord.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { summarizeFromDescriptor } from '../../../../../../web/src/flows/cardSummary';
import { nodeRoutes, type NodeDescriptor } from '../../../../../web/api/nodeRoutes';
import type { NodeDescriptor as BrowserNodeDescriptor } from '@brattybot/web-sdk';
import { fakeGuild } from '../../../__tests__/support/fakeGuild';
import { FLOW_GRAPH_VERSION, type FlowGraph, type FlowNode } from '../../../data/flowGraph';
import { authoredGraphIssues } from '../../../engine/graphValidation';
import { describeMissingRequirement, effectiveRequirements, missingRequirement } from '../../../engine/nodeRequirements';
import { ACTION_DELAY } from '../../actionDelay';
import { parseNodeConfig, type BlockManifest } from '../../manifest';
import { ensureBlocksDiscovered } from '../../registry';
import { TRIGGER_BUTTON_CLICK } from '../../triggerButtonClick';
import { TRIGGER_SCHEDULE } from '../../triggerSchedule';
import type { FlowRunContext } from '../../types';
import { ACTION_SEND_MESSAGE, block as sendMessage } from '..';

/**
 * Send Message's "Only the person who clicked sees it": a reply to the button press itself,
 * not a post in a channel.
 *
 * Driven through the config parse the executor uses (so a hidden box is absent, as it is at
 * run time), the real requirement worker and validator (so a ticked box is refused where the
 * press is gone), and the real `/api/nodes` descriptor with the browser's own card reader.
 */

const RUN_CHANNEL_ID = 'run-channel-1';
const PICKED_ID = 'picked-1';
const TEXT = 'Not yet, pet.';
const MESSAGE = { content: TEXT, embeds: [] };
const BUTTONS = [{ key: 'beg', label: 'Beg', style: 'Primary' }];

const channelSend = vi.fn();
const followUp = vi.fn();

beforeEach(() => {
    channelSend.mockReset().mockResolvedValue({ id: 'sent-1' });
    followUp.mockReset().mockResolvedValue(undefined);
});

/** A run in the channel the press happened in, with or without the press itself. */
function contextWith(options: { readonly press: boolean }): FlowRunContext {
    const channel = { id: RUN_CHANNEL_ID, send: channelSend };
    return {
        client: {} as FlowRunContext['client'],
        guild: fakeGuild({ id: 'guild-1', channels: { [RUN_CHANNEL_ID]: channel, [PICKED_ID]: channel } }),
        channel: channel as unknown as FlowRunContext['channel'],
        ...(options.press ? { interaction: { followUp } as unknown as FlowRunContext['interaction'] } : {}),
        runId: 'run-1',
        flowId: 'flow-1',
        nodeId: 'node-1',
        chainDepth: 1,
        variables: {},
        setOutput: () => {},
    };
}

/** Run the block on raw node data, parsed exactly as the executor parses it. */
async function runOn(data: Record<string, unknown>, context = contextWith({ press: true })) {
    const registered: BlockManifest = sendMessage;
    const parsed = parseNodeConfig(registered, data);
    if (!parsed.success) throw new Error(`refused ${JSON.stringify(data)}: ${parsed.error.message}`);
    return registered.run(parsed.data, context);
}

describe('running with the box ticked', () => {
    it('answers the press privately, posting nothing in the channel', async () => {
        expect(await runOn({ where: 'here', ephemeral: true, message: MESSAGE })).toEqual({ kind: 'continue' });

        expect(followUp).toHaveBeenCalledExactlyOnceWith({
            content: TEXT,
            embeds: [],
            files: [],
            components: [],
            ephemeral: true,
            allowedMentions: { parse: ['users'] },
        });
        expect(channelSend).not.toHaveBeenCalled();
    });

    it('answers with an embed too, the whole message in the one private follow-up', async () => {
        const message = { content: TEXT, embeds: [{ title: 'House rules', description: 'Kneel first.' }] };

        expect(await runOn({ where: 'here', ephemeral: true, message })).toEqual({ kind: 'continue' });

        expect(followUp).toHaveBeenCalledOnce();
        const sent: unknown = followUp.mock.calls[0]?.[0];
        expect(sent).toMatchObject({ content: TEXT, ephemeral: true, files: [], components: [] });
        const embeds = (sent as { embeds: readonly EmbedBuilder[] }).embeds;
        expect(embeds.map((embed) => embed.toJSON())).toEqual([
            expect.objectContaining({ title: 'House rules', description: 'Kneel first.' }),
        ]);
        expect(channelSend).not.toHaveBeenCalled();
    });

    it('fails without answering when the message comes out as nothing but blank space', async () => {
        const result = await runOn({ where: 'here', ephemeral: true, message: { content: '   ', embeds: [] } });

        expect(result).toMatchObject({ kind: 'fail' });
        expect(followUp).not.toHaveBeenCalled();
    });

    it.each([
        ['unticked', { where: 'here', ephemeral: false }],
        ['left unset', { where: 'here' }],
    ])('posts in the channel when the box is %s', async (_name, data) => {
        await runOn({ ...data, message: MESSAGE });

        expect(channelSend).toHaveBeenCalledOnce();
        expect(followUp).not.toHaveBeenCalled();
    });

    it('ignores a tick left over from before the author switched to a channel they pick', async () => {
        // Hidden means absent: the box is shown only under "here", but the node still holds it.
        await runOn({ where: 'channel', channelId: PICKED_ID, ephemeral: true, message: MESSAGE });

        expect(channelSend).toHaveBeenCalledOnce();
        expect(followUp).not.toHaveBeenCalled();
    });

    it('fails by name, sending nothing, when the run has no press — the requirement check regressed', async () => {
        await expect(
            runOn({ where: 'here', ephemeral: true, message: MESSAGE }, contextWith({ press: false }))
        ).rejects.toThrow(/answer the button press privately, and this run has none/);
        expect(channelSend).not.toHaveBeenCalled();
    });
});

describe('what ticking the box needs from the run', () => {
    const needs = (data: Record<string, unknown>) =>
        effectiveRequirements(sendMessage, data).map(({ requirement }) => requirement);

    it('adds the press to the channel it already needs under "here"', () => {
        expect(needs({ where: 'here', ephemeral: true })).toEqual(['channel', 'interaction']);
    });

    it.each([
        ['unticked', { where: 'here', ephemeral: false }],
        ['unset', { where: 'here' }],
        ['ticked but hidden under a picked channel', { where: 'channel', channelId: PICKED_ID, ephemeral: true }],
    ])('adds nothing when the box is %s', (_name, data) => {
        expect(needs(data)).not.toContain('interaction');
    });

    it('is held to by the executor, which fails the step naming the box', () => {
        const data = { where: 'here', ephemeral: true };
        const seed = contextWith({ press: false });

        const missing = missingRequirement(sendMessage, data, seed);

        expect(missing?.requirement).toBe('interaction');
        expect(describeMissingRequirement('send', ACTION_SEND_MESSAGE, missing!, 'started')).toBe(
            'Node send (action.sendMessage) needs the interaction that started the run for ' +
                '"Only the person who clicked sees it" ticked, and this run has none.'
        );
        expect(missingRequirement(sendMessage, data, contextWith({ press: true }))).toBeUndefined();
    });
});

/**
 * Save, through the real validator: a ticked box is refused wherever the press is gone — below
 * a trigger that is not a button, or after a pause — and accepted straight below a button.
 */
describe('where save allows the box ticked', () => {
    beforeAll(ensureBlocksDiscovered);

    const node = (id: string, type: string, data: Record<string, unknown> = {}): FlowNode => ({
        id,
        type,
        position: { x: 0, y: 0 },
        data,
    });
    const chain = (...nodes: FlowNode[]): FlowGraph => ({
        version: FLOW_GRAPH_VERSION,
        nodes,
        edges: nodes.slice(1).map((target, index) => ({ id: `e${index}`, source: nodes[index]?.id ?? '', target: target.id })),
    });
    const button = (): FlowNode => node('trigger', TRIGGER_BUTTON_CLICK, { button: { messageKey: 'panel', buttonKey: 'go' } });
    const reply = (): FlowNode =>
        node('reply', ACTION_SEND_MESSAGE, { where: 'here', ephemeral: true, message: MESSAGE });
    const pressIssuesOn = (graph: FlowGraph) =>
        authoredGraphIssues(graph).filter((issue) => issue.nodeId === 'reply' && /needs "interaction"/.test(issue.message));

    it('accepts it straight below a button click', () => {
        expect(pressIssuesOn(chain(button(), reply()))).toEqual([]);
    });

    it('refuses it after a pause, under the box', () => {
        const issues = pressIssuesOn(chain(button(), node('wait', ACTION_DELAY, { durationMs: 60_000 }), reply()));

        expect(issues).toHaveLength(1);
        expect(issues[0]?.field).toBe('ephemeral');
        expect(issues[0]?.message).toMatch(
            /for "Only the person who clicked sees it" ticked, but it can be reached after a block that parks the run/
        );
    });

    it('refuses it below a Schedule, which has no press', () => {
        const issues = pressIssuesOn(
            chain(node('trigger', TRIGGER_SCHEDULE, { repeat: 'daily', time: '09:00' }), reply())
        );

        expect(issues).toHaveLength(1);
        expect(issues[0]?.message).toMatch(/can be reached from a trigger that fires on a gateway event/);
    });

    it('lets the same message be posted publicly after a pause', () => {
        const publicReply = node('reply', ACTION_SEND_MESSAGE, { where: 'here', message: MESSAGE });

        expect(
            pressIssuesOn(chain(button(), node('wait', ACTION_DELAY, { durationMs: 60_000 }), publicReply))
        ).toEqual([]);
    });
});

/**
 * Buttons under a private answer: refused at save, under the buttons. Parsed as save and the
 * executor parse, so a box hidden under a picked channel is absent and refuses nothing.
 */
describe('buttons beside the box', () => {
    const issuesOf = (data: Record<string, unknown>) => {
        const registered: BlockManifest = sendMessage;
        const parsed = parseNodeConfig(registered, data);
        return parsed.success ? [] : parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message }));
    };

    it('refuses buttons on a message only the clicker sees, naming the buttons', () => {
        expect(issuesOf({ where: 'here', ephemeral: true, message: MESSAGE, buttons: BUTTONS })).toEqual([
            {
                path: ['buttons'],
                message: "Buttons can't go on a message only the clicker sees — untick that, or drop the buttons.",
            },
        ]);
    });

    it.each([
        ['an empty button list under a ticked box', { where: 'here', ephemeral: true, buttons: [] }],
        ['buttons under an unticked box', { where: 'here', ephemeral: false, buttons: BUTTONS }],
        ['buttons under a tick hidden by a picked channel', { where: 'channel', channelId: PICKED_ID, ephemeral: true, buttons: BUTTONS }],
    ])('accepts %s', (_name, data) => {
        expect(issuesOf({ ...data, message: MESSAGE })).toEqual([]);
    });
});

describe('the card, as the builder draws it', () => {
    let served: readonly NodeDescriptor[] = [];

    beforeAll(async () => {
        await ensureBlocksDiscovered();
        const response = await nodeRoutes().request('/');
        served = ((await response.json()) as { nodes: readonly NodeDescriptor[] }).nodes;
    }, 30_000);

    const cardOf = (config: Record<string, unknown>): string => {
        const descriptor = served.find((candidate) => candidate.type === ACTION_SEND_MESSAGE);
        if (!descriptor) throw new Error(`GET /api/nodes did not serve ${ACTION_SEND_MESSAGE}`);
        return summarizeFromDescriptor(descriptor as BrowserNodeDescriptor, config, [], [], [], []);
    };

    it('says so while the box is ticked', () => {
        expect(cardOf({ where: 'here', ephemeral: true, message: MESSAGE })).toBe(
            'The channel this happened in · Only the person who clicked sees it · "Not yet, pet."'
        );
    });

    it.each([
        ['unticked', { where: 'here', ephemeral: false }],
        ['unset', { where: 'here' }],
        ['ticked but hidden under a picked channel', { where: 'channel', channelId: PICKED_ID, ephemeral: true }],
    ])('says nothing of it when the box is %s', (_name, data) => {
        expect(cardOf({ ...data, message: MESSAGE })).not.toContain('Only the person who clicked');
    });
});
