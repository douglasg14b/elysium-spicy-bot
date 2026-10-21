/**
 * Guild allowlist: which servers the bot serves at all (`ALLOWED_GUILD_IDS`).
 *
 * Under `features-system/` because it bounds every feature and the dashboard alike; it
 * imports no feature.
 */
export { initGuildAllowlist } from './initGuildAllowlist';
export { isGuildAllowed } from './guildAllowlist';
