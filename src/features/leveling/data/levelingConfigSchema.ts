import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

export interface LevelingConfigTable {
    id: Generated<number>;
    guildId: string;
    enabled: boolean;
    notificationChannelId: string;
    messageXpMin: number;
    messageXpMax: number;
    messageCooldownMs: number;
    reactionXpMin: number;
    reactionXpMax: number;
    reactionCooldownMs: number;
    reactionXpEnabled: boolean;
    photoXpBonusMin: number;
    photoXpBonusMax: number;
    photoBonusEnabled: boolean;
    createdAt: ColumnType<Date, string, string>;
    updatedAt: ColumnType<Date, string, string>;
    configVersion: number;
}

export type LevelingConfig = Selectable<LevelingConfigTable>;
export type NewLevelingConfig = Insertable<LevelingConfigTable>;
export type LevelingConfigUpdate = Updateable<LevelingConfigTable>;
