import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';
import type { LevelingActivityEventType } from '../constants/activityEventTypes';

export interface LevelingActivityEventTable {
    id: Generated<number>;
    guildId: string;
    userId: string;
    activityType: LevelingActivityEventType;
    xpAmount: number;
    /** Message length at grant time; null for reactions. Used for retroactive XP recalculation. */
    messageLength: number | null;
    photoBonus: ColumnType<boolean, boolean | number, boolean | number>;
    occurredAt: ColumnType<Date, string, string>;
}

export type LevelingActivityEvent = Selectable<LevelingActivityEventTable>;
export type NewLevelingActivityEvent = Insertable<LevelingActivityEventTable>;
export type LevelingActivityEventUpdate = Updateable<LevelingActivityEventTable>;

export type DailyActivityBucket = {
    activityDate: string;
    messageCount: number;
    reactionCount: number;
    photoUploadCount: number;
};

export type DailyXpBucket = DailyActivityBucket & {
    totalXp: number;
};

export type LevelingActivityTotals = DailyActivityBucket & {
    totalXp: number;
    eventCount: number;
};
