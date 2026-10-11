/**
 * Schema version stamped on every `guild_settings` row, matching the convention
 * every other config table here uses (`WARNINGS_CONFIG_VERSION` and friends). Bumped
 * when a stored setting's *shape* changes, so a migration can tell rows apart.
 */
export const GUILD_SETTINGS_CONFIG_VERSION = 1;

/**
 * The time zone a server runs on until its operator picks one: Pacific, the bot's
 * existing default.
 *
 * Its own constant rather than `BIRTHDAY_TIMEZONE`, which belongs to birthdays and can
 * be overridden by env. A server's zone is a per-guild setting; this is only what an
 * unset one means.
 */
export const DEFAULT_GUILD_TIME_ZONE = 'America/Los_Angeles';
