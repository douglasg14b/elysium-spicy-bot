import { z } from 'zod';
import { FLOW_MAX_DELAY_MS } from '../../constants';
import type { BlockManifest } from '../manifest';

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
 * Park the run for a while, then carry on.
 *
 * The simpler of the two suspending blocks: it waits on nothing but the clock,
 * so it has one exit and needs no timeout branch. Waking is the whole event —
 * `run` is re-entered with `context.resume` set and simply continues, which is
 * why the executor needs to know nothing about this block in particular.
 *
 * A run parked by an older build resumes at the node *after* this one instead,
 * so it never re-enters here at all. That still arrives at the same place: the
 * node after the delay runs either way, whether it was reached by this block
 * continuing or by being resumed at directly.
 */
export const block: BlockManifest<DelayConfig> = {
    type: ACTION_DELAY,
    kind: 'action',
    label: 'Delay',
    description: 'Park the run for a while, then pick up where it left off. Survives restarts.',
    group: 'actions',
    icon: '⏳',
    configSchema: delayConfigSchema,
    configFields: [
        {
            key: 'durationMs',
            label: 'Wait for',
            description: 'How long to hold the run here before carrying on. It survives a bot restart.',
            control: 'duration',
            // Five minutes: a sane, obviously-editable starting point. No
            // placeholder to go with it — this field is never empty, because the
            // default seeds it and the schema rejects a non-positive value, so a
            // hint for the empty box could never be shown.
            defaultValue: 300_000,
        },
    ],
    note: 'Max 30 days. Put one of these inside a loop and the run will keep cycling — the visit cap still stops it running away.',
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    requires: [],
    capabilities: [],
    canSuspend: true,
    run(config, context) {
        // Woken by the clock, which is the only thing this block waits on.
        if (context.resume) {
            return { kind: 'continue' };
        }

        return {
            kind: 'suspend',
            suspension: { wakeAt: new Date(Date.now() + config.durationMs) },
        };
    },
};
