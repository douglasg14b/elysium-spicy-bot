import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureBlocksDiscovered } from '../../registry';
import type { FlowRunContext, FlowRunSeed, FlowVariableValue } from '../../types';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../../data/flowGraph';
import { executeFlow, executeFlowSegment } from '../../../engine/executor';
import type { FlowSuspension } from '../../../engine/executor';
import { validateNodeData } from '../../../engine/nodeDataValidation';
import { ACTION_SET_VARIABLE, block, setVariableConfigSchema } from '../index';

/**
 * Set Variable writes the type the author picked, and refuses — at save — to write
 * something they did not type.
 *
 * `run` is driven with a recording context for the per-type writes, and the real
 * executor for the one thing only it does: render the text's tokens before `run`. The
 * refusals go through `validateNodeData`, the save path, so a hidden field's stale
 * value is left out exactly as it is for a real save.
 */

beforeAll(ensureBlocksDiscovered);

afterEach(() => {
    vi.useRealTimers();
});

/** A context that records what the block writes, which is its whole job. */
function recordingContext(variables: Readonly<Record<string, FlowVariableValue>> = {}): {
    context: FlowRunContext;
    writes: Map<string, FlowVariableValue>;
} {
    const writes = new Map<string, FlowVariableValue>();
    return {
        writes,
        context: {
            client: {} as FlowRunContext['client'],
            guild: { id: 'guild-1' } as FlowRunContext['guild'],
            subject: {} as FlowRunContext['subject'],
            runId: 'run-1',
            nodeId: 'node-1',
            variables,
            setOutput: (key, value) => {
                writes.set(key, value);
            },
        },
    };
}

/** Run the block on raw node data, parsed first as the executor parses it. */
async function written(data: Record<string, unknown>): Promise<FlowVariableValue | undefined> {
    const { context, writes } = recordingContext();
    const outcome = await block.run(setVariableConfigSchema.parse(data), context);
    expect(outcome).toEqual({ kind: 'continue' });
    return writes.get(String(data.variableName));
}

/** member join -> one Set Variable holding `data`. */
function oneNode(data: Record<string, unknown>): FlowGraph {
    return {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'trigger', type: 'trigger.memberJoin', position: { x: 0, y: 0 }, data: {} },
            { id: 'set', type: ACTION_SET_VARIABLE, position: { x: 1, y: 0 }, data },
        ],
        edges: [{ id: 'e1', source: 'trigger', target: 'set' }],
    } as FlowGraph;
}

/** What a save says about one Set Variable node, field by field. */
function saveIssues(data: Record<string, unknown>): { field?: string; message: string }[] {
    const result = validateNodeData(oneNode(data));
    return result.valid ? [] : result.issues.map(({ field, message }) => ({ field, message }));
}

describe('what each type writes', () => {
    it('writes text as the string, a number as a number, and true or false as a boolean', async () => {
        expect(await written({ variableName: 'mood', valueType: 'text', textValue: 'insatiable' })).toBe('insatiable');
        expect(await written({ variableName: 'count', valueType: 'number', numberValue: ' -2.5 ' })).toBe(-2.5);
        expect(await written({ variableName: 'zero', valueType: 'number', numberValue: '0' })).toBe(0);
        expect(await written({ variableName: 'flag', valueType: 'boolean', booleanValue: 'true' })).toBe(true);
        expect(await written({ variableName: 'flag', valueType: 'boolean', booleanValue: 'false' })).toBe(false);
    });

    it('writes the current time as a strict ISO-8601 UTC string', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-02T21:15:00.000Z'));

        const value = await written({ variableName: 'seenAt', valueType: 'time' });

        expect(value).toBe('2026-10-02T21:15:00.000Z');
        expect(new Date(String(value)).toISOString()).toBe(value);
    });

    it('defaults to text, so a node saved before the type was touched still writes its text', async () => {
        expect(await written({ variableName: 'mood', textValue: 'bratty' })).toBe('bratty');
    });
});

describe('adding to a number', () => {
    /** Add `amount` to `count`, which holds `variables.count` before the block runs. */
    async function added(amount: string, variables: Readonly<Record<string, FlowVariableValue>>): Promise<unknown> {
        const { context, writes } = recordingContext(variables);
        const outcome = await block.run(
            setVariableConfigSchema.parse({ variableName: 'count', valueType: 'add', numberValue: amount }),
            context
        );
        return outcome.kind === 'continue' ? writes.get('count') : outcome;
    }

    it('starts a variable that was never set, or set to null, from 0', async () => {
        expect(await added('1', {})).toBe(1);
        expect(await added('1', { count: null })).toBe(1);
    });

    it('adds to a number, and to a string that reads as one, writing a number', async () => {
        expect(await added('1', { count: 2 })).toBe(3);
        expect(await added('2.5', { count: '5' })).toBe(7.5);
    });

    it('takes away with a negative amount', async () => {
        expect(await added('-3', { count: 2 })).toBe(-1);
    });

    it.each([['abc'], [''], [true]] as const)('fails by name when the variable holds %j', async (held) => {
        expect(await added('1', { count: held })).toEqual({
            kind: 'fail',
            error: `"count" holds ${JSON.stringify(held)}, which is not a number, so there is nothing to add 1 to.`,
        });
    });

    it('fails by name on a snowflake ID, which is text too big to count exactly', async () => {
        expect(await added('1', { count: '1234567890123456789' })).toEqual({
            kind: 'fail',
            error: '"count" holds "1234567890123456789", which is not a number, so there is nothing to add 1 to.',
        });
    });

    it('fails rather than writing a sum past what can be held exactly', async () => {
        expect(await added('1', { count: Number.MAX_SAFE_INTEGER })).toEqual({
            kind: 'fail',
            error: `Adding 1 to "count" goes past ${Number.MAX_SAFE_INTEGER} — too big to count exactly.`,
        });
    });

    it('rounds away float drift, so adding 0.1 three times makes 0.3', async () => {
        let count: FlowVariableValue = null;
        for (let round = 0; round < 3; round += 1) {
            count = (await added('0.1', { count })) as FlowVariableValue;
        }

        expect(count).toBe(0.3);
        expect(await added('0.25', { count: 1.5 })).toBe(1.75);
    });

    it('refuses a blank or non-numeric amount at save, as Number does', () => {
        expect(saveIssues({ variableName: 'count', valueType: 'add' })).toEqual([
            { field: 'numberValue', message: 'A number, please. Blank is not zero.' },
        ]);
        expect(saveIssues({ variableName: 'count', valueType: 'add', numberValue: 'lots' })).toEqual([
            { field: 'numberValue', message: '"lots" is not a number. Digits, please — 3, -2, 0.5.' },
        ]);
        expect(saveIssues({ variableName: 'count', valueType: 'add', numberValue: '-1' })).toEqual([]);
    });
});

describe('text through the real executor', () => {
    it('renders its tokens before writing them', async () => {
        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                { id: 'trigger', type: 'trigger.memberJoin', position: { x: 0, y: 0 }, data: {} },
                {
                    id: 'set',
                    type: ACTION_SET_VARIABLE,
                    position: { x: 1, y: 0 },
                    data: { variableName: 'greeting', valueType: 'text', textValue: '{{subject.username}} is here' },
                },
                // A park, so the bag the run carries is handed back to look at — with
                // something after it, since a wait with nothing to wait *for* never parks.
                { id: 'delay', type: 'action.delay', position: { x: 2, y: 0 }, data: { durationMs: 60_000 } },
                {
                    id: 'after',
                    type: ACTION_SET_VARIABLE,
                    position: { x: 3, y: 0 },
                    data: { variableName: 'later', valueType: 'time' },
                },
            ],
            edges: [
                { id: 'e1', source: 'trigger', target: 'set' },
                { id: 'e2', source: 'set', target: 'delay' },
                { id: 'e3', source: 'delay', target: 'after' },
            ],
        } as FlowGraph;
        const seed: FlowRunSeed = {
            client: {} as FlowRunSeed['client'],
            guild: { id: 'guild-1', name: 'Afterdark' } as FlowRunSeed['guild'],
            subject: { id: 'user-1', user: { id: 'user-1', username: 'whiplash' } } as unknown as FlowRunSeed['subject'],
            variables: {},
        };
        let parked: FlowSuspension | undefined;

        const result = await executeFlow('flow-1', graph, 'trigger', seed, async (suspension) => {
            parked = suspension;
        });

        expect(result.status).toBe('success');
        expect(parked?.variables).toEqual({ greeting: 'whiplash is here' });
    });

    it.each([[''], [null]])('writes an empty string when its only token renders from %j, rather than failing', async (recorded) => {
        // `{{var.nickname}}` passes the save — the schema judges the text as typed — and
        // renders to nothing once the run recorded the name as empty. That is the value
        // the author asked for, so it is written, not refused.
        const graph: FlowGraph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                { id: 'trigger', type: 'trigger.memberJoin', position: { x: 0, y: 0 }, data: {} },
                {
                    id: 'set',
                    type: ACTION_SET_VARIABLE,
                    position: { x: 1, y: 0 },
                    data: { variableName: 'echo', valueType: 'text', textValue: '{{var.nickname}}' },
                },
                // A park, so the bag is handed back to look at.
                { id: 'delay', type: 'action.delay', position: { x: 2, y: 0 }, data: { durationMs: 60_000 } },
                {
                    id: 'after',
                    type: ACTION_SET_VARIABLE,
                    position: { x: 3, y: 0 },
                    data: { variableName: 'later', valueType: 'time' },
                },
            ],
            edges: [
                { id: 'e1', source: 'trigger', target: 'set' },
                { id: 'e2', source: 'set', target: 'delay' },
                { id: 'e3', source: 'delay', target: 'after' },
            ],
        } as FlowGraph;
        const seed: FlowRunSeed = {
            client: {} as FlowRunSeed['client'],
            guild: { id: 'guild-1', name: 'Afterdark' } as FlowRunSeed['guild'],
            subject: { id: 'user-1' } as unknown as FlowRunSeed['subject'],
            variables: {},
        };

        const outcome = await executeFlowSegment('flow-1', graph, seed, {
            runId: 'run-1',
            startNodeId: 'trigger',
            requireTrigger: true,
            variables: { nickname: recorded },
        });

        expect(outcome.kind).toBe('suspended');
        expect(outcome.kind === 'suspended' && outcome.suspension.variables).toEqual({ nickname: recorded, echo: '' });
    });
});

describe('text that renders empty, run directly', () => {
    it("writes '' as it is handed", async () => {
        const { context, writes } = recordingContext();

        const outcome = await block.run({ variableName: 'echo', valueType: 'text', textValue: '' }, context);

        expect(outcome).toEqual({ kind: 'continue' });
        expect(writes.get('echo')).toBe('');
    });
});

describe('what a save refuses', () => {
    it('refuses a blank or non-numeric number rather than storing a zero', () => {
        expect(saveIssues({ variableName: 'count', valueType: 'number' })).toEqual([
            { field: 'numberValue', message: 'A number, please. Blank is not zero.' },
        ]);
        expect(saveIssues({ variableName: 'count', valueType: 'number', numberValue: '   ' })).toEqual([
            { field: 'numberValue', message: 'A number, please. Blank is not zero.' },
        ]);
        expect(saveIssues({ variableName: 'count', valueType: 'number', numberValue: 'lots' })).toEqual([
            { field: 'numberValue', message: '"lots" is not a number. Digits, please — 3, -2, 0.5.' },
        ]);
        expect(saveIssues({ variableName: 'count', valueType: 'number', numberValue: '0x10' })).toEqual([
            { field: 'numberValue', message: '"0x10" is not a number. Digits, please — 3, -2, 0.5.' },
        ]);
        expect(saveIssues({ variableName: 'count', valueType: 'number', numberValue: '3' })).toEqual([]);
    });

    it('refuses a number too big to hold exactly — a snowflake ID belongs in Text', () => {
        expect(saveIssues({ variableName: 'id', valueType: 'number', numberValue: '1234567890123456789' })).toEqual([
            { field: 'numberValue', message: '"1234567890123456789" is not a number. Digits, please — 3, -2, 0.5.' },
        ]);
    });

    it('still saves and writes an explicit 0 through Number', async () => {
        expect(saveIssues({ variableName: 'count', valueType: 'number', numberValue: '0' })).toEqual([]);
        expect(await written({ variableName: 'count', valueType: 'number', numberValue: '0' })).toBe(0);
    });

    it('refuses empty text, and true or false with neither picked', () => {
        expect(saveIssues({ variableName: 'mood', valueType: 'text' })).toEqual([
            { field: 'textValue', message: 'Give it something to say — or pick a different type.' },
        ]);
        expect(saveIssues({ variableName: 'flag', valueType: 'boolean' })).toEqual([
            { field: 'booleanValue', message: 'Pick true or false.' },
        ]);
    });

    it('judges only the picked type, so a stale value left behind refuses nothing', () => {
        // Switched from number to time with junk still in the number box.
        expect(saveIssues({ variableName: 'seenAt', valueType: 'time', numberValue: 'lots' })).toEqual([]);
    });

    it('refuses a name {{var.<name>}} could never address', () => {
        expect(saveIssues({ variableName: 'seen.at', valueType: 'time' }).map((issue) => issue.field)).toEqual([
            'variableName',
        ]);
    });
});

describe('the run path when the schema has been bypassed', () => {
    it('fails by name rather than writing nothing', async () => {
        // The executor parses the node before every run, and the parse refuses a
        // missing value, so only a caller skipping the schema gets here; driven
        // directly so the arm is proven rather than assumed.
        const { context, writes } = recordingContext();

        const outcome = await block.run({ variableName: 'count', valueType: 'number' }, context);

        expect(outcome).toEqual({
            kind: 'fail',
            error: 'Set Variable has nothing to write into "count" — its number value is missing.',
        });
        expect(writes.size).toBe(0);
    });
});
