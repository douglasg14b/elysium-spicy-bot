import { z } from 'zod';
import { BLOCK_DAY_KEYS, type BlockDayKey, type BlockManifest } from '../manifest';

export const TRIGGER_SCHEDULE = 'trigger.schedule';

/** How a schedule repeats: every day, on chosen days of the week, or every so often. */
export const SCHEDULE_REPEATS = ['daily', 'days', 'interval'] as const;

export type ScheduleRepeat = (typeof SCHEDULE_REPEATS)[number];

/**
 * The days of the week, Monday first — the `daysOfWeek` control's own keys, in the order
 * the picker offers them and a saved list is sorted into, so the same days picked in
 * another order are the same schedule.
 */
export const SCHEDULE_DAYS = BLOCK_DAY_KEYS;

export type ScheduleDay = BlockDayKey;

/**
 * The gaps "every so often" offers, and how many minutes each is.
 *
 * A fixed list rather than any number, lined up with the clock: each divides a day
 * evenly, so "every 6 hours" is midnight, 6 AM, noon and 6 PM rather than six hours after
 * whenever someone saved. Fifteen minutes is the shortest, and the only limit there is.
 */
export const SCHEDULE_INTERVAL_MINUTES = {
    '15m': 15,
    '20m': 20,
    '30m': 30,
    '1h': 60,
    '2h': 120,
    '3h': 180,
    '4h': 240,
    '6h': 360,
    '8h': 480,
    '12h': 720,
} as const;

export type ScheduleInterval = keyof typeof SCHEDULE_INTERVAL_MINUTES;

const SCHEDULE_INTERVALS = Object.keys(SCHEDULE_INTERVAL_MINUTES) as [ScheduleInterval, ...ScheduleInterval[]];

/** A 24-hour `HH:MM`, always two digits for the hour — what the time control stores. */
const TIME_OF_DAY_SHAPE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * `time`, `days` and `every` are each shown by `repeat` (`visibleWhen`), so all three are
 * optional and only required while they apply — see {@link checkRepeat}.
 *
 * `days` is checked for repeats with `.refine()` rather than JSON Schema's `uniqueItems`,
 * which the browser checks have no rule for, then sorted Monday first by `.transform()`.
 * The sort is what keeps a schedule's identity independent of click order: reconcile keys
 * each schedule on its parsed config, and a key that changed with the order the days were
 * picked in would quietly drop a missed run's catch-up.
 */
export const scheduleConfigSchema = z
    .object({
        repeat: z.enum(SCHEDULE_REPEATS).default('daily'),
        time: z.string().regex(TIME_OF_DAY_SHAPE, 'Pick a time — hour, minute, AM or PM.').optional(),
        days: z
            .array(z.enum(SCHEDULE_DAYS))
            .min(1, 'Pick at least one day. A schedule that never fires is just a very patient flow.')
            .refine((days) => new Set(days).size === days.length, 'Each day only counts once, however keen you are.')
            .transform((days) => SCHEDULE_DAYS.filter((day) => days.includes(day)))
            .optional(),
        every: z.enum(SCHEDULE_INTERVALS).optional(),
    })
    .superRefine((config, context) => checkRepeat(config, context));

export type ScheduleConfig = z.infer<typeof scheduleConfigSchema>;

/**
 * Require each field the chosen `repeat` shows, naming the one to fill in.
 *
 * Hidden fields never reach this — save-time validation, reconcile and the executor all
 * leave them out first — so a time left over from "Every day" cannot satisfy "Every so
 * often".
 */
function checkRepeat(config: ScheduleConfig, context: z.RefinementCtx): void {
    if ((config.repeat === 'daily' || config.repeat === 'days') && config.time === undefined) {
        context.addIssue({ code: 'custom', path: ['time'], message: 'What time? Pick one.' });
    }

    if (config.repeat === 'days' && config.days === undefined) {
        context.addIssue({ code: 'custom', path: ['days'], message: 'Which days? Pick at least one.' });
    }

    if (config.repeat === 'interval' && config.every === undefined) {
        context.addIssue({ code: 'custom', path: ['every'], message: 'How often? Pick one.' });
    }
}

/**
 * A parsed schedule as exactly what its `repeat` uses — one arm per repeat, each holding
 * only its own fields, all present. What the time math and the schedule key read, so
 * neither re-checks which fields a repeat needs.
 */
export type ResolvedSchedule =
    | { readonly repeat: 'daily'; readonly time: string }
    | { readonly repeat: 'days'; readonly time: string; readonly days: readonly ScheduleDay[] }
    | { readonly repeat: 'interval'; readonly every: ScheduleInterval };

/**
 * Narrow a parsed config to its {@link ResolvedSchedule}.
 *
 * The schema's own refinement already requires every field the chosen `repeat` shows, so
 * a config that came through it always resolves. One that did not is a programming error,
 * and this is the one place it is thrown — naming what was missing.
 */
export function resolveSchedule(config: ScheduleConfig): ResolvedSchedule {
    switch (config.repeat) {
        case 'daily':
            if (config.time !== undefined) return { repeat: 'daily', time: config.time };
            break;
        case 'days':
            if (config.time !== undefined && config.days !== undefined) {
                return { repeat: 'days', time: config.time, days: config.days };
            }
            break;
        case 'interval':
            if (config.every !== undefined) return { repeat: 'interval', every: config.every };
            break;
        default: {
            const illegal: never = config.repeat;
            throw new Error(`Unknown schedule repeat ${JSON.stringify(illegal)}.`);
        }
    }

    throw new Error(
        `A "${config.repeat}" schedule is missing a field it needs; parse its config through the block's schema first.`
    );
}

/**
 * Start a run on a schedule: every day at a time, on chosen days at a time, or every so
 * often, lined up with the clock. All times are the server's time zone.
 *
 * **Establishes nothing.** No member, no actor, no channel: the clock started it, so its
 * runs are about nobody, and nothing needing a member may sit below it.
 *
 * Nothing here fires it. `logic/reconcileGuildSchedules.ts` keeps one `flow_schedules`
 * row per Schedule node with its next time, and `logic/fireDueSchedules.ts` starts the due
 * ones from the shared run tick.
 */
export const block: BlockManifest<ScheduleConfig> = {
    type: TRIGGER_SCHEDULE,
    kind: 'trigger',
    label: 'Schedule',
    description: "Start the run on the clock — daily, on the days you pick, or every so often. Nobody has to lift a finger.",
    group: 'triggers',
    icon: '⏰',
    configSchema: scheduleConfigSchema,
    configFields: [
        {
            key: 'repeat',
            label: 'Repeat',
            control: 'select',
            defaultValue: 'daily',
            options: [
                { value: 'daily', label: 'Every day' },
                { value: 'days', label: 'On certain days' },
                { value: 'interval', label: 'Every so often' },
            ],
        },
        {
            key: 'days',
            label: 'Days',
            control: 'daysOfWeek',
            defaultValue: ['mon', 'tue', 'wed', 'thu', 'fri'],
            visibleWhen: { field: 'repeat', equals: ['days'] },
        },
        {
            key: 'time',
            label: 'Time',
            control: 'timeOfDay',
            defaultValue: '09:00',
            visibleWhen: { field: 'repeat', equals: ['daily', 'days'] },
        },
        {
            key: 'every',
            label: 'How often',
            description:
                'Lined up with the clock: every 30 minutes fires at :00 and :30, every 6 hours at midnight, 6 AM, noon and 6 PM.',
            control: 'select',
            defaultValue: '1h',
            visibleWhen: { field: 'repeat', equals: ['interval'] },
            options: [
                { value: '15m', label: 'Every 15 minutes' },
                { value: '20m', label: 'Every 20 minutes' },
                { value: '30m', label: 'Every 30 minutes' },
                { value: '1h', label: 'Every hour' },
                { value: '2h', label: 'Every 2 hours' },
                { value: '3h', label: 'Every 3 hours' },
                { value: '4h', label: 'Every 4 hours' },
                { value: '6h', label: 'Every 6 hours' },
                { value: '8h', label: 'Every 8 hours' },
                { value: '12h', label: 'Every 12 hours' },
            ],
        },
    ],
    // "Every day at 9:00 AM", "Mon, Wed, Fri at 9:00 AM" or "Every 30 minutes". `repeat`
    // is never hidden, so its label shows only under "Every day"; the other parts are
    // hidden with their own fields.
    cardSummary: [
        { key: 'repeat', visibleWhen: { field: 'repeat', equals: ['daily'] } },
        { key: 'days', emptyText: 'no days picked' },
        { key: 'time', prefix: ' at ', emptyText: 'no time picked' },
        { key: 'every', emptyText: 'no interval picked' },
    ],
    note:
        "Its runs are about nobody, so anything that needs a member — roles, DMs, Ask a Question — can't sit below it. " +
        'Times are server time. Missed while the bot was down? It runs once when it is back, not once per miss. ' +
        "If the last run from this schedule is still waiting on something, the next time is skipped. Switching the " +
        "flow off and on starts fresh: times passed while it was off don't run.",
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [],
    // The clock started it: no member, no actor, no channel.
    requires: [],
    capabilities: [],
    emits: [],
    startedBy: 'scheduleDue',
    canSuspend: false,
    run() {
        return { kind: 'continue' };
    },
};
