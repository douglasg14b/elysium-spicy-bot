import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

export interface LevelingProgressTable {
    id: Generated<number>;
    guildId: string;
    userId: string;
    totalXp: number;
    level: number;
    messageCount: number;
    reactionCount: number;
    photoUploadCount: number;
    voiceSessionCount: ColumnType<number, number | undefined, number | undefined>;
    totalVoiceSeconds: ColumnType<number, number | undefined, number | undefined>;
    lastMessageXpAt: ColumnType<Date | null, string | null, string | null>;
    lastReactionXpAt: ColumnType<Date | null, string | null, string | null>;
    lastVoiceXpAt: ColumnType<Date | null, string | null | undefined, string | null | undefined>;
    createdAt: ColumnType<Date, string, string>;
    updatedAt: ColumnType<Date, string, string>;
}

export type LevelingProgress = Selectable<LevelingProgressTable>;
export type NewLevelingProgress = Insertable<LevelingProgressTable>;
export type LevelingProgressUpdate = Updateable<LevelingProgressTable>;
