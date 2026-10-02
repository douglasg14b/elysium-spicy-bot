import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';
import type { LevelingActivityEventType } from '../constants/activityEventTypes';

export interface LevelingXpGrantTable {
    id: Generated<number>;
    guildId: string;
    userId: string;
    activityType: LevelingActivityEventType;
    xpAmount: number;
    /** Message length at grant time; null for reactions and voice. Used for retroactive XP recalculation. */
    messageLength: number | null;
    photoBonus: ColumnType<boolean, boolean | number, boolean | number>;
    occurredAt: ColumnType<Date, string, string>;
    voiceEligibleSeconds: ColumnType<number | null, number | null | undefined, number | null | undefined>;
    voiceSessionStartedAt: ColumnType<Date | null, string | null | undefined, string | null | undefined>;
    voiceSessionEndedAt: ColumnType<Date | null, string | null | undefined, string | null | undefined>;
    voiceChannelId: ColumnType<string | null, string | null | undefined, string | null | undefined>;
    voiceEligibilityRule: ColumnType<string | null, string | null | undefined, string | null | undefined>;
    /**
     * The `activity_events` row this grant was earned from; null for voice and flow grants,
     * which have none. A plain column rather than a foreign key until retention exists.
     */
    activityEventId: number | null;
}

export type LevelingXpGrant = Selectable<LevelingXpGrantTable>;
export type NewLevelingXpGrant = Insertable<LevelingXpGrantTable>;
export type LevelingXpGrantUpdate = Updateable<LevelingXpGrantTable>;

export type DailyActivityBucket = {
    activityDate: string;
    messageCount: number;
    reactionCount: number;
    photoUploadCount: number;
    voiceSessionCount: number;
};

export type DailyXpBucket = DailyActivityBucket & {
    totalXp: number;
};

export type LevelingActivityTotals = DailyActivityBucket & {
    totalXp: number;
    eventCount: number;
};
