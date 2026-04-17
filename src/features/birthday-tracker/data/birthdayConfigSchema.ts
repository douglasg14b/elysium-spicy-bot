import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

export interface BirthdayConfigTable {
    id: Generated<number>;
    guildId: string;
    announcementChannelId: string;
    contextChannelId: string | null;
    createdAt: ColumnType<Date, string, string>;
    updatedAt: ColumnType<Date, string, string>;
    configVersion: number;
}

export type BirthdayConfig = Selectable<BirthdayConfigTable>;
export type NewBirthdayConfig = Insertable<BirthdayConfigTable>;
export type BirthdayConfigUpdate = Updateable<BirthdayConfigTable>;
