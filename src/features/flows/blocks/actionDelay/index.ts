import { z } from 'zod';
import { FLOW_MAX_DELAY_MS } from '../../constants';
import type { ActionNodeDefinition } from '../types';

export const ACTION_DELAY = 'action.delay';

/**
 * Pause the run for `durationMs`, then continue at this node's outgoing edge.
 *
 * Capped at {@link FLOW_MAX_DELAY_MS} (30 days) so a typo cannot park a run
 * effectively forever.
 */
export const delayConfigSchema = z.object({
    durationMs: z.number().int().positive().max(FLOW_MAX_DELAY_MS),
});

export type DelayConfig = z.infer<typeof delayConfigSchema>;

/**
 * A *suspending* action: the executor intercepts this node type before it would
 * call `execute`, persists a `flow_runs` row with `wakeAt = now + durationMs`,
 * and stops. The poller resumes the run at the node after the delay.
 *
 * `execute` therefore exists only to satisfy the ActionNodeDefinition contract;
 * reaching it means the executor forgot to intercept, which is a bug worth
 * surfacing rather than silently treating as a no-op.
 */
export const block: ActionNodeDefinition<DelayConfig> = {
    type: ACTION_DELAY,
    kind: 'action',
    label: 'Delay',
    configSchema: delayConfigSchema,
    execute() {
        return Promise.reject(
            new Error(`${ACTION_DELAY} is a suspending node and must be handled by the executor, not executed`)
        );
    },
};
