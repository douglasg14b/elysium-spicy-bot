import { beforeAll, describe, expect, it, vi } from 'vitest';
import { block as actionPickRandomNode, pickOption, pickRandomConfigSchema } from '../blocks/actionPickRandom';
import { ensureBlocksDiscovered } from '../blocks/registry';
import type { FlowRunContext, FlowRunSeed, FlowVariableValue } from '../blocks/types';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../data/flowGraph';
import { executeFlow } from '../engine/executor';
import { sentCopy } from './support/sentCopy';

beforeAll(ensureBlocksDiscovered);

/** A context that records what the block writes, which is this block's whole job. */
function recordingContext(): { context: FlowRunContext; writes: Map<string, FlowVariableValue> } {
    const writes = new Map<string, FlowVariableValue>();
    return {
        writes,
        context: {
            client: {} as FlowRunContext['client'],
            guild: { id: 'guild-1' } as FlowRunContext['guild'],
            subject: {} as FlowRunContext['subject'],
            runId: 'run-1',
            nodeId: 'node-1',
            variables: {},
            setOutput: (key, value) => {
                writes.set(key, value);
            },
        },
    };
}

describe('picking an option', () => {
    const options = ['first', 'second', 'third', 'fourth'];

    it('picks by position across the whole list, and reaches both ends', () => {
        // The roll is a defaulted parameter precisely so this can be pinned
        // without stubbing a global. Every entry is reachable, which is the
        // property an author is promised by "equally likely".
        expect(pickOption(options, 0)).toBe('first');
        expect(pickOption(options, 0.3)).toBe('second');
        expect(pickOption(options, 0.6)).toBe('third');
        expect(pickOption(options, 0.999)).toBe('fourth');
    });

    it('refuses a roll outside [0, 1) rather than quietly correcting it', () => {
        // Clamping instead would turn a caller's bug into a pick that is biased
        // towards one end and still looks random — the failure nobody notices.
        expect(() => pickOption(options, 1)).toThrow('[0, 1)');
        expect(() => pickOption(options, -0.5)).toThrow('[0, 1)');
        expect(() => pickOption(options, Number.NaN)).toThrow('[0, 1)');
    });

    it('refuses an empty list rather than returning undefined as a string', () => {
        expect(() => pickOption([], 0)).toThrow('nothing to pick from');
    });
});

describe('action.pickRandom', () => {
    it('records the pick under the name the author chose, and carries on', async () => {
        const { context, writes } = recordingContext();

        const outcome = await actionPickRandomNode.run({ options: ['only one'], outputKey: 'dare' }, context);

        expect(outcome).toEqual({ kind: 'continue' });
        // Read back by a downstream copy field as `{{var.dare}}`.
        expect(writes.get('dare')).toBe('only one');
    });

    it('refuses an empty list at save time, which is what makes the guard below unreachable', () => {
        expect(pickRandomConfigSchema.safeParse({ options: [], outputKey: 'dare' }).success).toBe(false);
    });

    it('fails nameably rather than recording nothing if an empty list ever reaches it', async () => {
        // Unreachable through the executor, which re-parses against the schema on
        // every visit. Driven directly so the arm is proven rather than asserted:
        // the alternative is recording the string "undefined" as somebody's dare.
        const { context, writes } = recordingContext();

        const outcome = await actionPickRandomNode.run({ options: [], outputKey: 'dare' }, context);

        expect(outcome).toEqual({
            kind: 'fail',
            error: 'This block has nothing to pick from — its list of options is empty.',
        });
        expect(writes.size).toBe(0);
    });

    it('refuses an output name that {{var.<name>}} could never address', () => {
        // A dotted name saves happily and then resolves to nothing from copy,
        // because `variableNameOf` rejects a second segment. Caught at save.
        expect(pickRandomConfigSchema.safeParse({ options: ['a'], outputKey: 'my.pick' }).success).toBe(false);
        expect(pickRandomConfigSchema.safeParse({ options: ['a'], outputKey: 'myPick' }).success).toBe(true);
    });
});

describe('the pick reaches a later block through the real executor', () => {
    /** `pick at random -> DM whatever came up`, the composition the PRD describes. */
    const graph: FlowGraph = {
        version: FLOW_GRAPH_VERSION,
        nodes: [
            { id: 'trigger', type: 'trigger.buttonClick', position: { x: 0, y: 0 }, data: { channelId: 'channel-1', label: 'Go' } },
            {
                id: 'roll',
                type: 'action.pickRandom',
                position: { x: 1, y: 0 },
                data: { options: ['spanking', 'edging', 'denial'], outputKey: 'dare' },
            },
            {
                id: 'dm',
                type: 'action.sendDM',
                position: { x: 2, y: 0 },
                data: { message: 'Tonight you get: {{var.dare}}. No negotiating.' },
            },
        ],
        edges: [
            { id: 'e1', source: 'trigger', target: 'roll' },
            { id: 'e2', source: 'roll', target: 'dm' },
        ],
    } as FlowGraph;

    function makeSeed(): { context: FlowRunSeed; userSend: ReturnType<typeof vi.fn> } {
        const userSend = vi.fn().mockResolvedValue(undefined);
        return {
            userSend,
            context: {
                client: {} as FlowRunSeed['client'],
                guild: { id: 'guild-1', name: 'Afterdark' } as FlowRunSeed['guild'],
                subject: {
                    id: 'user-1',
                    user: { id: 'user-1', send: userSend },
                } as unknown as FlowRunSeed['subject'],
                variables: {},
            },
        };
    }

    it('writes a variable a downstream copy field can address', async () => {
        // The block's headline claim, proven against the real executor rather than
        // a hand-built write channel: the pick survives the drain into the run's
        // variable bag and is expanded by the shared copy renderer.
        const { context, userSend } = makeSeed();

        const result = await executeFlow('flow-1', graph, 'trigger', context);

        expect(result.status).toBe('success');
        const [message] = sentCopy(userSend);
        expect(message).toMatch(/^Tonight you get: (spanking|edging|denial)\. No negotiating\.$/);
    });

    it('is not pinned to one entry once the value has been through the bag', async () => {
        // Not a distribution test — `pickOption` pins the mapping exactly, and
        // asserting proportions here would be flaky for no added coverage. The
        // one thing this catches that the anchored regex above does not is a pick
        // that is *always the same entry* end to end. Over 40 runs of three
        // options, missing one is about a 1-in-3.7-million event.
        const seen = new Set<string>();

        for (let attempt = 0; attempt < 40; attempt += 1) {
            const { context, userSend } = makeSeed();
            await executeFlow('flow-1', graph, 'trigger', context);
            const [message] = sentCopy(userSend);
            seen.add(message.slice('Tonight you get: '.length, -'. No negotiating.'.length));
        }

        expect([...seen].sort()).toEqual(['denial', 'edging', 'spanking']);
    });
});
