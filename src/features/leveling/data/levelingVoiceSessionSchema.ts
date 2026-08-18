import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

export interface LevelingVoiceSessionTable {
    id: Generated<number>;
    guildId: string;
    userId: string;
    channelId: string;
    sessionStartedAt: ColumnType<Date, string, string>;
    eligibleAccumulatorMs: number;
    eligibleSince: ColumnType<Date | null, string | null, string | null>;
    updatedAt: ColumnType<Date, string, string>;
}

export type LevelingVoiceSession = Selectable<LevelingVoiceSessionTable>;
export type NewLevelingVoiceSession = Insertable<LevelingVoiceSessionTable>;
export type LevelingVoiceSessionUpdate = Updateable<LevelingVoiceSessionTable>;
