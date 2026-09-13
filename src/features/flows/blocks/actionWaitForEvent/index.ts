import { z } from 'zod';
import { FLOW_MAX_DELAY_MS } from '../../constants';
import type { BlockManifest } from '../manifest';

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
 * Hold the run until something happens to this member, or until time runs out.
 *
 * The block that proves suspension needs no special case. It parks at its own
 * node, so waking re-enters `run` with `context.resume` saying which of the two
 * things it was waiting for actually happened — and it answers with one of its
 * own declared handles. The executor follows that handle the same way it follows
 * a condition's, which is the whole reason it no longer names this block.
 */
export const block: BlockManifest<WaitForEventConfig> = {
    type: ACTION_WAIT_FOR_EVENT,
    kind: 'action',
    label: 'Wait for Event',
    description: 'Hold the run until this member does something — or until your timeout runs out.',
    group: 'actions',
    icon: '⏸️',
    configSchema: waitForEventConfigSchema,
    configFields: [
        {
            key: 'eventKind',
            label: 'Wait for',
            description: 'Which event wakes this run, when it happens to this member.',
            // A dropdown rather than a segmented control: three choices sit inside
            // the segmented range, but these labels are full clauses and would be
            // unreadable squeezed into thirds of the inspector's width.
            control: 'select',
            defaultValue: 'buttonClick',
            options: [
                { value: 'buttonClick', label: 'They click a flow button' },
                { value: 'reactionAdd', label: 'They add a reaction' },
                { value: 'memberJoin', label: 'They rejoin the server' },
            ],
        },
        {
            key: 'timeoutMs',
            label: 'Give up after',
            description:
                'Leave empty to wait indefinitely. Otherwise the run leaves by the Timed out handle — wire it up, or the run fails.',
            control: 'duration',
            optional: true,
            placeholder: 'No limit',
        },
    ],
    cardSummary: [
        { key: 'eventKind', prefix: 'Await ' },
        { key: 'timeoutMs', prefix: ' · ', suffix: ' cap', hideWhenEmpty: true },
    ],
    handles: [
        { label: 'It happened', tone: 'positive' },
        { id: WAIT_TIMEOUT_HANDLE, label: 'Timed out', tone: 'caution' },
    ],
    outputs: [],
    requires: [],
    capabilities: [],
    canSuspend: true,
    run(config, context) {
        if (context.resume) {
            return context.resume === 'timeout'
                ? { kind: 'continue', handle: WAIT_TIMEOUT_HANDLE }
                : { kind: 'continue' };
        }

        return {
            kind: 'suspend',
            suspension: {
                wakeAt: config.timeoutMs === undefined ? undefined : new Date(Date.now() + config.timeoutMs),
                waitKind: config.eventKind,
                waitConfig: config,
            },
        };
    },
};
