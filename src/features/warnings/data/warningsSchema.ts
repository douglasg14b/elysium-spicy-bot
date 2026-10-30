import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * One warning. Its status (active, expired, released) is never stored — it is derived from
 * `clearedAt` and `expiresAt` by `logic/warningStatus.ts`.
 *
 * The `*Name` columns are display-name snapshots taken when the row was written, so the
 * dashboard can name people without a Discord lookup per row. They are null on rows written
 * before they existed (`2026-10-29-Warnings_Dashboard_Record`); show the id then.
 */
export interface WarningTable {
    id: Generated<number>;
    guildId: string;
    userId: string;
    userName: string | null;
    issuerId: string;
    issuerName: string | null;
    slug: string;
    rule: string;
    description: string;
    issuedAt: ColumnType<Date, string, string>;
    expiresAt: ColumnType<Date, string, string>;
    clearedAt: ColumnType<Date | null, string | null, string | null>;
    clearedById: string | null;
    clearedByName: string | null;
    /** Why it was released. Null on a row released before reasons were recorded. */
    clearReason: string | null;
    /** The last edit only; the mod-log notices hold the full trail. */
    editedAt: ColumnType<Date | null, string | null, string | null>;
    editedById: string | null;
    editedByName: string | null;
    createdAt: ColumnType<Date, string, string>;
}

/**
 * Somebody acting on a warning — issuing, releasing or editing it — as the row records
 * them: their Discord id and the name they went by at the time.
 */
export type WarningActor = {
    readonly id: string;
    readonly name: string;
};

export type Warning = Selectable<WarningTable>;
export type NewWarning = Insertable<WarningTable>;
export type WarningUpdate = Updateable<WarningTable>;
