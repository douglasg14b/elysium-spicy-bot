import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

export interface BirthdayTable {
    id: Generated<number>;

    // Index
    guildId: string;
    // Index - unique per guild
    userId: string;

    /** Month (1-12) */
    month: number;
    /** Day of month (1-31) */
    day: number;
    /** Optional year for age calculation */
    year: number | null;

    /** Display name at time of setting */
    displayName: string;
    /** Username at time of setting */
    username: string;

    /** When the birthday was last updated */
    updatedAt: ColumnType<Date, string, string>;
    /** When the birthday was first set */
    createdAt: ColumnType<Date, string, string>;

    configVersion: number; // For schema migrations
}

export type Birthday = Selectable<BirthdayTable>;
export type NewBirthday = Insertable<BirthdayTable>;
export type BirthdayUpdate = Updateable<BirthdayTable>;

export interface BirthdayDisplay {
    userId: string;
    displayName: string;
    username: string;
    month: number;
    day: number;
    year: number | null;
    age?: number; // Calculated field
}
