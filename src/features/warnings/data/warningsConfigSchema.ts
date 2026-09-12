import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

export interface WarningsConfigTable {
    id: Generated<number>;
    guildId: string;
    modChannelId: string;
    createdAt: ColumnType<Date, string, string>;
    updatedAt: ColumnType<Date, string, string>;
    configVersion: number;
}

export type WarningsConfig = Selectable<WarningsConfigTable>;
export type NewWarningsConfig = Insertable<WarningsConfigTable>;
export type WarningsConfigUpdate = Updateable<WarningsConfigTable>;
