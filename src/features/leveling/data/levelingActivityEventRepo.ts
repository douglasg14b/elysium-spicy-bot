import type { Transaction } from 'kysely';
import { database, Database } from '../../../features-system/data-persistence/database';
import type { LevelingActivityEvent, LevelingActivityTotals } from './levelingActivityEventSchema';
import type { LevelingActivityEventType } from '../constants/activityEventTypes';
import { aggregateActivityTotals } from '../logic/activityEventAggregation';
import { toTimestampValue } from '../logic/xpGrant';

export type RecordActivityEventInput = {
    guildId: string;
    userId: string;
    activityType: LevelingActivityEventType;
    xpAmount: number;
    messageLength?: number | null;
    photoBonusApplied?: boolean;
    occurredAt?: Date;
    voiceEligibleSeconds?: number | null;
    voiceSessionStartedAt?: Date | null;
    voiceSessionEndedAt?: Date | null;
    voiceChannelId?: string | null;
    voiceEligibilityRule?: string | null;
};

/** The three columns guild-wide analytics reads, and nothing more. */
export type GuildTimelineEvent = {
    userId: string;
    occurredAt: Date;
    xpAmount: number;
};

export class LevelingActivityEventRepo {
    async getUserEvents(
        guildId: string,
        userId: string,
        options?: { since?: Date; limit?: number }
    ): Promise<LevelingActivityEvent[]> {
        let query = database
            .selectFrom('leveling_activity_events')
            .selectAll()
            .where('guildId', '=', guildId)
            .where('userId', '=', userId)
            .orderBy('occurredAt', 'asc');

        if (options?.since) {
            query = query.where('occurredAt', '>=', options.since);
        }

        if (options?.limit) {
            query = query.limit(options.limit);
        }

        return query.execute();
    }

    async getUserActivityTotals(
        guildId: string,
        userId: string,
        options?: { since?: Date }
    ): Promise<LevelingActivityTotals> {
        const events = await this.getUserEvents(guildId, userId, options);
        return aggregateActivityTotals(events);
    }

    /**
     * Every XP-bearing moment in a guild, as three columns.
     *
     * Deliberately **not** `selectAll`: the caller only sums XP per member per day, and the
     * full row carries five voice columns plus `messageLength` it never reads. At a couple of
     * hundred thousand rows that projection is the difference between ~36 MB of JS garbage
     * per call and a few MB — and on SQLite this repo runs one *synchronous* connection, so
     * the marshalling cost is time the whole bot spends unable to answer anything.
     *
     * Ordered by `(userId, occurredAt)`, which is the tail of
     * `leveling_activity_events_guild_user_occurred_idx` — so with `guildId` fixed the index
     * supplies this order directly and no sort step is needed. The index does **not** include
     * `id`, so no `id` tiebreaker is applied here: adding one would force the sort this
     * ordering exists to avoid, and it would buy nothing, because the consumer groups by
     * `(userId, day)` and re-sorts per member anyway. Two grants in the same millisecond are
     * therefore in an arbitrary order relative to each other, which their common day key
     * makes irrelevant.
     *
     * No date bucketing in SQL. The leveling day key is timezone-aware
     * (`getActivityDateKey`), and `substr(occurred_at, 1, 10)` would silently give UTC days
     * that disagree with every existing per-member chart at the boundary — as well as needing
     * a second, divergent arm for postgres. Bucketing happens in JS, once, from this.
     *
     * `limit` is a hard stop the caller sets one past its ceiling, so an over-large guild is
     * refused on the strength of what was really read rather than of a count taken earlier.
     */
    async getGuildEventTimeline(guildId: string, limit: number): Promise<GuildTimelineEvent[]> {
        return database
            .selectFrom('leveling_activity_events')
            .select(['userId', 'occurredAt', 'xpAmount'])
            .where('guildId', '=', guildId)
            .orderBy('userId', 'asc')
            .orderBy('occurredAt', 'asc')
            .limit(limit)
            .execute();
    }

    /**
     * How many rows {@link getGuildEventTimeline} would return, for a pre-flight check.
     *
     * `countAll<string | number>()` rather than `<number>`, matching `ticketsRepo`: postgres
     * returns `COUNT(*)` as a `bigint`, which `pg` hands back as a **string**. Annotating it
     * `number` would be an assertion rather than a conversion, and would make the `Number()`
     * below look like redundancy somebody could safely delete — at which point the ceiling
     * comparison starts coercing a string on postgres only, where CI never looks.
     */
    async countGuildEvents(guildId: string): Promise<number> {
        const row = await database
            .selectFrom('leveling_activity_events')
            .select((eb) => eb.fn.countAll<string | number>().as('count'))
            .where('guildId', '=', guildId)
            .executeTakeFirst();

        return Number(row?.count ?? 0);
    }

    async recordActivityEvent(
        transaction: Transaction<Database>,
        input: RecordActivityEventInput
    ): Promise<void> {
        const occurredAt = (input.occurredAt ?? new Date()).toISOString();
        const values = {
            guildId: input.guildId,
            userId: input.userId,
            activityType: input.activityType,
            xpAmount: input.xpAmount,
            messageLength: input.messageLength ?? null,
            photoBonus: input.photoBonusApplied ?? false,
            occurredAt,
            ...(input.activityType === 'voice'
                ? {
                      voiceEligibleSeconds: input.voiceEligibleSeconds ?? null,
                      voiceSessionStartedAt: toTimestampValue(input.voiceSessionStartedAt ?? null),
                      voiceSessionEndedAt: toTimestampValue(input.voiceSessionEndedAt ?? null),
                      voiceChannelId: input.voiceChannelId ?? null,
                      voiceEligibilityRule: input.voiceEligibilityRule ?? null,
                  }
                : {}),
        };

        await transaction.insertInto('leveling_activity_events').values(values).execute();
    }
}

export const levelingActivityEventRepo = new LevelingActivityEventRepo();
