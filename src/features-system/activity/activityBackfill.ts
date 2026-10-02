import {
    PermissionFlagsBits,
    SnowflakeUtil,
    type Client,
    type Guild,
    type GuildTextBasedChannel,
    type Message,
} from 'discord.js';
import { toMessageActivity } from './activityRecorder';
import { gapBefore, type ActivityGap } from './backfillGaps';
import { activityEventsRepo, type ActivityEventsRepo, type RecordActivityEventInput } from './data/activityEventsRepo';
import {
    activityRecorderSessionsRepo,
    type ActivityRecorderSessionsRepo,
    type UnfilledRecorderSession,
} from './data/activityRecorderSessionsRepo';

/**
 * Recover the messages the bot missed while it was down, from Discord's history.
 *
 * **Record only.** Recovered messages go into `activity_events` and nowhere else: no
 * subscriber is notified, so nobody earns XP for an old post and nothing reacts to it
 * as if it had just been said. What a backfill restores is the answer to "when did they
 * last speak", which the flow scheduler reads.
 *
 * **One request in flight across the whole backfill.** Gaps, guilds, channels and pages
 * are all walked one after another, so a long recovery takes longer rather than taking
 * the rate limit from live interactions. discord.js's REST queue waits out 429s and
 * bucket resets by itself. No page cap: the 30-day lookback bounds the work, and only
 * runs with a quiet window wait for it.
 *
 * Out of scope, deliberately: archived threads (a thread archived during the outage is
 * not in the active list GUILD_CREATE sends, and finding it would mean a fetch per
 * channel), and reactions (Discord keeps no record of when one was added, and reactions
 * never count toward a quiet window anyway).
 */

/** The most messages Discord returns per history request. */
const PAGE_SIZE = 100;

export type ActivityBackfillDependencies = {
    readonly activityEventsRepo: Pick<ActivityEventsRepo, 'recordMany'>;
    readonly sessionsRepo: Pick<ActivityRecorderSessionsRepo, 'markGapFilled'>;
};

const defaultDependencies: ActivityBackfillDependencies = {
    activityEventsRepo,
    sessionsRepo: activityRecorderSessionsRepo,
};

/**
 * Backfill the gap before each session, oldest first, marking each filled once every
 * channel has been attempted.
 *
 * A gap is marked only after its backfill returns, so a process that dies mid-backfill
 * leaves it unfilled and the next start fills it along with its own. A failing channel
 * does not stop the gap (it is logged and skipped); a failing database write does, and
 * leaves the gap for the next start, since the rows it would have written are missing.
 *
 * So does a guild that had not arrived by the time the client was ready — common right
 * after a Discord incident. Its channels are not in the cache, so nothing of it can be
 * fetched; every other guild is still backfilled, but no gap is marked, and the next
 * start tries again. Re-fetching the guilds already done inserts nothing.
 */
export async function backfillUnfilledGaps(
    client: Client<true>,
    sessions: readonly UnfilledRecorderSession[],
    now: Date,
    dependencies: ActivityBackfillDependencies = defaultDependencies
): Promise<void> {
    const unavailableGuildIds = [...client.guilds.cache.values()]
        .filter((guild) => !guild.available)
        .map((guild) => guild.id);

    for (const session of sessions) {
        const gap = gapBefore(session, now);
        if (gap) {
            await backfillGap(client, gap, dependencies);
            if (unavailableGuildIds.length > 0) continue;
        } else if (!session.previousLastSeenAt) {
            // Only the very first session has no predecessor, and it is marked filled as it is
            // inserted — so reaching this means rows were deleted by hand.
            console.warn(
                `[activity] Recorder session ${session.id} has no earlier session to measure a gap from; nothing to backfill.`
            );
        }
        await dependencies.sessionsRepo.markGapFilled(session.id, new Date());
    }

    if (unavailableGuildIds.length > 0) {
        console.warn(
            `[activity] Guild(s) ${unavailableGuildIds.join(', ')} were unavailable at startup, so messages missed there ` +
                'could not be fetched. The gap stays unfilled and is retried on the next start.'
        );
    }
}

/** Backfill one gap across every guild that has arrived. */
async function backfillGap(
    client: Client<true>,
    gap: ActivityGap,
    dependencies: ActivityBackfillDependencies
): Promise<void> {
    const span = `${gap.start.toISOString()} – ${gap.end.toISOString()} (before recorder session ${gap.sessionId})`;
    console.info(`[activity] Backfilling messages missed ${span}`);

    let channelCount = 0;
    let recorded = 0;
    for (const guild of client.guilds.cache.values()) {
        if (!guild.available) continue;
        const { readable, historyDenied } = selectBackfillChannels(guild, gap);
        if (historyDenied.length > 0) {
            console.warn(
                `[activity] Cannot backfill channel(s) ${historyDenied.join(', ')} in guild ${guild.id}: the bot can ` +
                    'see them but lacks Read Message History, so messages missed there stay missing. Grant it to close this.'
            );
        }
        for (const channel of readable) {
            channelCount += 1;
            recorded += await backfillChannel(channel, gap, dependencies);
        }
    }

    console.info(`[activity] Backfill of ${span} recorded ${recorded} message(s) from ${channelCount} channel(s)`);
}

/**
 * The channels in a guild that may hold messages from inside the gap, from cache alone.
 *
 * Every text-based channel — voice-channel text and announcement channels included — and
 * every active thread, which is every thread GUILD_CREATE sends. A channel is skipped
 * when its last message predates the gap or it has none: `lastMessageId` arrives with
 * GUILD_CREATE, so this costs no request.
 *
 * A channel the bot cannot view is skipped silently: the live recorder could not hear it
 * either. One it can view but whose history it may not read is different — live messages
 * still arrive there, so skipping it is a real hole, and it is returned in
 * `historyDenied` for the caller to report.
 */
function selectBackfillChannels(guild: Guild, gap: ActivityGap): BackfillChannelSelection {
    // Every guild that arrived carries the bot's own member in its GUILD_CREATE.
    const me = guild.members.me;
    const selection: BackfillChannelSelection = { readable: [], historyDenied: [] };
    if (!me) return selection;

    for (const channel of guild.channels.cache.values()) {
        if (!channel.isTextBased() || (channel.isThread() && channel.archived)) continue;
        if (!hasMessageSince(channel.lastMessageId, gap.start)) continue;

        // Typed non-null, but a thread whose parent is not cached answers null at run
        // time; one such thread must skip itself, not throw away the whole backfill.
        const permissions = channel.permissionsFor(me);
        if (!permissions?.has(PermissionFlagsBits.ViewChannel)) continue;
        if (permissions.has(PermissionFlagsBits.ReadMessageHistory)) {
            selection.readable.push(channel);
        } else {
            selection.historyDenied.push(channel.id);
        }
    }
    return selection;
}

type BackfillChannelSelection = {
    readonly readable: GuildTextBasedChannel[];
    readonly historyDenied: string[];
};

/** Whether a channel's newest message was sent at or after `start`. */
function hasMessageSince(lastMessageId: string | null | undefined, start: Date): boolean {
    // Null or undefined, depending on whether Discord sent the key, when there is none.
    if (!lastMessageId) return false;
    return SnowflakeUtil.timestampFrom(lastMessageId) >= start.getTime();
}

/**
 * Page forward through one channel's history from the gap's start, recording each page.
 * Returns how many rows were written.
 *
 * Discord answers `after` with the messages immediately following the cursor, but lists
 * each page newest first — so the next cursor is the page's highest id, not its last. It
 * stops at an empty or short page, or at the first page reaching the gap's end; nothing
 * after that can fall inside the gap.
 *
 * A failed request is the channel's problem — deleted mid-fetch, permissions changed, any
 * non-429 API error — so it is logged with the channel id and the channel is left there.
 * No retry: the next channel matters more than a second try at this one.
 */
async function backfillChannel(
    channel: GuildTextBasedChannel,
    gap: ActivityGap,
    dependencies: ActivityBackfillDependencies
): Promise<number> {
    const end = gap.end.getTime();
    let after = snowflakeBefore(gap.start);
    let recorded = 0;

    for (;;) {
        let page: Message<true>[];
        try {
            // `cache: false`: old messages would only push recent ones out of the cache.
            const fetched = await channel.messages.fetch({ after, limit: PAGE_SIZE, cache: false });
            page = [...fetched.values()];
        } catch (error) {
            console.warn(
                `[activity] Backfill skipped the rest of channel ${channel.id} in guild ${channel.guildId} after an error:`,
                error
            );
            return recorded;
        }

        const inGap = page.filter((message) => message.createdTimestamp < end);
        recorded += await dependencies.activityEventsRepo.recordMany(
            inGap.map(toMessageActivity).filter((input): input is RecordActivityEventInput => input !== null)
        );

        if (page.length < PAGE_SIZE || inGap.length < page.length) {
            return recorded;
        }
        after = page.reduce(
            (highest, message) => (BigInt(message.id) > BigInt(highest) ? message.id : highest),
            after
        );
    }
}

/**
 * A cursor just before `start`, so `after` (which is exclusive) includes a message sent
 * at exactly that millisecond: the lowest snowflake for it, less one.
 */
function snowflakeBefore(start: Date): string {
    return (SnowflakeUtil.generate({ timestamp: start, increment: 0n, workerId: 0n, processId: 0n }) - 1n).toString();
}
