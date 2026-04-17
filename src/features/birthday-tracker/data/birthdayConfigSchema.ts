import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';

export interface BirthdayConfigTable {
    guildId: string;
    announcementChannelId: string;

    createdAt: ColumnType<Date, string, string>;
    updatedAt: ColumnType<Date, string, string>;

    configVersion: number;
}

export type BirthdayConfigRow = Selectable<BirthdayConfigTable>;
export type NewBirthdayConfigRow = Insertable<BirthdayConfigTable>;
export type BirthdayConfigUpdate = Updateable<BirthdayConfigTable>;
