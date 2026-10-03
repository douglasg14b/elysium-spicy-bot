import { beforeAll, describe, expect, it } from 'vitest';
import { ensureBlocksDiscovered } from '../../registry';
import type { FlowRunContext, FlowRunSeed, FlowVariableValue } from '../../types';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../../data/flowGraph';
import { executeFlowSegment } from '../../../engine/executor';
import { validateNodeData } from '../../../engine/nodeDataValidation';
import type { FlowStepOutcome } from '../../../engine/stepOutcome';
import { CONDITION_COMPARE, block, compareConfigSchema } from '../index';

/**
 * Compare answers Yes, No or Not set for every operator, reads numbers as numbers and
 * text ignoring case, and fails by name when "more than" or "less than" is handed
 * something that is not a number.
 *
 * `run` is driven directly on parsed node data for the answers, and through the real
 * executor for the one thing only it does: render the value's tokens first. The
 * refusals go through `validateNodeData`, the save path.
 */

beforeAll(ensureBlocksDiscovered);

const YES = { kind: 'continue', handle: 'true' };
const NO = { kind: 'continue', handle: 'false' };
const NOT_SET = { kind: 'continue', handle: 'notSet' };

function contextWith(variables: Readonly<Record<string, FlowVariableValue>>): FlowRunContext {
    return {
        client: {} as FlowRunContext['client'],
        guild: { id: 'guild-1' } as FlowRunContext['guild'],
        subject: {} as FlowRunContext['subject'],
        runId: 'run-1',
        nodeId: 'compare',
        variables,
        setOutput: () => {},
    };
}

/** Compare `held` (under `x`) against `value` with `operator`, parsed as the executor parses it. */
async function compare(held: FlowVariableValue | undefined, operator: string, value: string): Promise<FlowStepOutcome> {
    const variables: Record<string, FlowVariableValue> = held === undefined ? {} : { x: held };
    return block.run(compareConfigSchema.parse({ variableName: 'x', operator, value }), contextWith(variables));
}

describe('each operator, both ways', () => {
    it.each([
        ['is', 'kinky', 'kinky', YES],
        ['is', 'kinky', 'vanilla', NO],
        ['isNot', 'kinky', 'vanilla', YES],
        ['isNot', 'kinky', 'kinky', NO],
        ['moreThan', 5, '3', YES],
        ['moreThan', 3, '3', NO],
        ['lessThan', 2, '3', YES],
        ['lessThan', 3, '3', NO],
        ['contains', 'spank me harder', 'harder', YES],
        ['contains', 'spank me harder', 'softer', NO],
    ] as const)('%s: %j against %j', async (operator, held, value, expected) => {
        expect(await compare(held, operator, value)).toEqual(expected);
    });
});

describe('numbers and text', () => {
    it('compares as numbers when both sides read as one, so 5 is 5.0', async () => {
        expect(await compare(5, 'is', '5.0')).toEqual(YES);
        expect(await compare('5', 'is', '5.0')).toEqual(YES);
        expect(await compare(5, 'isNot', '5.0')).toEqual(NO);
    });

    it('compares snowflake IDs as text, so two a digit apart are not the same', async () => {
        // Both round to one JS number; read as numbers they would answer Yes.
        expect(await compare('1234567890123456789', 'is', '1234567890123456790')).toEqual(NO);
        expect(await compare('1234567890123456789', 'isNot', '1234567890123456790')).toEqual(YES);
        expect(await compare('1234567890123456789', 'is', '1234567890123456789')).toEqual(YES);
    });

    it('fails more and less than on a snowflake ID by name, rather than rounding it', async () => {
        expect(await compare('1234567890123456789', 'moreThan', '3')).toEqual({
            kind: 'fail',
            error: `"x" holds "1234567890123456789", which is not a number, so Compare can't tell if it's more than anything.`,
        });
    });

    it('compares as text when either side is not a number', async () => {
        expect(await compare('5 apples', 'is', '5')).toEqual(NO);
        expect(await compare(true, 'is', 'true')).toEqual(YES);
        expect(await compare(false, 'isNot', 'true')).toEqual(YES);
    });

    it('reads a numeric string as a number for more and less than', async () => {
        expect(await compare('10', 'moreThan', '9')).toEqual(YES);
        expect(await compare(' -2 ', 'lessThan', '-1.5')).toEqual(YES);
    });

    it('ignores case for is, is not and contains', async () => {
        expect(await compare('Brat', 'is', 'bRAT')).toEqual(YES);
        expect(await compare('Brat', 'isNot', 'BRAT')).toEqual(NO);
        expect(await compare('Down Bad', 'contains', 'BAD')).toEqual(YES);
    });

    it('trims the value, never the variable, before comparing text', async () => {
        expect(await compare('yes', 'is', 'yes ')).toEqual(YES);
        expect(await compare('down bad', 'contains', ' bad ')).toEqual(YES);
        expect(await compare('yes ', 'is', 'yes')).toEqual(NO);
    });

    it("treats '' as a value — it is empty, not unset", async () => {
        expect(await compare('', 'is', '')).toEqual(YES);
        expect(await compare('', 'isNot', '')).toEqual(NO);
        expect(await compare('something', 'is', '')).toEqual(NO);
    });
});

describe('a variable with nothing in it', () => {
    it.each([
        ['unset', undefined],
        ['null', null],
    ] as const)('leaves by Not set when %s, whatever the operator', async (_label, held) => {
        for (const operator of ['is', 'isNot', 'moreThan', 'lessThan', 'contains']) {
            expect(await compare(held, operator, '3')).toEqual(NOT_SET);
        }
    });

    it('declares Not set as a caution exit with no warning when unconnected', () => {
        expect(block.handles).toContainEqual({ id: 'notSet', label: 'Not set', tone: 'caution' });
    });
});

describe('more or less than something that is not a number', () => {
    it.each([['moreThan', 'more than'] as const, ['lessThan', 'less than'] as const])(
        'fails %s by name when the variable is not a number',
        async (operator, words) => {
            expect(await compare('lots', operator, '3')).toEqual({
                kind: 'fail',
                error: `"x" holds "lots", which is not a number, so Compare can't tell if it's ${words} anything.`,
            });
            expect(await compare(true, operator, '3')).toEqual({
                kind: 'fail',
                error: `"x" holds true, which is not a number, so Compare can't tell if it's ${words} anything.`,
            });
        }
    );

    it.each([['moreThan', 'more than'] as const, ['lessThan', 'less than'] as const])(
        'fails %s by name when the value is not a number',
        async (operator, words) => {
            // What a `{{var}}` that passed the save renders to at run time.
            const outcome = await block.run(
                { variableName: 'x', operator, value: 'a lot' },
                contextWith({ x: 3 })
            );

            expect(outcome).toEqual({
                kind: 'fail',
                error: `Compare can't tell if "x" is ${words} "a lot" — that is not a number.`,
            });
        }
    );
});

describe('a token in the value, through the real executor', () => {
    /** member join -> Compare, so the executor renders `value` before `run`. */
    async function branchTaken(value: string, variables: Record<string, FlowVariableValue>): Promise<unknown> {
        const graph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                { id: 'trigger', type: 'trigger.memberJoin', position: { x: 0, y: 0 }, data: {} },
                {
                    id: 'compare',
                    type: CONDITION_COMPARE,
                    position: { x: 1, y: 0 },
                    data: { variableName: 'count', operator: 'lessThan', value },
                },
            ],
            edges: [{ id: 'e1', source: 'trigger', target: 'compare' }],
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
            variables,
        });
        if (outcome.kind !== 'completed') throw new Error('Compare never parks');
        return outcome.result.status === 'success' ? outcome.result.log.at(-1)?.branch : outcome.result.error;
    }

    it('compares two variables through {{var.other}}', async () => {
        expect(await branchTaken('{{var.limit}}', { count: 2, limit: 3 })).toBe('true');
        expect(await branchTaken('{{var.limit}}', { count: 3, limit: 3 })).toBe('false');
    });

    it('fails the run by name when the token names something never recorded', async () => {
        expect(await branchTaken('{{var.limit}}', { count: 2 })).toMatch(
            /"Value" uses \{\{var\.limit\}\}, but nothing has recorded a value called "limit"/
        );
    });
});

describe('what a save refuses', () => {
    /** member join -> one Compare holding `data`, nothing wired after it. */
    function saveIssues(data: Record<string, unknown>): { field?: string; message: string }[] {
        const graph = {
            version: FLOW_GRAPH_VERSION,
            nodes: [
                { id: 'trigger', type: 'trigger.memberJoin', position: { x: 0, y: 0 }, data: {} },
                { id: 'compare', type: CONDITION_COMPARE, position: { x: 1, y: 0 }, data },
            ],
            edges: [{ id: 'e1', source: 'trigger', target: 'compare' }],
        } as FlowGraph;
        const result = validateNodeData(graph);
        return result.valid ? [] : result.issues.map(({ field, message }) => ({ field, message }));
    }

    it('refuses more or less than with no number, or text that is not one', () => {
        expect(saveIssues({ variableName: 'count', operator: 'moreThan', value: '  ' })).toEqual([
            { field: 'value', message: 'More than what? Give it a number to measure up to.' },
        ]);
        expect(saveIssues({ variableName: 'count', operator: 'lessThan' })).toEqual([
            { field: 'value', message: 'Less than what? Give it a number to measure up to.' },
        ]);
        expect(saveIssues({ variableName: 'count', operator: 'lessThan', value: 'lots' })).toEqual([
            { field: 'value', message: '"lots" is not a number. Digits, please — 3, -2, 0.5.' },
        ]);
    });

    it('leaves a value holding a token to the run, and accepts a plain number', () => {
        expect(saveIssues({ variableName: 'count', operator: 'moreThan', value: '{{var.limit}}' })).toEqual([]);
        expect(saveIssues({ variableName: 'count', operator: 'lessThan', value: '-0.5' })).toEqual([]);
    });

    it('refuses contains with nothing to look for', () => {
        expect(saveIssues({ variableName: 'mood', operator: 'contains', value: '' })).toEqual([
            { field: 'value', message: 'Contains what? Nothing is in everything — give it some text to look for.' },
        ]);
    });

    it('accepts is and is not with an empty value, meaning "is empty"', () => {
        expect(saveIssues({ variableName: 'mood', operator: 'is', value: '' })).toEqual([]);
        expect(saveIssues({ variableName: 'mood', operator: 'isNot' })).toEqual([]);
    });

    it('refuses no variable, and a name {{var.<name>}} could never address', () => {
        expect(saveIssues({ operator: 'is' }).map((issue) => issue.field)).toEqual(['variableName']);
        expect(saveIssues({ variableName: 'seen.at', operator: 'is' }).map((issue) => issue.field)).toEqual([
            'variableName',
        ]);
    });
});
