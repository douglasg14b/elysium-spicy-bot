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
 *
 * {@link checkChannelUsable} is exported beyond the three: any block reading the activity
 * record for one channel refuses an unusable channel through it, worded for that block,
 * rather than with a second copy of the check.
 */

/** The channel field's label, as the form shows it and as a refusal names it. */
const QUIET_CHANNEL_LABEL = 'Messages in';

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
 * limit. The channel shows only while counting from a last message (`visibleWhen`);
 * counting from the wait's start reads no channel, so a hidden one — even a stale
 * `{{var}}` left from before the author switched — is never resolved or checked.
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
        label: QUIET_CHANNEL_LABEL,
        description:
            "Replies in its threads count too. Leave empty for anywhere in the server — except with anyone's messages, which needs a channel, because a whole server never shuts up.",
        control: 'channelPicker',
        optional: true,
        visibleWhen: { field: 'timeoutCountsFrom', equals: ['memberMessage', 'anyMessage'] },
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
        checkChannelUsable(guild, channelId, {
            fieldLabel: QUIET_CHANNEL_LABEL,
            reason: 'so it would never hear anyone there and the time limit would run out on people mid-sentence',
        });
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
 * How {@link checkChannelUsable} words its refusal: which field, and what an unusable
 * channel would get wrong for this block.
 */
export type ChannelUsableMessage = {
    /** The field's label as the author sees it, e.g. `Messages in`. */
    readonly fieldLabel: string;
    /**
     * The consequence for this block, as a clause continuing the sentence after the
     * channel id — starting `so …`.
     */
    readonly reason: string;
};

/**
 * Refuse a channel whose messages never reach the activity record, by throwing — which
 * the executor records against the node. Such a channel would look silent forever, and
 * every block that reads that record would answer from silence that is not real.
 *
 * Two cases, worded apart because the fix differs. A channel missing from the cache
 * entirely **no longer exists** — deleted since it was picked, or since a `{{var}}`
 * recorded it — and no permission change will bring it back. A cached one the bot cannot
 * view is a permissions problem.
 *
 * Checked against the cache, which holds every channel the guild sent the bot. Access
 * revoked after the check is not caught.
 */
export function checkChannelUsable(guild: Guild, channelId: string, message: ChannelUsableMessage): void {
    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
        throw new Error(
            `"${message.fieldLabel}" is a channel that no longer exists (${channelId}), ${message.reason}. ` +
                'Pick one that does.'
        );
    }

    const me = guild.members.me;
    if (me && channel.permissionsFor(me).has(PermissionFlagsBits.ViewChannel)) {
        return;
    }

    throw new Error(
        `"${message.fieldLabel}" is a channel the bot can't see (${channelId}), ${message.reason}. ` +
            'Pick a channel the bot can read.'
    );
}
