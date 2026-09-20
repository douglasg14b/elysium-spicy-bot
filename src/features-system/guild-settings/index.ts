/**
 * Guild-level settings: server-wide configuration owned by no single feature.
 *
 * Lives under `features-system/` rather than `features/` because it is not a product
 * feature. It ships no commands, no listeners, and no `init*` — it is a table and a
 * repo that several features read, which is what everything else under
 * `features-system/` is (`commands`, `commands-audit`, `data-persistence`). A
 * `src/features/<name>/` folder would advertise a Discord surface that does not
 * exist.
 *
 * The direction matters and is the reason it is worth stating: this module imports
 * no feature, so anything may read from it without creating a cycle. Staff roles are
 * consumed by the provisioning install path, which is itself a base capability and
 * deliberately depends on as little as possible.
 */
export { guildSettingsRepo, GuildSettingsRepo } from './data/guildSettingsRepo';
export type {
    GuildSettings,
    GuildSettingsTable,
    NewGuildSettings,
    GuildSettingsUpdate,
} from './data/guildSettingsSchema';
export { GUILD_SETTINGS_CONFIG_VERSION } from './constants';
