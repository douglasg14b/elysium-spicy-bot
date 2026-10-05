import { ChannelType, type Guild } from 'discord.js';
import { Hono } from 'hono';
import { z } from 'zod';
import {
    DEFAULT_GUILD_TIME_ZONE,
    guildSettingsRepo,
    storableTimeZone,
} from '../../features-system/guild-settings';
import { warningsConfigRepo } from '../../features/warnings/data/warningsConfigRepo';
import { setWarningsModChannel } from '../../features/warnings/logic/setWarningsModChannel';
import type { AppEnv } from '../types';
import { accessibleGuilds } from './guildAccess';
import { guildChannelBodies, type GuildSettingsBody } from './guildBody';

const warningsConfigBody = z.object({
    modChannelId: z.string().min(1, 'Pick a channel. Warning notices do not haunt the void.'),
});

/**
 * Staff roles arrive as a list of ids, and an **empty list is legal**: it is how an
 * operator says "nobody is staff here yet", and refusing it would leave no way to undo
 * a mistake short of deleting the row. Whether those ids exist in the guild is checked
 * against the live role cache below, not here — Zod cannot see Discord.
 */
const guildSettingsBody = z.object({
    staffRoleIds: z.array(z.string().min(1)),
});

/**
 * The time zone arrives as a name; whether `Intl` knows it is checked below by
 * `storableTimeZone`, which also decides the spelling that gets stored.
 */
const guildTimeZoneBody = z.object({
    // The longest IANA name is about 30 characters; the cap keeps a junk body from being
    // fed to `Intl` and echoed back in the refusal.
    timeZone: z
        .string()
        .min(1, 'Pick a time zone. "Whenever" is not one.')
        .max(64, "That's not a time zone, that's an essay. Pick one from the list."),
});

/**
 * Guild data + feature config. All routes require auth; everything under `:guildId` is
 * additionally authorized by `requireGuildAccess`, which resolves `c.get('guild')`.
 * See design doc §5.2 / §5.3.
 */

export function guildRoutes(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    // Guilds the bot is in that this user may manage.
    app.get('/', (c) => {
        const guilds = accessibleGuilds(c.get('user')).map((g) => ({
            id: g.id,
            name: g.name,
            iconURL: g.iconURL({ size: 128 }),
            memberCount: g.memberCount,
        }));
        return c.json({ guilds });
    });

    /*
     * The guild's channels, for every picker that names one.
     *
     * Carries `type` and the parent, which is what lets a caller tell two channels
     * called `#general` apart and lets a category be adopted at all. Categories are in
     * the list rather than filtered out here: a consumer that must not offer one as a
     * place to post filters on `type`, and doing it at the endpoint made that
     * invariant invisible to the code depending on it.
     */
    app.get('/:guildId/channels', (c) => {
        return c.json({ channels: guildChannelBodies(c.get('guild')) });
    });

    // Assignable roles for a guild (role-picker display). Excludes @everyone and
    // managed (bot/integration) roles — neither can be assigned by a flow.
    app.get('/:guildId/roles', (c) => {
        const guild = c.get('guild');
        const roles = [...guild.roles.cache.values()]
            .filter((role) => isAssignableRole(guild, role.id))
            .sort((a, b) => b.position - a.position)
            .map((role) => ({
                id: role.id,
                name: role.name,
                color: role.color,
                position: role.position,
            }));

        return c.json({ roles });
    });

    // Read-only warnings config, with the mod-log channel name resolved for display.
    app.get('/:guildId/config/warnings', async (c) => {
        const guild = c.get('guild');
        const config = await warningsConfigRepo.getByGuildId(guild.id);
        return c.json(resolveWarningsConfig(guild, config?.modChannelId ?? null));
    });

    // Update the warnings mod-log channel. Validates + persists via the shared
    // {@link setWarningsModChannel} — the same path the Discord slash-modal uses.
    app.put('/:guildId/config/warnings', async (c) => {
        const guild = c.get('guild');
        const parsed = warningsConfigBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            const message = parsed.error.issues[0]?.message ?? 'Invalid request body.';
            return c.json({ error: message }, 400);
        }

        const result = await setWarningsModChannel(guild.id, parsed.data.modChannelId);
        if (!result.ok) {
            return c.json({ error: result.message }, 400);
        }

        return c.json(resolveWarningsConfig(guild, result.config.modChannelId));
    });

    // Guild-wide settings owned by no single feature. Today: staff roles and time zone.
    app.get('/:guildId/settings', async (c) => {
        const guild = c.get('guild');
        // One read of the row, so both settings come from the same moment. A guild with
        // no row has no staff and no picked zone.
        const settings = await guildSettingsRepo.getByGuildId(guild.id);
        return c.json(
            resolveGuildSettings(guild, {
                staffRoleIds: settings?.staffRoleIds ?? [],
                timeZone: settings?.timeZone ?? null,
            })
        );
    });

    /*
     * Replace this guild's staff roles.
     *
     * Ids are checked against the guild's live roles before anything is stored. A
     * deleted or foreign role id would otherwise sit in the table looking valid and
     * fail much later, during an install, as a permission intent that resolves to a
     * role Discord has never heard of — far from the form that accepted it.
     */
    app.put('/:guildId/settings', async (c) => {
        const guild = c.get('guild');
        const parsed = guildSettingsBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            const message = parsed.error.issues[0]?.message ?? 'Invalid request body.';
            return c.json({ error: message }, 400);
        }

        // Deduplicated before storing: the same role twice is the same permission
        // overwrite twice, and the list is a set in everything but its type.
        const staffRoleIds = [...new Set(parsed.data.staffRoleIds)];

        /*
         * Only *newly added* ids are validated. An id already saved is left alone even
         * if it no longer resolves, so deleting a staff role in Discord does not make
         * this form permanently unsaveable: the operator can still submit, and the
         * dead id is pruned by the next save that drops it. Validating the whole list
         * would reject every submission on the strength of a role the operator cannot
         * re-create, and the error would name ids they never touched.
         */
        const existing = await guildSettingsRepo.getStaffRoleIds(guild.id);
        const added = staffRoleIds.filter((roleId) => !existing.includes(roleId));
        const rejected = added.filter((roleId) => !isAssignableRole(guild, roleId));
        if (rejected.length > 0) {
            return c.json(
                {
                    error: `These can't be staff roles: ${rejected.join(', ')}. Pick real, assignable roles — @everyone and bot-managed roles don't count.`,
                },
                400
            );
        }

        const saved = await guildSettingsRepo.setStaffRoleIds(guild.id, staffRoleIds);
        return c.json(resolveGuildSettings(guild, saved));
    });

    /*
     * Set this guild's time zone.
     *
     * Its own route rather than a field on the staff-role PUT, so neither form can wipe
     * the other by submitting what it does not show. Answers with the whole settings
     * shape, like the staff-role PUT, so the page can take either response as the new
     * saved state.
     */
    app.put('/:guildId/settings/time-zone', async (c) => {
        const guild = c.get('guild');
        const parsed = guildTimeZoneBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            const message = parsed.error.issues[0]?.message ?? 'Invalid request body.';
            return c.json({ error: message }, 400);
        }

        const timeZone = storableTimeZone(parsed.data.timeZone);
        if (!timeZone) {
            return c.json(
                {
                    error: `"${parsed.data.timeZone}" isn't a time zone, no matter how confidently you typed it. Pick one from the list.`,
                },
                400
            );
        }

        const saved = await guildSettingsRepo.setTimeZone(guild.id, timeZone);
        return c.json(resolveGuildSettings(guild, saved));
    });

    return app;
}

/** The stored settings the wire shape is built from. */
interface StoredGuildSettings {
    readonly staffRoleIds: readonly string[];
    /** The picked zone, `null` until someone picks one. */
    readonly timeZone: string | null;
}

/**
 * The wire shape for guild settings: stored ids plus their current names, so the
 * dashboard can render a role without a second round trip, and the picked time zone
 * beside the default it falls back to.
 *
 * A role deleted since it was saved resolves to no name and is dropped from
 * `staffRoles` while staying in `staffRoleIds` — the saved list is reported as saved,
 * rather than quietly rewritten by a read.
 */
function resolveGuildSettings(guild: Guild, settings: StoredGuildSettings): GuildSettingsBody {
    const staffRoles = settings.staffRoleIds
        .map((roleId) => guild.roles.cache.get(roleId))
        .filter((role): role is NonNullable<typeof role> => !!role)
        .map((role) => ({ id: role.id, name: role.name }));

    return {
        staffRoleIds: [...settings.staffRoleIds],
        staffRoles,
        timeZone: settings.timeZone,
        defaultTimeZone: DEFAULT_GUILD_TIME_ZONE,
    };
}

/**
 * Whether a role id may be handed to a feature as a real, grantable role.
 *
 * Shared by the role picker and by staff-role validation, because the two drifting
 * apart is a security bug rather than an inconsistency. Two exclusions, and the first
 * is the dangerous one:
 *
 *  - **`@everyone`**, whose id *is the guild id*. A plain cache check accepts it. It
 *    then compiles to an overwrite keyed on the same id as the `everyone` audience,
 *    and since later intents override earlier ones per id
 *    (`compilePermissionIntents`), the canonical "deny everyone, then allow staff"
 *    declaration erases its own deny — producing a world-readable channel that every
 *    plan, embed, and dashboard still reports as staff-only.
 *  - **Managed** roles, which belong to a bot or integration and cannot be assigned.
 */
function isAssignableRole(guild: Guild, roleId: string): boolean {
    const role = guild.roles.cache.get(roleId);
    return !!role && role.id !== guild.id && !role.managed;
}

/** The wire shape for warnings config: id plus resolved channel name for display. */
function resolveWarningsConfig(
    guild: Guild,
    modChannelId: string | null
): { modChannelId: string | null; modChannelName: string | null } {
    const modChannelName = modChannelId
        ? guild.channels.cache.get(modChannelId)?.name ?? null
        : null;
    return { modChannelId, modChannelName };
}

