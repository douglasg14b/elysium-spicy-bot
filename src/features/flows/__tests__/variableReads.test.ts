import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveOutputValueKind, type BlockManifest } from '../blocks/manifest';
import { ensureBlocksDiscovered, getBlockDefinition } from '../blocks/registry';
import type { FlowRunSeed } from '../blocks/types';
import { FLOW_GRAPH_VERSION, type FlowEdge, type FlowGraph, type FlowNode } from '../data/flowGraph';
import { executeFlowSegment } from '../engine/executor';
import { validateAuthoredGraph } from '../engine/graphValidation';
import { FIXTURE_RECORD_TYPED } from './fixtures/blocks/contract/actionRecordTyped';
import { CHECKED_AT, FIXTURE_READ_TIME } from './fixtures/blocks/contract/conditionReadTime';

/**
 * Reading a variable by name (`variableSelect`), and the kind rule it shares with the
 * channel picker.
 *
 * Save refuses a name nothing records, a name recorded only where it cannot have run
 * first, and a name any recording node records as another kind — a kindless one
 * included, since the bag carries no types and the last writer wins. A field declaring
 * no kind takes any variable, so only the path rule applies to it. The channel
 * picker's `{{var}}` is now held to the same "every recording node agrees" rule.
 */

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'blocks', 'contract');

vi.mock('../blocks/registry', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../blocks/registry')>();
    let extra: ReadonlyMap<string, BlockManifest> | undefined;

    return {
        ...actual,
        ensureBlocksDiscovered: async () => {
            await actual.ensureBlocksDiscovered();
            extra ??= await actual.discoverBlocks<BlockManifest>(FIXTURE_ROOT);
        },
        getBlockDefinition: (type: string) => extra?.get(type) ?? actual.getBlockDefinition(type),
    };
});

beforeAll(ensureBlocksDiscovered);

afterEach(() => {
    vi.restoreAllMocks();
});

const node = (id: string, type: string, data: Record<string, unknown> = {}): FlowNode =>
    ({ id, type, position: { x: 0, y: 0 }, data }) as FlowNode;

const edge = (source: string, target: string, sourceHandle?: string): FlowEdge =>
    ({ id: `${source}-${sourceHandle ?? 'out'}-${target}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) }) as FlowEdge;

const graphOf = (nodes: FlowNode[], edges: FlowEdge[]): FlowGraph =>
    ({ version: FLOW_GRAPH_VERSION, nodes, edges }) as FlowGraph;

const trigger = node('trigger', 'trigger.memberJoin');
const recordTime = (id: string, name = 'seenAt') => node(id, FIXTURE_RECORD_TYPED, { outputKey: name, valueType: 'time' });
const recordText = (id: string, name = 'seenAt') => node(id, FIXTURE_RECORD_TYPED, { outputKey: name, valueType: 'text' });
const readTime = (id: string, name = 'seenAt') => node(id, FIXTURE_READ_TIME, { timeVariable: name });

/** The messages a save refuses `graph` with, or none. */
function refusals(graph: FlowGraph): readonly string[] {
    const result = validateAuthoredGraph(graph);
    return result.valid ? [] : result.errors;
}

describe('a variable read by name', () => {
    it('saves when a node before it records that name as the right kind', () => {
        const graph = graphOf(
            [trigger, recordTime('record'), readTime('read')],
            [edge('trigger', 'record'), edge('record', 'read')]
        );

        expect(refusals(graph)).toEqual([]);
    });

    it('is refused when nothing records the name', () => {
        const graph = graphOf([trigger, readTime('read')], [edge('trigger', 'read')]);

        expect(refusals(graph)).toEqual([
            expect.stringMatching(/"Saved time" set to "seenAt", but no block in this flow records a time by that name/),
        ]);
    });

    it('is refused when the name is only recorded after it', () => {
        const graph = graphOf(
            [trigger, readTime('read'), recordTime('record')],
            [edge('trigger', 'read'), edge('read', 'record', 'true')]
        );

        expect(refusals(graph)).toEqual([expect.stringMatching(/only blocks after it or on another branch record it/)]);
    });

    it('is refused when the name is only recorded on a branch that cannot lead to it', () => {
        const graph = graphOf(
            [trigger, node('booster', 'condition.isBooster'), recordTime('record'), readTime('read')],
            [edge('trigger', 'booster'), edge('booster', 'record', 'true'), edge('booster', 'read', 'false')]
        );

        expect(refusals(graph)).toEqual([expect.stringMatching(/only blocks after it or on another branch record it/)]);
    });

    it('honours a value written on one exit only, as the builder offers it', () => {
        // `checkedAt` is recorded on the first reader's Yes, so it is there down Yes
        // and absent down No.
        const graph = (handle: string) =>
            graphOf(
                [trigger, recordTime('record'), readTime('first'), readTime('second', CHECKED_AT)],
                [edge('trigger', 'record'), edge('record', 'first'), edge('first', 'second', handle)]
            );

        expect(refusals(graph('true'))).toEqual([]);
        expect(refusals(graph('noRecord'))).toEqual([
            expect.stringMatching(/"checkedAt", but only blocks after it or on another branch record it/),
        ]);
    });

    it('is refused when another node records the name as plain text, naming both nodes', () => {
        // A kindless producer is exactly the case a map of kinds would drop: here a
        // text value and a time share one name, and the run keeps whichever wrote last.
        const graph = graphOf(
            [trigger, recordTime('record'), recordText('text'), readTime('read')],
            [edge('trigger', 'record'), edge('record', 'text'), edge('text', 'read')]
        );

        expect(refusals(graph)).toEqual([
            expect.stringMatching(
                /node record \(Record Typed\) records "seenAt" as a time, but node text \(Record Typed\) records it as a plain value/
            ),
        ]);
    });

    it('is refused when a Pick at Random shares the name, even on another branch', () => {
        const graph = graphOf(
            [
                trigger,
                node('booster', 'condition.isBooster'),
                recordTime('record'),
                node('pick', 'action.pickRandom', { options: ['a', 'b'], outputKey: 'seenAt' }),
                readTime('read'),
            ],
            [
                edge('trigger', 'booster'),
                edge('booster', 'record', 'true'),
                edge('booster', 'pick', 'false'),
                edge('record', 'read'),
            ]
        );

        expect(refusals(graph)).toEqual([expect.stringMatching(/node pick \(Pick at Random\) records it as a plain value/)]);
    });

    it('is handed to the block as the bare name, untouched by the executor', async () => {
        const reader = getBlockDefinition(FIXTURE_READ_TIME);
        if (!reader) throw new Error('the fixture block was not discovered');
        const spy = vi.spyOn(reader, 'run');
        const graph = graphOf(
            [trigger, recordTime('record'), readTime('read')],
            [edge('trigger', 'record'), edge('record', 'read')]
        );
        const seed: FlowRunSeed = {
            client: {} as FlowRunSeed['client'],
            guild: { id: 'guild-1' } as FlowRunSeed['guild'],
            subject: { id: 'user-1' } as FlowRunSeed['subject'],
            variables: {},
        };

        const outcome = await executeFlowSegment('flow-1', graph, seed, {
            runId: 'run-1',
            startNodeId: 'trigger',
            requireTrigger: true,
        });

        expect(spy.mock.calls[0]?.[0]).toEqual({ timeVariable: 'seenAt' });
        expect(outcome.kind === 'completed' && outcome.result.log.at(-1)).toMatchObject({ nodeId: 'read', branch: 'true' });
    });
});

describe('a variable read by name, of any kind', () => {
    // Compare's `variableName` declares no kind, so it takes whatever is recorded.
    const compareText = (id: string, name = 'seenAt') =>
        node(id, 'condition.compare', { variableName: name, operator: 'is', value: 'x' });

    it('saves when a node before it records the name as plain text', () => {
        const graph = graphOf(
            [trigger, recordText('record'), compareText('read')],
            [edge('trigger', 'record'), edge('record', 'read')]
        );

        expect(refusals(graph)).toEqual([]);
    });

    it('saves when the nodes recording the name disagree on its kind', () => {
        const graph = graphOf(
            [trigger, recordTime('record'), recordText('text'), compareText('read')],
            [edge('trigger', 'record'), edge('record', 'text'), edge('text', 'read')]
        );

        expect(refusals(graph)).toEqual([]);
    });

    it('is still refused when the name is only recorded after it', () => {
        const graph = graphOf(
            [trigger, compareText('read'), recordText('record')],
            [edge('trigger', 'read'), edge('read', 'record', 'true')]
        );

        expect(refusals(graph)).toEqual([expect.stringMatching(/only blocks after it or on another branch record it/)]);
    });

    it('is refused as recorded by nothing, rather than as recorded later, when nothing records it', () => {
        const graph = graphOf([trigger, compareText('read')], [edge('trigger', 'read')]);

        expect(refusals(graph)).toEqual([
            expect.stringMatching(/"Variable" set to "seenAt", but no block in this flow records anything by that name\.$/),
        ]);
    });
});

describe('a channel picker holding a {{var}}', () => {
    const sendTo = node('send', 'action.sendMessage', { channelId: '{{var.ticketChannelId}}', message: 'Hi' });
    const hasTicket = node('ticket', 'condition.hasOpenTicket', { ticketType: 'support' });

    it('saves when every node recording the name records a channel', () => {
        const graph = graphOf([trigger, hasTicket, sendTo], [edge('trigger', 'ticket'), edge('ticket', 'send', 'true')]);

        expect(refusals(graph)).toEqual([]);
    });

    it('is refused when a text value shares a channel variable’s name', () => {
        // The looser rule asked only whether *some* node recorded a channel by that
        // name, so this saved — and fed Discord a line of text as a channel id.
        const graph = graphOf(
            [trigger, hasTicket, recordText('text', 'ticketChannelId'), sendTo],
            [edge('trigger', 'ticket'), edge('ticket', 'text', 'true'), edge('text', 'send')]
        );

        expect(refusals(graph)).toEqual([
            expect.stringMatching(
                /node ticket \(Has Open Ticket\?\) records "ticketChannelId" as a channel, but node text \(Record Typed\) records it as a plain value/
            ),
        ]);
    });
});

describe('an output whose kind a field decides', () => {
    it('resolves to the kind its current choice maps to, the default when untouched, and none otherwise', () => {
        const recorder = getBlockDefinition(FIXTURE_RECORD_TYPED);
        if (!recorder) throw new Error('the fixture block was not discovered');
        const [output] = recorder.outputs;
        if (!output) throw new Error('the fixture declares no output');

        expect(resolveOutputValueKind(output, recorder.configFields, { valueType: 'time' })).toBe('time');
        expect(resolveOutputValueKind(output, recorder.configFields, { valueType: 'text' })).toBeUndefined();
        expect(resolveOutputValueKind(output, recorder.configFields, {})).toBeUndefined();
    });

    it('resolves a static kind directly', () => {
        const ticket = getBlockDefinition('condition.hasOpenTicket');
        const channelOutput = ticket?.outputs.find((output) => output.naming === 'fixed' && output.key === 'ticketChannelId');
        if (!ticket || !channelOutput) throw new Error('condition.hasOpenTicket no longer records a channel');

        expect(resolveOutputValueKind(channelOutput, ticket.configFields, {})).toBe('channel');
    });
});
