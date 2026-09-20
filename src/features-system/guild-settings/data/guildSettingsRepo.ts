import { database, type DatabaseClient } from '../../data-persistence/database';
import { GUILD_SETTINGS_CONFIG_VERSION } from '../constants';
import type { GuildSettings } from './guildSettingsSchema';

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
        const existing = await this.getByGuildId(guildId);
        const now = new Date().toISOString();
        // Serialised here because the sqlite JSON plugin only parses on the way
        // *out*; the driver cannot bind an array on either dialect.
        const stored = JSON.stringify([...staffRoleIds]);

        if (existing) {
            await this.db
                .updateTable('guild_settings')
                .set({
                    staffRoleIds: stored,
                    updatedAt: now,
                })
                .where('guildId', '=', guildId)
                .execute();
        } else {
            await this.db
                .insertInto('guild_settings')
                .values({
                    guildId,
                    staffRoleIds: stored,
                    createdAt: now,
                    updatedAt: now,
                    configVersion: GUILD_SETTINGS_CONFIG_VERSION,
                })
                .execute();
        }

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
