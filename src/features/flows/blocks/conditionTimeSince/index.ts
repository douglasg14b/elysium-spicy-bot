import { z } from 'zod';
import { activityEventsRepo } from '../../../../features-system/activity';
import type { BlockManifest } from '../manifest';
import { checkChannelUsable } from '../quietTimeout';
import { requireSubject, type FlowRunContext } from '../types';
import { VARIABLE_NAME_MAX_LENGTH, VARIABLE_NAME_MESSAGE, VARIABLE_NAME_SHAPE } from '../variableName';

export const CONDITION_TIME_SINCE = 'condition.timeSince';

/** The exit a run leaves by when there is nothing to measure from. */
export const TIME_SINCE_NO_RECORD_HANDLE = 'noRecord';

/** What the time is measured since. */
export const TIME_SINCE_SOURCES = ['memberMessage', 'channelMessage', 'memberJoined', 'runStarted', 'variable'] as const;

export type TimeSinceSource = (typeof TIME_SINCE_SOURCES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Longest span this can ask about: a year.
 *
 * Not `FLOW_MAX_DELAY_MS`, which caps how long a run may *park* — a promise the
 * scheduler has to keep. This block parks nothing; it asks a question about the past,
 * and "has it been six months since they last said anything" is a fair question. The
 * cap only keeps a typo from asking about the Jurassic.
 */
const TIME_SINCE_MAX_MS = 365 * DAY_MS;

/**
 * `channelId` and `timeVariable` are each shown by `source` (`visibleWhen`), so both
 * are optional and only judged while they apply — see {@link checkSourceInputs}.
 * `timeVariable` keeps the shared name spelling and length, per-key limits that only
 * ever judge it while shown.
 */
export const timeSinceConfigSchema = z
    .object({
        source: z.enum(TIME_SINCE_SOURCES).default('memberMessage'),
        channelId: z.string().optional(),
        timeVariable: z
            .string()
            .max(VARIABLE_NAME_MAX_LENGTH)
            .regex(VARIABLE_NAME_SHAPE, VARIABLE_NAME_MESSAGE)
            .optional(),
        comparison: z.enum(['atLeast', 'lessThan']).default('atLeast'),
        durationMs: z.number().int().positive().max(TIME_SINCE_MAX_MS),
    })
    .superRefine((config, context) => checkSourceInputs(config, context));

export type TimeSinceConfig = z.infer<typeof timeSinceConfigSchema>;

/**
 * Refuse a source missing what it needs to look anything up, naming the field to fix.
 *
 * Hidden fields never reach this — save-time validation and the executor leave them
 * out first — so a channel left over from "the member's last message" cannot satisfy
 * "a saved time", and a stale variable name cannot refuse a save about messages.
 */
function checkSourceInputs(config: TimeSinceConfig, context: z.RefinementCtx): void {
    if (config.source === 'channelMessage' && !config.channelId) {
        context.addIssue({
            code: 'custom',
            path: ['channelId'],
            message: "Anyone's last message where? Pick a channel — the whole server is never quiet.",
        });
    }

    if (config.source === 'variable' && !config.timeVariable) {
        context.addIssue({
            code: 'custom',
            path: ['timeVariable'],
            message: 'Pick which saved time to measure from.',
        });
    }
}

/**
 * A time as the `time` value kind spells it — an ISO-8601 UTC string, exactly as
 * `new Date().toISOString()` writes it — or undefined for anything else.
 *
 * Strict on purpose: `new Date()` happily reads `'2026'`, `'March 3'` or a number, and
 * a run answering Yes or No from one of those would be guessing. The round trip is the
 * check, guarded because `toISOString()` throws on an invalid date.
 */
export function parseStrictTime(value: unknown): Date | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return undefined;
    }

    return parsed.toISOString() === value ? parsed : undefined;
}

/**
 * What the block measured from: a time, nothing to measure from, or a reason the run
 * fails instead — a saved value that is not a time, or a source missing the input it
 * needs (no channel, no variable picked).
 */
type ReferenceTime =
    | { readonly kind: 'found'; readonly at: Date }
    | { readonly kind: 'none' }
    | { readonly kind: 'fail'; readonly error: string };

const NO_REFERENCE: ReferenceTime = { kind: 'none' };

/** The channel field's label, as the form shows it and as a refusal names it. */
const CHANNEL_LABEL = 'Messages in';

/** The wording when a picked channel is one whose messages are never recorded. */
const UNUSABLE_CHANNEL = {
    fieldLabel: CHANNEL_LABEL,
    reason: 'so nothing said there is ever recorded and this would answer No record forever',
} as const;

/**
 * When the thing being measured from happened, per the node's source.
 *
 * A channel, when one applies, is checked first: the bot that cannot see it never
 * records a message there, and answering No record from that silence would read as
 * "nobody spoke" rather than "I can't look". It throws, which the executor records
 * against the node.
 */
async function referenceTime(config: TimeSinceConfig, context: FlowRunContext): Promise<ReferenceTime> {
    const found = (at: Date | null | undefined): ReferenceTime => (at ? { kind: 'found', at } : NO_REFERENCE);
    // `''` means no channel, as it does for a quiet timeout: the picker is optional, so
    // clearing it removes the key, but a node saved with an empty pick still holds one.
    const channelId = config.channelId || undefined;

    switch (config.source) {
        case 'memberMessage':
            if (channelId) checkChannelUsable(context.guild, channelId, UNUSABLE_CHANNEL);
            return found(
                await activityEventsRepo.findLastMessageAt({
                    guildId: context.guild.id,
                    userId: requireSubject(context).id,
                    ...(channelId ? { channelId } : {}),
                })
            );
        case 'channelMessage':
            // The schema refuses this source without a channel; reported rather than
            // assumed, since asking about the whole server would never be answered.
            if (!channelId) {
                return { kind: 'fail', error: "Anyone's last message needs a channel, and none is set." };
            }
            checkChannelUsable(context.guild, channelId, UNUSABLE_CHANNEL);
            return found(await activityEventsRepo.findLastMessageAt({ guildId: context.guild.id, channelId }));
        case 'memberJoined':
            // Null on a partial member — a leaver the bot never cached.
            return found(requireSubject(context).joinedAt);
        case 'runStarted':
            // Absent on a run parked before runs recorded their start. Never the row's
            // creation time, which is the first park, not the start.
            return found(context.startedAt);
        case 'variable':
            return savedTime(config.timeVariable, context.variables);
        default: {
            const illegal: never = config.source;
            throw new Error(`Unknown Time Since source ${JSON.stringify(illegal)}.`);
        }
    }
}

/**
 * The time a variable holds, read by name.
 *
 * Unset, `null` or `''` is nothing to measure from — the run has not reached whatever
 * records it, or recorded nothing on purpose. Anything else that is not a strict time
 * fails the run by name: the bag carries no types, and answering a branch from text
 * that merely looked like a time would be a guess dressed as an answer.
 */
function savedTime(name: string | undefined, variables: FlowRunContext['variables']): ReferenceTime {
    // The schema requires a name for this source; reported rather than assumed.
    if (!name) {
        return { kind: 'fail', error: 'Time Since is measuring from a saved time, but none is picked.' };
    }

    const value = Object.hasOwn(variables, name) ? variables[name] : undefined;
    if (value === undefined || value === null || value === '') {
        return NO_REFERENCE;
    }

    const at = parseStrictTime(value);
    return at
        ? { kind: 'found', at }
        : {
              kind: 'fail',
              error:
                  `"${name}" holds ${JSON.stringify(value)}, which is not a time. ` +
                  'Save one with a Set Variable on Current time.',
          };
}

/**
 * Has at least — or less than — a given span passed since something?
 *
 * Answered on the spot, never waiting. Three exits: Yes, No, and **No record** when
 * there is nothing to measure from — no message on record, no join date (a partial
 * member), no start time (a run parked before runs recorded one), or an unset saved
 * time. A saved time that is not a time fails the run by name instead.
 *
 * Messages are read from the activity record, so a reply in a thread counts toward its
 * parent channel, exactly as a quiet timeout counts it.
 *
 * **During the startup backfill this answers from what is recorded so far.** Messages
 * sent while the bot was down are restored in the background after a restart, and a
 * run reaching this block before they land can see an older last message than the
 * real one — a documented limit, not a hold: runs leaving a quiet wait are already held
 * by the scheduler, and holding every condition would stall every flow on restart.
 */
export const block: BlockManifest<TimeSinceConfig> = {
    type: CONDITION_TIME_SINCE,
    kind: 'condition',
    label: 'Time Since',
    description: "Count how long it's been since they last ran their mouth, showed up, or whatever you saved. Never waits.",
    group: 'conditions',
    icon: '⏱️',
    configSchema: timeSinceConfigSchema,
    configFields: [
        {
            key: 'source',
            label: 'Since',
            control: 'select',
            defaultValue: 'memberMessage',
            // Only the member's own sources need a member, so they say so here rather than
            // the block saying it for every source: a run about nobody can still measure
            // from a channel, its own start, or a saved time.
            options: [
                { value: 'memberMessage', label: "The member's last message", requires: ['subject'] },
                { value: 'channelMessage', label: "Anyone's last message in a channel" },
                { value: 'memberJoined', label: 'When the member joined', requires: ['subject'] },
                { value: 'runStarted', label: 'When this run started' },
                { value: 'variable', label: 'A saved time' },
            ],
        },
        {
            key: 'channelId',
            label: CHANNEL_LABEL,
            description:
                "Replies in its threads count too. Leave empty for anywhere in the server — except for anyone's last message, which needs a channel.",
            control: 'channelPicker',
            optional: true,
            visibleWhen: { field: 'source', equals: ['memberMessage', 'channelMessage'] },
        },
        {
            key: 'timeVariable',
            label: 'Saved time',
            description: 'A time an earlier Set Variable stamped with Current time. Unset when the run gets here means No record.',
            control: 'variableSelect',
            valueKind: 'time',
            visibleWhen: { field: 'source', equals: ['variable'] },
        },
        {
            key: 'comparison',
            label: 'Has it been',
            control: 'segmented',
            defaultValue: 'atLeast',
            options: [
                { value: 'atLeast', label: 'At least' },
                { value: 'lessThan', label: 'Less than' },
            ],
        },
        {
            key: 'durationMs',
            label: 'How long',
            description: 'Up to a year.',
            control: 'duration',
            defaultValue: DAY_MS,
        },
    ],
    // e.g. "The member's last message · #general · At least · 2d". A hidden part renders
    // nothing, so only the input the source uses ever shows.
    cardSummary: [
        { key: 'source' },
        { key: 'channelId', prefix: ' · ', hideWhenEmpty: true },
        { key: 'timeVariable', prefix: ' · ', emptyText: 'no time picked' },
        { key: 'comparison', prefix: ' · ' },
        { key: 'durationMs', prefix: ' · ', emptyText: 'no duration set' },
    ],
    handles: [
        { id: 'true', label: 'Yes', tone: 'positive' },
        { id: 'false', label: 'No', tone: 'negative' },
        /*
         * Easy to forget it exists, and a run landing here would otherwise just stop —
         * but warned about only for the sources where an ordinary run can land here. "When
         * this run started" has no record only on a run parked before runs recorded their
         * start, and "When the member joined" only on a leaver the bot never cached;
         * warning on every such node would mark normal cards amber for a rare edge.
         */
        {
            id: TIME_SINCE_NO_RECORD_HANDLE,
            label: 'No record',
            tone: 'caution',
            warnIfUnconnected: {
                whenField: 'source',
                equals: ['memberMessage', 'channelMessage', 'variable'] satisfies readonly TimeSinceSource[],
            },
        },
    ],
    outputs: [],
    // Nothing for every source; the member's sources declare `subject` on their options.
    requires: [],
    capabilities: [],
    canSuspend: false,
    async run(config, context) {
        const reference = await referenceTime(config, context);
        switch (reference.kind) {
            case 'none':
                return { kind: 'continue', handle: TIME_SINCE_NO_RECORD_HANDLE };
            case 'fail':
                return { kind: 'fail', error: reference.error };
            case 'found':
                break;
            default: {
                const illegal: never = reference;
                throw new Error(`Unknown reference ${JSON.stringify(illegal)}.`);
            }
        }

        const reached = Date.now() - reference.at.getTime() >= config.durationMs;
        switch (config.comparison) {
            case 'atLeast':
                return { kind: 'continue', handle: reached ? 'true' : 'false' };
            case 'lessThan':
                return { kind: 'continue', handle: reached ? 'false' : 'true' };
            default: {
                const illegal: never = config.comparison;
                throw new Error(`Unknown comparison ${JSON.stringify(illegal)}.`);
            }
        }
    },
};
