import type { ColumnType, Generated, Insertable, JSONColumnType, Selectable, Updateable } from 'kysely';

/**
 * Server-wide configuration owned by no single feature.
 *
 * One row per guild, holding the settings that several features need to agree on.
 * Today that is the staff role list; the table exists as a home for the next such
 * setting rather than as a staff-roles table with a general name, which is why the
 * row is created on first write of *any* setting and read as a whole.
 *
 * `staffRoleIds` is a **JSON column, not a join table**. The list is read whole,
 * written whole, and never queried across guilds ("which guilds have role X as
 * staff?" is not a question anything asks). A join table would buy referential
 * queries nothing needs and cost a second table, a second write path, and a
 * transaction to keep the two consistent. It also matches the precedent already
 * set by `ticketing_config.moderationRoles`.
 *
 * Dialects differ: sqlite stores this as TEXT and needs `SqliteJsonPlugin` to parse
 * it back, while postgres stores `jsonb` and returns an array directly. Both are
 * registered in `database.ts` — without the sqlite registration the column comes
 * back as a JSON *string* on one dialect only, which typechecks and fails at runtime.
 */
export interface GuildSettingsTable {
    id: Generated<number>;
    guildId: string;

    /**
     * Roles that count as **staff** on this server.
     *
     * Deliberately NOT the same concept as tickets' `moderationRoles`, and not
     * seeded from it: on this server staff and moderators are different groups of
     * people, an operator decision. The two lists coexist on purpose. Anything
     * unifying them is changing product behaviour, not removing duplication.
     *
     * Consumed by provisioning, where a resource declaring `audience: 'staff'`
     * compiles to exactly these ids.
     */
    staffRoleIds: JSONColumnType<string[]>;

    createdAt: ColumnType<Date, string, string>;
    updatedAt: ColumnType<Date, string, string>;
    configVersion: number;
}

export type GuildSettings = Selectable<GuildSettingsTable>;
export type NewGuildSettings = Insertable<GuildSettingsTable>;
export type GuildSettingsUpdate = Updateable<GuildSettingsTable>;
