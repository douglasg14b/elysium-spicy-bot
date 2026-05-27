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
    lastMessageXpAt: ColumnType<Date | null, string | null, string | null>;
    lastReactionXpAt: ColumnType<Date | null, string | null, string | null>;
    createdAt: ColumnType<Date, string, string>;
    updatedAt: ColumnType<Date, string, string>;
}

export type LevelingProgress = Selectable<LevelingProgressTable>;
export type NewLevelingProgress = Insertable<LevelingProgressTable>;
export type LevelingProgressUpdate = Updateable<LevelingProgressTable>;
