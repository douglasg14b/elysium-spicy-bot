import type { BlockTriggerSource } from '../blocks/manifest';
import type { FlowRunSeed } from '../blocks/types';
import type { FlowGraph } from '../data/flowGraph';
import { executeFlow } from './executor';
import type { MessageActivityLimit } from './messageActivityLimit';

/** One run a gateway or activity event starts, from one trigger node. */
export interface TriggeredRun {
    readonly flowId: string;
    readonly graph: FlowGraph;
    readonly triggerNodeId: string;
    /** What fired it, for the line a failure logs. */
    readonly source: BlockTriggerSource;
    /** A fresh seed per run — two runs sharing one would share whatever either did to it. */
    readonly seed: FlowRunSeed;
    /**
     * The flood limit to draw one token from before starting, when the event is message
     * activity. Absent for every other source: a join, a leave, a reaction or a level-up
     * is a one-off event, and dropping one loses it for good.
     */
    readonly limit?: Pick<MessageActivityLimit, 'take'>;
}

/**
 * Start one run from a trigger — the one place every event-started run begins.
 *
 * Every gateway and activity dispatcher calls this rather than the executor, so how a
 * run starts, how a failure is isolated and logged, and which runs are limited are
 * stated once. The button path (`flowTriggerDispatch`) does not: it answers an
 * interaction, and its failures go back to the presser rather than only to the log.
 *
 * Never throws. An unexpected error is logged and swallowed **per run**, so one bad flow,
 * or one bad entry point into a flow, cannot strand the triggers after it. A run the
 * flood limit refuses is dropped silently here; the limit sums its refusals into its own
 * log line.
 */
export async function startTriggeredRun(run: TriggeredRun): Promise<void> {
    if (run.limit && !run.limit.take(run.seed.guild.id, run.seed.subject.id, 'start')) {
        return;
    }

    try {
        await executeFlow(run.flowId, run.graph, run.triggerNodeId, run.seed);
    } catch (error) {
        console.error(
            `[flows] Unexpected error running ${run.source} flow ${run.flowId} from ${run.triggerNodeId}:`,
            error
        );
    }
}
