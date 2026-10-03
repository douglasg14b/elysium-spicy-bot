import type { Insertable } from 'kysely';
import { database, type DatabaseClient } from '../../data-persistence/database';
import type { ActivityEventKind, ActivityEventsTable } from './activityEventsSchema';

export type RecordActivityEventInput = {
    readonly guildId: string;
    readonly userId: string;
    readonly channelId: string;
    /** The thread's parent channel when the event landed in a thread, otherwise null. */
    readonly parentChannelId: string | null;
    /** The message a `message` event records; null for a reaction. */
    readonly messageId: string | null;
    readonly kind: ActivityEventKind;
    readonly occurredAt: Date;
};

/**
 * Whose last message, and where.
 *
 * A user, a channel, or both — never neither. "Anyone, anywhere" is never quiet in a
 * live server, so a caller asking it has a bug; the union makes that unwritable rather
 * than checked.
 */
export type LastMessageQuery =
    | { readonly guildId: string; readonly userId: string; readonly channelId?: string }
    | { readonly guildId: string; readonly userId?: string; readonly channelId: string };

/**
 * Did this member post, optionally in one channel, between two instants?
 *
 * Always a member: the question is "did they reply", never "did anyone". Both bounds
 * are inclusive.
 */
export type MessageBetweenQuery = {
    readonly guildId: string;
    readonly userId: string;
    /** The channel itself and every thread under it. Absent means anywhere in the guild. */
    readonly channelId?: string;
    readonly from: Date;
    readonly to: Date;
};

/** Persistence for `activity_events`. SQL lives here and nowhere else. */
export class ActivityEventsRepo {
    constructor(private readonly db: DatabaseClient = database) {}

    /**
     * Append one activity event and return its id, which subscribers link their own rows to.
     *
     * Null when the message is already recorded — the startup backfill reached it first —
     * so the caller can tell a new event from one that was already there.
     */
    async record(input: RecordActivityEventInput): Promise<number | null> {
        const row = await this.db
            .insertInto('activity_events')
            .values(toRow(input))
            .onConflict((conflict) => conflict.column('messageId').doNothing())
            .returning('id')
            .executeTakeFirst();

        return row?.id ?? null;
    }

    /**
     * Append many events at once, skipping any message already recorded. Returns how many
     * rows were actually written.
     *
     * For the startup backfill, whose pages overlap what the live recorder wrote and what
     * an interrupted earlier backfill wrote — both of which the conflict skips.
     */
    async recordMany(inputs: readonly RecordActivityEventInput[]): Promise<number> {
        // Kysely refuses an INSERT with no rows.
        if (inputs.length === 0) return 0;

        const result = await this.db
            .insertInto('activity_events')
            .values(inputs.map(toRow))
            .onConflict((conflict) => conflict.column('messageId').doNothing())
            .executeTakeFirst();

        return Number(result.numInsertedOrUpdatedRows ?? 0n);
    }

    /**
     * When the latest matching **message** was sent, or null if there is none.
     *
     * Reactions never count: a member who only ever reacts has not said anything.
     *
     * A channel matches the channel itself and every thread under it. That is two
     * lookups — `channel_id = X` and `parent_channel_id = X`, each newest-first and
     * `LIMIT 1` — taking the later, rather than one `OR`, so each rides its own
     * `(guild_id, …, occurred_at)` index on both dialects instead of asking either
     * planner to combine two.
     */
    async findLastMessageAt(query: LastMessageQuery): Promise<Date | null> {
        if (query.channelId) {
            const [inChannel, inThreads] = await Promise.all([
                this.latestWhere(query, 'channelId', query.channelId),
                this.latestWhere(query, 'parentChannelId', query.channelId),
            ]);

            if (!inChannel || !inThreads) {
                return inChannel ?? inThreads;
            }
            return inChannel > inThreads ? inChannel : inThreads;
        }

        if (query.userId) {
            return this.latestWhere(query, 'userId', query.userId);
        }

        // Only reachable with an empty string standing in for one of the two, which the
        // type cannot rule out. Answering for the whole guild would be the "never quiet"
        // question the type exists to refuse, so this refuses too.
        throw new Error(
            `findLastMessageAt needs a user or a channel to look in; guild ${query.guildId} was asked with neither.`
        );
    }

    /**
     * When the member's latest **message** inside the span was sent, or null if they sent
     * none there. Reactions never count, as for {@link findLastMessageAt}.
     *
     * The latest rather than any: the outage catch-up wakes a run once for every reply in
     * the span, and a wait the run parks on next must listen after the newest of them.
     *
     * The same split as there for a channel — `channel_id = X` and `parent_channel_id = X`
     * asked separately, newest-first and `LIMIT 1` each, taking the later — so each seeks
     * its own `(guild_id, …, user_id, occurred_at)` index straight to this member's rows in
     * range. Without a channel it rides `(guild_id, user_id, occurred_at)`.
     */
    async findLastMessageBetween(query: MessageBetweenQuery): Promise<Date | null> {
        if (!query.channelId) {
            return this.latestBetween(query);
        }

        const [inChannel, inThreads] = await Promise.all([
            this.latestBetween(query, 'channelId', query.channelId),
            this.latestBetween(query, 'parentChannelId', query.channelId),
        ]);
        if (!inChannel || !inThreads) {
            return inChannel ?? inThreads;
        }
        return inChannel > inThreads ? inChannel : inThreads;
    }

    /**
     * The newest message by the query's member inside the span, in one location column
     * when given.
     */
    private async latestBetween(
        query: MessageBetweenQuery,
        column?: 'channelId' | 'parentChannelId',
        value?: string
    ): Promise<Date | null> {
        let select = this.db
            .selectFrom('activity_events')
            .select('occurredAt')
            .where('guildId', '=', query.guildId)
            .where('userId', '=', query.userId)
            .where('kind', '=', 'message')
            .where('occurredAt', '>=', query.from)
            .where('occurredAt', '<=', query.to);

        if (column && value) {
            select = select.where(column, '=', value);
        }

        const row = await select.orderBy('occurredAt', 'desc').limit(1).executeTakeFirst();
        return row?.occurredAt ?? null;
    }

    /** The newest message matching one location column, narrowed to the query's user when it names one. */
    private async latestWhere(
        query: LastMessageQuery,
        column: 'userId' | 'channelId' | 'parentChannelId',
        value: string
    ): Promise<Date | null> {
        let select = this.db
            .selectFrom('activity_events')
            .select('occurredAt')
            .where('guildId', '=', query.guildId)
            .where(column, '=', value)
            .where('kind', '=', 'message');

        if (query.userId && column !== 'userId') {
            select = select.where('userId', '=', query.userId);
        }

        const row = await select.orderBy('occurredAt', 'desc').limit(1).executeTakeFirst();
        return row?.occurredAt ?? null;
    }
}

function toRow(input: RecordActivityEventInput): Insertable<ActivityEventsTable> {
    return {
        guildId: input.guildId,
        userId: input.userId,
        channelId: input.channelId,
        parentChannelId: input.parentChannelId,
        messageId: input.messageId,
        kind: input.kind,
        occurredAt: input.occurredAt.toISOString(),
    };
}

export const activityEventsRepo = new ActivityEventsRepo();
