import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

export interface WarningTable {
    id: Generated<number>;
    guildId: string;
    userId: string;
    issuerId: string;
    slug: string;
    rule: string;
    description: string;
    issuedAt: ColumnType<Date, string, string>;
    expiresAt: ColumnType<Date, string, string>;
    clearedAt: ColumnType<Date | null, string | null, string | null>;
    clearedById: string | null;
    createdAt: ColumnType<Date, string, string>;
}

export type Warning = Selectable<WarningTable>;
export type NewWarning = Insertable<WarningTable>;
export type WarningUpdate = Updateable<WarningTable>;
