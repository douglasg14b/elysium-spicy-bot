import { ChannelType, type Guild } from 'discord.js';
import { Hono } from 'hono';
import { z } from 'zod';
import { guildSettingsRepo } from '../../features-system/guild-settings';
import { warningsConfigRepo } from '../../features/warnings/data/warningsConfigRepo';
import { setWarningsModChannel } from '../../features/warnings/logic/setWarningsModChannel';
import type { AppEnv } from '../types';
import { accessibleGuilds } from './guildAccess';

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

    // Text channels for a guild (channel-picker display).
    app.get('/:guildId/channels', (c) => {
        const channels = textChannels(c.get('guild')).map((ch) => ({ id: ch.id, name: ch.name }));
        return c.json({ channels });
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

    // Guild-wide settings owned by no single feature. Today: staff roles.
    app.get('/:guildId/settings', async (c) => {
        const guild = c.get('guild');
        const staffRoleIds = await guildSettingsRepo.getStaffRoleIds(guild.id);
        return c.json(resolveGuildSettings(guild, staffRoleIds));
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
        return c.json(resolveGuildSettings(guild, saved.staffRoleIds));
    });

    return app;
}

/**
 * The wire shape for guild settings: stored ids plus their current names, so the
 * dashboard can render a role without a second round trip.
 *
 * A role deleted since it was saved resolves to no name and is dropped from
 * `staffRoles` while staying in `staffRoleIds` — the saved list is reported as saved,
 * rather than quietly rewritten by a read.
 */
function resolveGuildSettings(
    guild: Guild,
    staffRoleIds: readonly string[]
): {
    staffRoleIds: string[];
    staffRoles: { id: string; name: string }[];
} {
    const staffRoles = staffRoleIds
        .map((roleId) => guild.roles.cache.get(roleId))
        .filter((role): role is NonNullable<typeof role> => !!role)
        .map((role) => ({ id: role.id, name: role.name }));

    return { staffRoleIds: [...staffRoleIds], staffRoles };
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

/** Text channels of a guild, sorted by name for stable display. */
function textChannels(guild: Guild) {
    return [...guild.channels.cache.values()]
        .filter((ch) => ch.type === ChannelType.GuildText)
        .sort((a, b) => a.name.localeCompare(b.name));
}
