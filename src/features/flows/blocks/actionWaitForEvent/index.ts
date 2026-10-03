import { z } from 'zod';
import { FLOW_MAX_DELAY_MS } from '../../constants';
import type { FlowRunWaitConfig } from '../../data/flowRunsSchema';
import type { BlockManifest } from '../manifest';
import type { FlowRunContext } from '../types';
import { checkChannelUsable, checkQuietTimeout, quietTimeoutFields, quietTimeoutShape, toQuietWindow } from '../quietTimeout';

export const ACTION_WAIT_FOR_EVENT = 'action.waitForEvent';

/** Output handle followed when a wait's `timeoutMs` elapses first. */
export const WAIT_TIMEOUT_HANDLE = 'timeout';

/** The message channel field's label, as the form shows it and as a refusal names it. */
const MESSAGE_CHANNEL_LABEL = 'In channel';

/**
 * The events this block can wait for. One of three copies kept together — see
 * `FlowWaitKind` in `data/flowRunsSchema.ts`, and `waitConfigSchema` in the repo.
 */
export const flowWaitKindSchema = z.enum(['memberJoin', 'reactionAdd', 'buttonClick', 'message']);

/**
 * Park the run until `eventKind` next fires in this guild **for this run's own
 * user** (the `userId` in the run's context snapshot). Deliberately an action,
 * not a trigger, so it sits mid-graph.
 *
 * `timeoutMs` is optional: with it, the run also gets a `wakeAt` and, on expiry,
 * follows a `timeout` output handle if the graph has one (else fails). Counting
 * that limit from a last message needs a limit to count, so it is refused without.
 *
 * `messageChannelId` narrows a message wait to one channel and the threads under it;
 * absent means anywhere in the server. It may hold a `{{var}}`, which the executor
 * resolves to an id before `run` sees it.
 */
export const waitForEventConfigSchema = z.object({
    // Defaulted to the form's own default because `messageChannelId` is shown by it: the
    // conformance gate requires a field that drives a `visibleWhen` to carry a matching
    // schema default, so every reader agrees what an untouched node shows.
    eventKind: flowWaitKindSchema.default('buttonClick'),
    timeoutMs: z.number().int().positive().max(FLOW_MAX_DELAY_MS).optional(),
    messageChannelId: z.string().optional(),
    ...quietTimeoutShape,
}).superRefine((config, context) => checkQuietTimeout(config, context, config.timeoutMs));

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
                // Short enough to read twice: under the "Wait for" label in the
                // inspector, and inside "Await …" on a 210px card, where the old
                // full-sentence forms wrapped.
                { value: 'buttonClick', label: 'a flow button click' },
                { value: 'reactionAdd', label: 'a reaction' },
                { value: 'memberJoin', label: 'a rejoin' },
                { value: 'message', label: 'a message' },
            ],
        },
        {
            key: 'messageChannelId',
            label: MESSAGE_CHANNEL_LABEL,
            description:
                'Only a message from them in this channel — or a thread under it — counts. Leave empty for anywhere in the server. ' +
                "A reply in a private thread the bot hasn't been added to is never heard.",
            control: 'channelPicker',
            optional: true,
            visibleWhen: { field: 'eventKind', equals: ['message'] },
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
        ...quietTimeoutFields,
    ],
    cardSummary: [
        { key: 'eventKind', prefix: 'Await ' },
        { key: 'timeoutMs', prefix: ' · ', suffix: ' cap', hideWhenEmpty: true },
    ],
    handles: [
        { label: 'It happened', tone: 'positive' },
        // Warned about only while there is a time limit: without one this exit can
        // never be taken, and most waits have none.
        {
            id: WAIT_TIMEOUT_HANDLE,
            label: 'Timed out',
            tone: 'caution',
            warnIfUnconnected: { whenFieldSet: 'timeoutMs' },
        },
    ],
    outputs: [],
    requires: [],
    capabilities: [],
    canSuspend: true,
    run(config, context) {
        if (context.resume) {
            // This block offers no choices, so `choice` cannot be addressed to it
            // and anything that is not the clock is the event it asked for.
            return context.resume.kind === 'timeout'
                ? { kind: 'continue', handle: WAIT_TIMEOUT_HANDLE }
                : { kind: 'continue' };
        }

        const { eventKind, timeoutMs } = config;
        return {
            kind: 'suspend',
            suspension: {
                wakeAt: timeoutMs === undefined ? undefined : new Date(Date.now() + timeoutMs),
                waitKind: eventKind,
                waitConfig: toWaitConfig(config, context),
                quietWindow: toQuietWindow(config, timeoutMs, context.guild),
            },
        };
    },
};

/**
 * What the park records about the event awaited.
 *
 * Named keys rather than the whole config: the time-limit keys belong to `quietWindow`,
 * and `waitConfig` describes only the event. A message wait also records the channel it
 * listens in and when it parked — where the outage catch-up starts looking for a reply.
 *
 * Throws, which the executor records against the node, for a message channel the bot
 * cannot read: no message there would ever reach the activity record, so the run would
 * wait for a reply it can never hear.
 */
function toWaitConfig(config: WaitForEventConfig, context: FlowRunContext): FlowRunWaitConfig {
    const { eventKind, timeoutMs } = config;
    const limit = timeoutMs === undefined ? {} : { timeoutMs };

    if (eventKind !== 'message') {
        return { eventKind, ...limit };
    }

    // Empty reads as unset, as for the quiet-window channel: a cleared picker may write ''.
    const channelId = config.messageChannelId || undefined;
    if (channelId) {
        checkChannelUsable(context.guild, channelId, {
            fieldLabel: MESSAGE_CHANNEL_LABEL,
            reason: "so the member's reply there would never be heard and the run would wait for nothing",
        });
    }

    return { eventKind, ...limit, ...(channelId ? { channelId } : {}), parkedAt: parkedAt(context).toISOString() };
}

/**
 * When a message wait starts listening — where the catch-up for replies sent while the
 * bot was down starts looking.
 *
 * Now, or just after the message that started or woke this leg, whichever is later.
 * The catch-up compares Discord's timestamps, and with Discord's clock a little ahead
 * of the bot's, "now" could fall before that message — which would then be found as a
 * reply to the wait it caused. A message cannot answer a wait it started.
 */
function parkedAt(context: FlowRunContext): Date {
    const afterEvent = context.eventAt ? context.eventAt.getTime() + 1 : 0;
    return new Date(Math.max(Date.now(), afterEvent));
}
