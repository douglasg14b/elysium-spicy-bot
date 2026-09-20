/**
 * Schema version stamped on every `guild_settings` row, matching the convention
 * every other config table here uses (`WARNINGS_CONFIG_VERSION` and friends). Bumped
 * when a stored setting's *shape* changes, so a migration can tell rows apart.
 */
export const GUILD_SETTINGS_CONFIG_VERSION = 1;
