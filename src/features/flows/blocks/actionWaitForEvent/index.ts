import { z } from 'zod';
import { FLOW_MAX_DELAY_MS } from '../../constants';
import type { ActionNodeDefinition } from '../types';

export const ACTION_WAIT_FOR_EVENT = 'action.waitForEvent';

/** Output handle followed when a wait's `timeoutMs` elapses first. */
export const WAIT_TIMEOUT_HANDLE = 'timeout';

export const flowWaitKindSchema = z.enum(['memberJoin', 'reactionAdd', 'buttonClick']);

/**
 * Park the run until `eventKind` next fires in this guild **for this run's own
 * user** (the `userId` in the run's context snapshot). Deliberately an action,
 * not a trigger, so it sits mid-graph.
 *
 * `timeoutMs` is optional: with it, the run also gets a `wakeAt` and, on expiry,
 * follows a `timeout` output handle if the graph has one (else fails).
 */
export const waitForEventConfigSchema = z.object({
    eventKind: flowWaitKindSchema,
    timeoutMs: z.number().int().positive().max(FLOW_MAX_DELAY_MS).optional(),
});

export type WaitForEventConfig = z.infer<typeof waitForEventConfigSchema>;

/**
 * A *suspending* action — see the note on `action.delay`. The executor
 * intercepts this type, writes a `flow_runs` row with `waitKind`/`waitConfig`,
 * and the event dispatchers wake it when a matching event arrives.
 */
export const block: ActionNodeDefinition<WaitForEventConfig> = {
    type: ACTION_WAIT_FOR_EVENT,
    kind: 'action',
    label: 'Wait for Event',
    configSchema: waitForEventConfigSchema,
    execute() {
        return Promise.reject(
            new Error(
                `${ACTION_WAIT_FOR_EVENT} is a suspending node and must be handled by the executor, not executed`
            )
        );
    },
};
