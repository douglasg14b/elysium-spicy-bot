import { z } from 'zod';
import type { BlockManifest } from '../manifest';

export const TRIGGER_MESSAGE_SENT = 'trigger.messageSent';

/**
 * The variable names this trigger's run seed carries, owned here rather than at the
 * dispatcher — the Level Reached precedent, for the same two reasons: these are the keys
 * `outputs` below declares, so naming them in one place keeps the picker and the bag in
 * step, and it keeps `engine/` free of names it would otherwise have to learn.
 *
 * Both are **always set**, so neither is ever a trap for a later block:
 *
 *  - `channel` — the channel the message belongs to. For a thread reply, the channel the
 *    thread sits under.
 *  - `postedIn` — where it was actually posted. For a thread reply, the thread; otherwise
 *    the same channel as `channel`.
 */
export const MESSAGE_SENT_VARIABLES = {
    channel: 'messageChannelId',
    postedIn: 'postedInChannelId',
} as const;

/** Where a message must land to fire this trigger. */
export const MESSAGE_SENT_WHERE = ['anywhere', 'channel', 'category'] as const;

/** Longest text the "contains" filter takes — a word or a phrase, never a paragraph. */
const CONTAINS_MAX_LENGTH = 200;

/**
 * `channelId` and `categoryId` are each shown by `where` (`visibleWhen`), so both are
 * optional and only judged while they apply — see {@link checkWhere}.
 *
 * Each is `.min(1).optional()` rather than a bare optional string, so an empty pick is
 * refused as *too short*: that is the one complaint save-time validation forgives for a
 * picker naming a category or channel the flow declares but has not installed yet. A
 * refinement's own complaint would not be forgiven, so the refinement below fires only
 * for an id that is absent altogether.
 *
 * `contains` is matched trimmed and case-insensitively; empty means no filter.
 */
export const messageSentConfigSchema = z
    .object({
        where: z.enum(MESSAGE_SENT_WHERE).default('anywhere'),
        channelId: z.string().min(1).optional(),
        categoryId: z.string().min(1).optional(),
        contains: z.string().max(CONTAINS_MAX_LENGTH).optional(),
    })
    .superRefine((config, context) => checkWhere(config, context));

export type MessageSentConfig = z.infer<typeof messageSentConfigSchema>;

/**
 * Refuse a channel or category scope with nothing picked, naming the field to fix.
 *
 * Hidden fields never reach this — save-time validation and the dispatcher leave them
 * out first — so a channel left over from "A channel" cannot satisfy "A category".
 */
function checkWhere(config: MessageSentConfig, context: z.RefinementCtx): void {
    if (config.where === 'channel' && config.channelId === undefined) {
        context.addIssue({
            code: 'custom',
            path: ['channelId'],
            message: 'Which channel? Pick one — or set Where to Anywhere.',
        });
    }

    if (config.where === 'category' && config.categoryId === undefined) {
        context.addIssue({
            code: 'custom',
            path: ['categoryId'],
            message: 'Which category? Pick one — or set Where to Anywhere.',
        });
    }
}

/**
 * Fires when a member posts a message: anywhere, in one channel, or in any channel of a
 * category, optionally only when it contains some text.
 *
 * Dispatched by `engine/messageTriggerDispatch.ts`, which flows registers as an activity
 * subscriber — so the activity row is written before the run starts, and a Time Since
 * right after this sees the message that started it. Matching happens there, against an
 * in-memory index of every enabled trigger in the guild; a message nobody listens for
 * costs a map lookup.
 *
 * Disclosed limits:
 *
 *  - Only live messages that activity recorded start runs: never a bot, a webhook or a
 *    system message, and never a message the startup backfill recovered after an outage.
 *  - A message in a channel discord.js has not cached is dropped before it reaches the
 *    bot (the client does not enable `Partials.Channel`).
 *  - After Discord resumes a dropped gateway session it replays the messages missed, as
 *    live ones, so they can start runs. The flood limit covers that burst.
 *  - For a post in a forum, the channel output is the forum, which Send Message cannot
 *    post into. Posted in is the post's own thread.
 *  - The flood limit drops starts once a guild or a member has spent its share.
 */
export const block: BlockManifest<MessageSentConfig> = {
    type: TRIGGER_MESSAGE_SENT,
    kind: 'trigger',
    label: 'Message Sent',
    description: 'Start the run the moment someone opens their mouth — anywhere, in one channel, or a whole category.',
    group: 'triggers',
    icon: '💬',
    configSchema: messageSentConfigSchema,
    configFields: [
        {
            key: 'where',
            label: 'Where',
            description: 'Where the message has to land. A reply in a thread counts toward the channel it sits under.',
            control: 'select',
            defaultValue: 'anywhere',
            options: [
                { value: 'anywhere', label: 'Anywhere' },
                { value: 'channel', label: 'A channel' },
                { value: 'category', label: 'A category' },
            ],
        },
        {
            key: 'channelId',
            label: 'Channel',
            description: 'This channel, or any thread under it.',
            control: 'channelPicker',
            visibleWhen: { field: 'where', equals: ['channel'] },
        },
        {
            key: 'categoryId',
            label: 'Category',
            description:
                'Any channel in this category, threads included — channels made later count too, ticket channels and all.',
            control: 'categoryPicker',
            visibleWhen: { field: 'where', equals: ['category'] },
        },
        {
            key: 'contains',
            label: 'Contains',
            description: 'Only when the message contains this, in any case. Leave empty to fire on every message.',
            control: 'text',
            optional: true,
            placeholder: 'rules',
            maxLength: CONTAINS_MAX_LENGTH,
        },
    ],
    // e.g. "A channel · #general · containing "rules"". A hidden part renders nothing,
    // so only the scope `where` picked ever shows.
    cardSummary: [
        { key: 'where' },
        { key: 'channelId', prefix: ' · ', emptyText: 'no channel picked' },
        { key: 'categoryId', prefix: ' · ', emptyText: 'no category picked' },
        { key: 'contains', prefix: ' · containing ', quote: true, truncate: 20, hideWhenEmpty: true },
    ],
    note:
        'Only live messages from members count — never bots, webhooks, system messages, or anything sent while the bot was down. ' +
        "A reply in a private thread the bot hasn't joined is never seen. A flood is throttled: each server and each member " +
        'gets a handful of runs at a time, and the rest are dropped. That share covers every Message Sent flow and every ' +
        'message wait together, so stacking unfiltered Anywhere triggers burns through it faster.',
    handles: [{ label: 'Then', tone: 'neutral' }],
    outputs: [
        {
            naming: 'fixed',
            key: MESSAGE_SENT_VARIABLES.channel,
            label: 'Channel',
            description:
                "The channel the message landed in. For a thread reply, the channel the thread sits under — for a forum post, the forum itself, which Send Message can't post into.",
            valueKind: 'channel',
        },
        {
            naming: 'fixed',
            key: MESSAGE_SENT_VARIABLES.postedIn,
            label: 'Posted in',
            description: 'Exactly where it was posted: the thread, for a thread reply; otherwise the same channel.',
            valueKind: 'channel',
        },
    ],
    // A message is posted by someone, somewhere: the poster is both who the run is about
    // and who caused it, and the place posted in is the run's channel.
    requires: ['subject', 'actor', 'channel'],
    capabilities: [],
    startedBy: 'messageSent',
    canSuspend: false,
    run() {
        return { kind: 'continue' };
    },
};
