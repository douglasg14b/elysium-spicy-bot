import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowRunSeed } from '../../blocks/types';
import { FLOW_GRAPH_VERSION, type FlowGraph } from '../../data/flowGraph';
import type { FlowRunResult } from '../executor';

/**
 * `startTriggeredRun` hands back what the run did, and still never throws: a schedule
 * reads the result to remember a parked run, and every other caller ignores it.
 */

const executeFlow = vi.fn();
vi.mock('../executor', () => ({ executeFlow: (...args: unknown[]) => executeFlow(...args) }));

const { startTriggeredRun } = await import('../triggeredRun');

const SEED = { guild: { id: 'guild-1' }, variables: {}, subject: { id: 'member-1' } } as unknown as FlowRunSeed & {
    subject: NonNullable<FlowRunSeed['subject']>;
};
const GRAPH: FlowGraph = { version: FLOW_GRAPH_VERSION, nodes: [], edges: [] };
const RUN = { flowId: 'flow-1', graph: GRAPH, triggerNodeId: 'trigger', source: 'scheduleDue' } as const;

const PARKED: FlowRunResult = {
    flowId: 'flow-1',
    runId: 'run-1',
    triggerNodeId: 'trigger',
    status: 'success',
    parked: true,
    visitedNodeIds: ['trigger'],
    log: [],
};

beforeEach(() => {
    executeFlow.mockReset();
});

describe('startTriggeredRun', () => {
    it("hands back the executor's result — its run id and whether it parked", async () => {
        executeFlow.mockResolvedValue(PARKED);

        await expect(startTriggeredRun({ ...RUN, seed: SEED })).resolves.toBe(PARKED);
    });

    it('never throws: an unexpected error is logged and answered with undefined', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        executeFlow.mockRejectedValue(new Error('executor exploded'));

        await expect(startTriggeredRun({ ...RUN, seed: SEED })).resolves.toBeUndefined();
        expect(error).toHaveBeenCalledWith(expect.stringMatching(/Unexpected error running scheduleDue flow flow-1/), expect.any(Error));
        error.mockRestore();
    });

    it('answers undefined, starting nothing, when the flood limit refuses the start', async () => {
        const take = vi.fn().mockReturnValue(false);

        await expect(startTriggeredRun({ ...RUN, source: 'messageSent', seed: SEED, limit: { take } })).resolves.toBeUndefined();
        expect(executeFlow).not.toHaveBeenCalled();
    });
});
