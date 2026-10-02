import { PermissionFlagsBits, type Guild } from 'discord.js';
import { z } from 'zod';
import type { FlowQuietWindow } from '../data/flowRunsSchema';
import type { BlockConfigField } from './manifest';

/**
 * "Count the time limit from…" — the option shared by every block that waits on a
 * clock (Ask a Question, Wait for Event, Delay).
 *
 * A fragment, not a block: it lives at the blocks root beside `manifest.ts` and
 * exports no `block`, so discovery never sees it. It exists so the three blocks
 * cannot word, default or validate the option three different ways — each spreads
 * {@link quietTimeoutShape} into its schema, appends {@link quietTimeoutFields} to its
 * form, refines with {@link checkQuietTimeout}, and parks with {@link toQuietWindow}.
 *
 * The block only asks; the scheduler does the counting. A park carrying a window
 * comes due at the ordinary `wakeAt`, and the scheduler pushes that back while
 * qualifying messages keep landing, so the block wakes on `timeout` only once it is
 * genuinely quiet — no re-posted buttons, and no visit spent per message.
 */

/** Where a time limit counts from. `waitStart` is today's behaviour and the default. */
export const TIMEOUT_COUNTS_FROM = ['waitStart', 'memberMessage', 'anyMessage'] as const;

export type TimeoutCountsFrom = (typeof TIMEOUT_COUNTS_FROM)[number];

/**
 * The two config keys, for a block's `z.object({ ...ownKeys, ...quietTimeoutShape })`.
 *
 * `timeoutCountsFrom` defaults in the schema as well as the form, so a graph saved
 * before the option existed parses as counting from the wait's start, exactly as it
 * always did. `quietChannelId` absent means anywhere in the server; its picker is
 * `optional`, so clearing it removes the key. An empty string reads the same way, since
 * that is what a required channel picker writes on change.
 */
export const quietTimeoutShape = {
    timeoutCountsFrom: z.enum(TIMEOUT_COUNTS_FROM).default('waitStart'),
    quietChannelId: z.string().optional(),
};

/** What {@link quietTimeoutShape} produces, as the helpers below read it. */
export type QuietTimeoutConfig = {
    readonly timeoutCountsFrom: TimeoutCountsFrom;
    readonly quietChannelId?: string;
};

/**
 * The two form fields, in the order they render, appended after a block's own time
 * limit. Both always show — the inspector has no "show when" — so the channel's
 * description says it only matters for the two message options.
 */
export const quietTimeoutFields: readonly BlockConfigField[] = [
    {
        key: 'timeoutCountsFrom',
        label: 'Count the time limit from',
        description:
            'Count from a last message and the clock restarts every time someone pipes up — it only runs out once things have actually gone quiet.',
        control: 'select',
        defaultValue: 'waitStart',
        options: [
            { value: 'waitStart', label: 'When it started waiting' },
            { value: 'memberMessage', label: "The member's last message" },
            { value: 'anyMessage', label: "Anyone's last message" },
        ],
    },
    {
        key: 'quietChannelId',
        label: 'Messages in',
        description:
            "Only matters when counting from a last message. Replies in its threads count too. Leave empty for anywhere in the server — except with anyone's messages, which needs a channel, because a whole server never shuts up.",
        control: 'channelPicker',
        optional: true,
    },
];

/**
 * Refuse the combinations that cannot mean anything, each naming the field to fix.
 *
 * `durationMs` is the block's own time limit, or undefined when it has none —
 * Ask a Question and Wait for Event may wait forever, and then there is nothing for a
 * last message to count.
 */
export function checkQuietTimeout(
    config: QuietTimeoutConfig,
    context: z.RefinementCtx,
    durationMs: number | undefined
): void {
    if (config.timeoutCountsFrom !== 'waitStart' && durationMs === undefined) {
        context.addIssue({
            code: 'custom',
            path: ['timeoutCountsFrom'],
            message: 'There is no time limit for this to count. Set one, or count from when it started waiting.',
        });
    }

    if (config.timeoutCountsFrom === 'anyMessage' && !config.quietChannelId) {
        context.addIssue({
            code: 'custom',
            path: ['quietChannelId'],
            message: "Counting from anyone's last message needs a channel — the whole server is never quiet.",
        });
    }
}

/**
 * The window to park with, or undefined for a plain timed park.
 *
 * `durationMs` is the block's time limit — the same span it adds to now for its
 * `wakeAt` — so the first deadline is the park plus the window and a message from
 * before the park can never bring it forward. No limit means nothing to count, so no
 * window.
 *
 * Call it **before** posting anything on the parking leg: it throws, which the
 * executor records against the node, in two cases where parking would be wrong.
 * "Anyone" without a channel is a schema regression `checkQuietTimeout` should have
 * caught — a park that could never wake. And a channel the bot cannot see would never
 * record a message, so the deadline could never move: the run would time out on
 * people mid-conversation, which is worse than failing where the author can see it.
 */
export function toQuietWindow(
    config: QuietTimeoutConfig,
    durationMs: number | undefined,
    guild: Guild
): FlowQuietWindow | undefined {
    if (durationMs === undefined) {
        return undefined;
    }

    const channelId = config.quietChannelId || undefined;
    if (channelId && config.timeoutCountsFrom !== 'waitStart') {
        checkChannelUsable(guild, channelId);
    }

    switch (config.timeoutCountsFrom) {
        case 'waitStart':
            return undefined;
        case 'memberMessage':
            return { durationMs, who: 'member', ...(channelId ? { channelId } : {}) };
        case 'anyMessage':
            if (!channelId) {
                throw new Error("Counting from anyone's last message needs a channel, and none is set.");
            }
            return { durationMs, who: 'anyone', channelId };
        default: {
            const illegal: never = config.timeoutCountsFrom;
            throw new Error(`Unknown time limit origin ${JSON.stringify(illegal)}.`);
        }
    }
}

/**
 * Refuse a "Messages in" channel the bot cannot read. Messages there never reach the
 * activity record, so it would look silent forever.
 *
 * Checked at park time against the cache, which holds every channel the guild sent the
 * bot. Access revoked later, mid-park, is not caught.
 */
function checkChannelUsable(guild: Guild, channelId: string): void {
    const channel = guild.channels.cache.get(channelId);
    const me = guild.members.me;
    if (channel && me && channel.permissionsFor(me).has(PermissionFlagsBits.ViewChannel)) {
        return;
    }

    throw new Error(
        `"Messages in" is a channel the bot can't see (${channelId}), so it would never hear anyone there ` +
            'and the time limit would run out on people mid-sentence. Pick a channel the bot can read.'
    );
}
