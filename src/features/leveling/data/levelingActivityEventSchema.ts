import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';
import type { LevelingActivityEventType } from '../constants/activityEventTypes';

export interface LevelingActivityEventTable {
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
}

export type LevelingActivityEvent = Selectable<LevelingActivityEventTable>;
export type NewLevelingActivityEvent = Insertable<LevelingActivityEventTable>;
export type LevelingActivityEventUpdate = Updateable<LevelingActivityEventTable>;

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
