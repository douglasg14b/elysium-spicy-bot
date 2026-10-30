import type { ColumnType, Generated, JSONColumnType, Selectable } from 'kysely';

/**
 * Who an id is in one server: one row per member per server, kept after they leave.
 *
 * Written by the bot as it sees members (the startup sweep, joins, updates, leaves, user
 * renames) and by the dashboard's name lookup for an id nobody has seen
 * (`docs/plans/member-names.md`). Read by the dashboard to name the ids it shows.
 *
 * `username` and `globalName` are the account's names as last seen, the same in every
 * server; `nickname` is this server's. `nicknames` is every server nickname the bot has seen
 * them use here, distinct, most recent first, at most {@link MEMBER_NICKNAME_HISTORY_CAP} —
 * the current one included. It holds nicknames only: the account's past names are not kept.
 *
 * `inServer` false with no `leftAt` means the bot did not see them go: they were missing
 * from a startup sweep, or were only ever looked up. `leftAt` is set only by a leave the
 * bot heard, and cleared when they come back.
 *
 * Dialects differ, as on every table with these column kinds: sqlite stores `nicknames` as
 * TEXT and the booleans as 0/1, which `SqliteJsonPlugin` and `SqliteBindingPlugin` turn back
 * into a list and booleans (`database.ts`); postgres stores `jsonb` and `boolean` directly.
 */
export interface MemberNamesTable {
    id: Generated<number>;
    guildId: string;
    userId: string;
    /** The Discord handle. */
    username: string;
    /** The account's display name; null when they have not set one. */
    globalName: string | null;
    /** This server's nickname — the last one seen, for somebody who has left; null when they had none. */
    nickname: string | null;
    nicknames: JSONColumnType<string[]>;
    isBot: boolean;
    inServer: boolean;
    leftAt: ColumnType<Date | null, string | null, string | null>;
    firstSeenAt: ColumnType<Date, string, string>;
    /** The last write about them in this server — presence or nickname. An account rename does not move it. */
    updatedAt: ColumnType<Date, string, string>;
}

export type MemberNameRow = Selectable<MemberNamesTable>;

/** How many server nicknames a row keeps, newest first. */
export const MEMBER_NICKNAME_HISTORY_CAP = 25;
