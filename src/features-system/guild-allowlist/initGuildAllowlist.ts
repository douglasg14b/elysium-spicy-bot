import { Events, type Client, type Guild } from 'discord.js';
import { DISCORD_CLIENT } from '../../discordClient';
import { ALLOWED_GUILD_IDS } from '../../environment';
import { isGuildAllowed } from './guildAllowlist';

/** What the join listener needs of a guild. */
export type JoinedGuild = Pick<Guild, 'id' | 'name' | 'leave'>;

/** What the startup report needs of a guild. */
export type ConnectedGuild = Pick<Guild, 'id' | 'name'>;

/** A Discord id: 17 to 20 digits. */
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Keep the bot to the servers in `ALLOWED_GUILD_IDS`. The bot is a Public Bot, so anyone
 * can add it to their own server; this is what makes that a no.
 *
 * Call once, before login, so the ready report sees the first `ClientReady`.
 */
export function initGuildAllowlist(): void {
    if (ALLOWED_GUILD_IDS.length === 0) {
        console.warn(
            '⚠️ [guild-allowlist] ALLOWED_GUILD_IDS is not set: every server that adds the bot is allowed, and the dashboard works in all of them.'
        );
    }
    watchGuildAllowlist(DISCORD_CLIENT, ALLOWED_GUILD_IDS);
}

/**
 * Leave a guild the bot newly joined that is not on the list, and report — never leave —
 * the unlisted guilds the bot is already in when it starts.
 *
 * **Only a new join leaves.** discord.js emits `GuildCreate` only for a guild it has not
 * cached, and only once the client is ready (`client/websocket/handlers/GUILD_CREATE.js`):
 * the guilds in READY are cached silently, and a cached guild coming back from an outage
 * is `GuildAvailable`. Leaving a server needs a re-invite to undo, so a guild the bot is
 * already in — on the list or not — is only ever logged; taking it off is an operator's call.
 *
 * A list with any entry that is not a guild id leaves nothing at all, and says so: a
 * mistyped id would otherwise make the real server look unlisted. Listed ids the bot is
 * not in are logged at ready for the same reason.
 *
 * Not covered, by design: a server that added the bot while it was offline arrives in
 * READY like any other, so it is logged, not left.
 */
export function watchGuildAllowlist(client: Client, allowedGuildIds: readonly string[]): void {
    if (allowedGuildIds.length === 0) return;

    // A typo makes a real server "unlisted", and the next re-invite of it would be left.
    // So a list holding anything that is not a guild id arms no leaving at all — loudly.
    const malformed = allowedGuildIds.filter((id) => !SNOWFLAKE.test(id));
    if (malformed.length > 0) {
        console.error(
            `❌ [guild-allowlist] ALLOWED_GUILD_IDS holds entries that are not guild ids: ${malformed.map((id) => JSON.stringify(id)).join(', ')}. ` +
                'No server will be left until it is fixed; the dashboard still only works in the listed ones.'
        );
    } else {
        client.on(Events.GuildCreate, (guild) => {
            void leaveIfNotAllowed(guild, allowedGuildIds);
        });
    }
    client.once(Events.ClientReady, (readyClient) => {
        reportGuildsNotAllowed(readyClient.guilds.cache.values(), allowedGuildIds);
        reportListedGuildsMissing(readyClient.guilds.cache, allowedGuildIds);
    });
}

/**
 * Leave `guild` if it is not on the list. A failed leave is logged, never thrown — it
 * runs inside a gateway listener.
 */
export async function leaveIfNotAllowed(guild: JoinedGuild, allowedGuildIds: readonly string[]): Promise<void> {
    if (isGuildAllowed(guild.id, allowedGuildIds)) return;
    console.warn(`🚪 [guild-allowlist] Added to ${guild.name} (${guild.id}), which is not in ALLOWED_GUILD_IDS. Leaving.`);
    try {
        await guild.leave();
    } catch (error) {
        console.error(`❌ [guild-allowlist] Failed to leave ${guild.name} (${guild.id}):`, error);
    }
}

/** Log each guild not on the list. Leaves nothing. */
export function reportGuildsNotAllowed(guilds: Iterable<ConnectedGuild>, allowedGuildIds: readonly string[]): void {
    for (const guild of guilds) {
        if (isGuildAllowed(guild.id, allowedGuildIds)) continue;
        console.warn(
            `⚠️ [guild-allowlist] Connected to ${guild.name} (${guild.id}), which is not in ALLOWED_GUILD_IDS. Staying — ` +
                'a server the bot is already in is never left automatically, and the dashboard ignores it.'
        );
    }
}

/**
 * Log each listed id the bot is not in — most often a typo, or a channel or user id
 * pasted where a guild id belongs, which leaves the real server off the list.
 */
export function reportListedGuildsMissing(
    connectedGuilds: ReadonlyMap<string, unknown>,
    allowedGuildIds: readonly string[]
): void {
    for (const id of allowedGuildIds) {
        if (connectedGuilds.has(id)) continue;
        console.warn(
            `⚠️ [guild-allowlist] ALLOWED_GUILD_IDS lists ${id}, but the bot is not in that server. A typo leaves the real server off the list.`
        );
    }
}
