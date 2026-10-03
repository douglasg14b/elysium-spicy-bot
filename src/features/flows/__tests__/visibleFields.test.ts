import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CONDITION_TIME_SINCE } from '../blocks/conditionTimeSince';
import { effectiveFieldValue, isFieldVisible, type BlockConfigField, type BlockManifest } from '../blocks/manifest';
import { ensureBlocksDiscovered, getBlockDefinition } from '../blocks/registry';
import type { FlowRunSeed } from '../blocks/types';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../data/flowGraph';
import { executeFlowSegment } from '../engine/executor';
import { validateAuthoredGraph } from '../engine/graphValidation';
import { validateNodeData } from '../engine/nodeDataValidation';
import { collectApplicableResourceTargets, collectResourceTargets } from '../logic/resourceTargets';
import { FIXTURE_SOMETIMES, MESSAGE_MAX_LENGTH } from './fixtures/blocks/contract/actionSometimes';

/**
 * A field its `visibleWhen` hides does not exist for a run or a save.
 *
 * The node keeps whatever a hidden field held — the builder seeds every default on drop
 * and switching the sibling clears nothing — so these cases plant a stale `{{var}}` in
 * exactly the two kinds of field the executor resolves before `run`, and require that
 * neither fails the run nor refuses the save. The control cases show the same value
 * *does* fail once the field is shown, so a pass here cannot be a check that never runs.
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

/** A token naming a variable nothing in these graphs records. */
const STALE = '{{var.gone}}';

function seed(): FlowRunSeed {
    return {
        client: {} as FlowRunSeed['client'],
        guild: { id: 'guild-1', name: 'Afterdark' } as FlowRunSeed['guild'],
        subject: { id: 'user-1' } as FlowRunSeed['subject'],
        variables: {},
    };
}

/** member join -> one node of `type` holding `data`. */
function oneNode(type: string, data: Record<string, unknown>): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'trigger', type: 'trigger.memberJoin', position: { x: 0, y: 0 }, data: {} },
            { id: 'node', type, position: { x: 1, y: 0 }, data },
        ],
        edges: [{ id: 'e1', source: 'trigger', target: 'node' }],
    } as FlowGraph;
}

async function run(graph: FlowGraph) {
    return executeFlowSegment('flow-1', graph, seed(), { runId: 'run-1', startNodeId: 'trigger', requireTrigger: true });
}

function sometimes(): BlockManifest {
    const block = getBlockDefinition(FIXTURE_SOMETIMES);
    if (!block) throw new Error('the fixture block was not discovered');
    return block;
}

describe('a hidden field holding a stale {{var}}', () => {
    const stale = oneNode(FIXTURE_SOMETIMES, { mode: 'plain', message: `${STALE} hi`, channelId: STALE });

    it('neither fails the run nor reaches run at all', async () => {
        const spy = vi.spyOn(sometimes(), 'run');

        const outcome = await run(stale);

        expect(outcome.kind).toBe('completed');
        if (outcome.kind !== 'completed') return;
        expect(outcome.result.status).toBe('success');
        // Dropped, not merely left unrendered: `run` cannot read a value that does
        // not apply.
        expect(spy.mock.calls[0]?.[0]).toEqual({ mode: 'plain' });
    });

    it('does not refuse the save', () => {
        expect(validateAuthoredGraph(stale)).toEqual({ valid: true, graph: stale });
    });

    it('fails the run once the copy field is shown, so the skip is what passed above', async () => {
        const shown = oneNode(FIXTURE_SOMETIMES, { mode: 'copy', message: `${STALE} hi`, channelId: STALE });

        const outcome = await run(shown);

        expect(outcome.kind === 'completed' && outcome.result.status).toBe('error');
        // The copy check accepts any {{var}} on sight, so only the run refuses this one.
        expect(validateAuthoredGraph(shown).valid).toBe(true);
    });

    it('fails both once the channel picker is shown', async () => {
        const shown = oneNode(FIXTURE_SOMETIMES, { mode: 'channel', message: `${STALE} hi`, channelId: STALE });

        const outcome = await run(shown);

        expect(outcome.kind === 'completed' && outcome.result.error).toMatch(/nothing has recorded it/);
        const saved = validateAuthoredGraph(shown);
        expect(saved.valid ? [] : saved.errors).toEqual([
            expect.stringMatching(/"Channel" set to \{\{var\.gone\}\}, but no block in this flow records a channel/),
        ]);
    });

    it('hands run the shown field, rendered', async () => {
        const spy = vi.spyOn(sometimes(), 'run');

        await run(oneNode(FIXTURE_SOMETIMES, { mode: 'copy', message: 'Hi {{guild.name}}', channelId: STALE }));

        expect(spy.mock.calls[0]?.[0]).toEqual({ mode: 'copy', message: 'Hi Afterdark' });
    });
});

describe('the quiet-timeout channel, the first shipped field to hide', () => {
    /** member join -> delay holding `data` -> a DM, so the delay has somewhere to wake to. */
    function delayGraph(data: Record<string, unknown>): FlowGraph {
        const graph = oneNode('action.delay', { durationMs: 60_000, ...data });
        return {
            ...graph,
            nodes: [...graph.nodes, { id: 'after', type: 'action.sendDM', position: { x: 2, y: 0 }, data: { message: 'Hi' } }],
            edges: [...graph.edges, { id: 'e2', source: 'node', target: 'after' }],
        } as FlowGraph;
    }

    it('is ignored while the time limit counts from the wait itself', async () => {
        const graph = delayGraph({ timeoutCountsFrom: 'waitStart', quietChannelId: STALE });

        expect(validateAuthoredGraph(graph)).toEqual({ valid: true, graph });
        expect((await run(graph)).kind).toBe('suspended');
    });

    it('is checked once it applies', () => {
        const graph = delayGraph({ timeoutCountsFrom: 'memberMessage', quietChannelId: STALE });

        const saved = validateAuthoredGraph(graph);
        expect(saved.valid ? [] : saved.errors).toEqual([expect.stringMatching(/"Messages in" set to \{\{var\.gone\}\}/)]);
    });
});

describe("Time Since's channel, hidden while measuring from a saved time", () => {
    function timeSince(): BlockManifest {
        const block = getBlockDefinition(CONDITION_TIME_SINCE);
        if (!block) throw new Error('Time Since was not discovered');
        return block;
    }

    /** join -> one Time Since on `source`, holding a stale channel from an earlier source. */
    const since = (source: string) =>
        oneNode(CONDITION_TIME_SINCE, { source, timeVariable: 'seenAt', channelId: STALE, durationMs: 60_000 });

    it('never reaches run, so the stale {{var}} is neither resolved nor checked', async () => {
        const spy = vi.spyOn(timeSince(), 'run');

        const outcome = await run(since('variable'));

        expect(outcome.kind === 'completed' && outcome.result.status).toBe('success');
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]?.[0]).not.toHaveProperty('channelId');
    });

    it('fails the run once the channel applies, so the skip is what passed above', async () => {
        const spy = vi.spyOn(timeSince(), 'run');

        const outcome = await run(since('memberMessage'));

        expect(outcome.kind === 'completed' && outcome.result.error).toMatch(/nothing has recorded it/);
        expect(spy).not.toHaveBeenCalled();
    });
});

describe('a hidden field holding a value over its own limit', () => {
    const tooLong = 'x'.repeat(MESSAGE_MAX_LENGTH + 10);

    it('neither refuses the save nor fails the run, since the schema never sees it', async () => {
        const hidden = oneNode(FIXTURE_SOMETIMES, { mode: 'plain', message: tooLong });

        expect(validateNodeData(hidden)).toEqual({ valid: true });
        const outcome = await run(hidden);
        expect(outcome.kind === 'completed' && outcome.result.status).toBe('success');
    });

    it('is refused once shown', () => {
        const shown = oneNode(FIXTURE_SOMETIMES, { mode: 'copy', message: tooLong });

        expect(validateNodeData(shown)).toMatchObject({ valid: false, issues: [{ nodeId: 'node', field: 'message' }] });
    });
});

describe('a hidden picker’s resource sidecar', () => {
    const data = { channelId: '', channelIdKey: 'lobby' };
    const target = { nodeId: 'node', configKey: 'channelId', resourceKey: 'lobby' };

    it('neither waits on an install nor is blamed while hidden', () => {
        expect(collectApplicableResourceTargets(oneNode(FIXTURE_SOMETIMES, { mode: 'plain', ...data }))).toEqual([]);
        expect(collectApplicableResourceTargets(oneNode(FIXTURE_SOMETIMES, { mode: 'channel', ...data }))).toEqual([
            target,
        ]);
    });

    it('is still written by install, so showing the field again finds the id there', () => {
        expect(collectResourceTargets(oneNode(FIXTURE_SOMETIMES, { mode: 'plain', ...data }))).toEqual([target]);
    });
});

describe('the one reading of a field’s current value', () => {
    const mode: BlockConfigField = {
        key: 'mode',
        label: 'Mode',
        control: 'segmented',
        defaultValue: 'plain',
        options: [
            { value: 'plain', label: 'Plain' },
            { value: 'copy', label: 'Copy' },
        ],
    };
    const message: BlockConfigField = {
        key: 'message',
        label: 'Message',
        control: 'longText',
        visibleWhen: { field: 'mode', equals: ['copy'] },
    };
    const fields = [mode, message];

    it('is the stored value, or the default when nothing — or an empty string — is stored', () => {
        expect(effectiveFieldValue(mode, { mode: 'copy' })).toBe('copy');
        expect(effectiveFieldValue(mode, {})).toBe('plain');
        expect(effectiveFieldValue(mode, { mode: '' })).toBe('plain');
    });

    it('decides visibility from the sibling’s value, falling back to its default', () => {
        expect(isFieldVisible(message, fields, { mode: 'copy' })).toBe(true);
        expect(isFieldVisible(message, fields, { mode: 'plain', message: 'held anyway' })).toBe(false);
        expect(isFieldVisible(message, fields, {})).toBe(false);
        expect(isFieldVisible(mode, fields, {})).toBe(true);
    });

    it('shows a field whose sibling cannot be found rather than hiding it unexplained', () => {
        expect(isFieldVisible(message, [message], {})).toBe(true);
    });
});
