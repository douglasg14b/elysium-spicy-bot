/**
 * Whether the bot may serve a guild. The one place that decides it: the bot's join
 * listener and the dashboard's guild access both ask here.
 *
 * An empty allowlist allows every guild — `ALLOWED_GUILD_IDS` unset is a supported
 * configuration, announced at startup, not a gap.
 */
export function isGuildAllowed(guildId: string, allowedGuildIds: readonly string[]): boolean {
    return allowedGuildIds.length === 0 || allowedGuildIds.includes(guildId);
}
