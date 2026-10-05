import { database, type DatabaseClient } from '../../data-persistence/database';
import { DEFAULT_GUILD_TIME_ZONE, GUILD_SETTINGS_CONFIG_VERSION } from '../constants';
import type { GuildSettings } from './guildSettingsSchema';

/** A guild's time zone as picked (`null` until someone does) and as run on. */
export interface GuildTimeZone {
    readonly chosen: string | null;
    readonly effective: string;
}

/**
 * Exactly one setting's stored value — the `never` arms make naming both a type error.
 * Staff roles arrive already serialised to JSON.
 */
type SingleSettingWrite =
    | { readonly staffRoleIds: string; readonly timeZone?: never }
    | { readonly timeZone: string; readonly staffRoleIds?: never };

/**
 * Persistence for guild-wide settings. SQL lives here and nowhere else.
 *
 * Reads return `null` for a guild that has never been configured rather than a row
 * of defaults: "no settings saved" and "settings saved as empty" look identical to a
 * caller handed a default-filled object, and the install path needs to tell them
 * apart to explain itself.
 */
export class GuildSettingsRepo {
    constructor(private readonly db: DatabaseClient = database) {}

    async getByGuildId(guildId: string): Promise<GuildSettings | null> {
        const settings = await this.db
            .selectFrom('guild_settings')
            .selectAll()
            .where('guildId', '=', guildId)
            .executeTakeFirst();

        return settings ?? null;
    }

    /**
     * This guild's staff roles, or an empty list when nothing is configured.
     *
     * The convenience read for consumers that only care about the list — chiefly
     * provisioning, which compiles `audience: 'staff'` to exactly these ids. Empty
     * is a real answer here and callers must treat it as "no staff configured"
     * rather than "everyone": granting a staff-only channel to nobody is the
     * failure mode the install refusal exists to prevent.
     */
    async getStaffRoleIds(guildId: string): Promise<string[]> {
        const settings = await this.getByGuildId(guildId);
        return settings?.staffRoleIds ?? [];
    }

    /**
     * Replace this guild's staff roles, creating the settings row if needed.
     *
     * The list is written whole rather than diffed: it is a set the operator edits
     * as one value in one form, so a partial update has no meaning and would only
     * add a way for the stored list to disagree with what was on screen.
     */
    async setStaffRoleIds(guildId: string, staffRoleIds: readonly string[]): Promise<GuildSettings> {
        // Serialised here because the sqlite JSON plugin only parses on the way
        // *out*; the driver cannot bind an array on either dialect.
        return this.writeSetting(guildId, { staffRoleIds: JSON.stringify([...staffRoleIds]) });
    }

    /**
     * This guild's time zone: the one its operator picked, if any, and the one it runs
     * on. Consumers that schedule anything read `effective`; `chosen` is for the
     * dashboard, which keeps asking while it is `null`.
     */
    async getTimeZone(guildId: string): Promise<GuildTimeZone> {
        const settings = await this.getByGuildId(guildId);
        const chosen = settings?.timeZone ?? null;
        return { chosen, effective: chosen ?? DEFAULT_GUILD_TIME_ZONE };
    }

    /**
     * Set this guild's time zone, creating the settings row if needed.
     *
     * Expects a zone already vetted by `storableTimeZone`: this is persistence,
     * and the route is where an operator's input is judged.
     */
    async setTimeZone(guildId: string, timeZone: string): Promise<GuildSettings> {
        return this.writeSetting(guildId, { timeZone });
    }

    /**
     * Write exactly one setting, creating the row if this guild has none.
     *
     * One setting per call, by type, so saving one form can never rewrite what another
     * form owns: the staff-role and time-zone forms save independently, and an update
     * that set the whole row would wipe whichever one the caller did not mention. A new
     * row starts with no staff roles and no time zone.
     *
     * One upsert on the unique `guild_id` index rather than read-then-write: the page
     * has two Save buttons, and on a guild with no row both can be the first writer —
     * a second plain insert would hit the unique index and fail the request.
     */
    private async writeSetting(guildId: string, setting: SingleSettingWrite): Promise<GuildSettings> {
        const now = new Date().toISOString();

        await this.db
            .insertInto('guild_settings')
            .values({
                guildId,
                staffRoleIds: JSON.stringify([]),
                ...setting,
                createdAt: now,
                updatedAt: now,
                configVersion: GUILD_SETTINGS_CONFIG_VERSION,
            })
            .onConflict((conflict) => conflict.column('guildId').doUpdateSet({ ...setting, updatedAt: now }))
            .execute();

        const saved = await this.getByGuildId(guildId);
        if (!saved) {
            throw new Error(
                `Guild settings upsert succeeded but row was not found for guild ${guildId}`
            );
        }

        return saved;
    }
}

export const guildSettingsRepo = new GuildSettingsRepo();
