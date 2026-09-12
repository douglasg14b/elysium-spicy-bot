import { ChannelType, type Guild } from 'discord.js';
import { Hono } from 'hono';
import { z } from 'zod';
import { ADMIN_DISCORD_IDS } from '../../environment';
import { DISCORD_CLIENT } from '../../discordClient';
import { warningsConfigRepo } from '../../features/warnings/data/warningsConfigRepo';
import { setWarningsModChannel } from '../../features/warnings/logic/setWarningsModChannel';
import type { AppEnv } from '../types';
import { mayAccessGuild } from './guildAccess';

const warningsConfigBody = z.object({
    modChannelId: z.string().min(1, 'Pick a channel. Warning notices do not haunt the void.'),
});

/**
 * Guild data + read-only feature config. All routes require auth (mounted behind
 * {@link requireAuth} in the API composition). See design doc §5.2 / §5.3.
 */

export function guildRoutes(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();

    // Guilds the bot is in that this user may manage.
    app.get('/', (c) => {
        const user = c.get('user');
        const isAdmin = ADMIN_DISCORD_IDS.includes(user.id);
        const guilds = [...DISCORD_CLIENT.guilds.cache.values()]
            .filter((g) => isAdmin || user.manageableGuildIds.includes(g.id))
            .map((g) => ({
                id: g.id,
                name: g.name,
                iconURL: g.iconURL({ size: 128 }),
                memberCount: g.memberCount,
            }));
        return c.json({ guilds });
    });

    // Text channels for a guild (channel-picker display).
    app.get('/:guildId/channels', (c) => {
        const user = c.get('user');
        const guildId = c.req.param('guildId');
        if (!mayAccessGuild(user, guildId)) {
            return c.json({ error: 'You do not have access to this server.' }, 403);
        }
        const guild = DISCORD_CLIENT.guilds.cache.get(guildId);
        if (!guild) {
            return c.json({ error: 'Server not found.' }, 404);
        }
        const channels = textChannels(guild).map((ch) => ({ id: ch.id, name: ch.name }));
        return c.json({ channels });
    });

    // Assignable roles for a guild (role-picker display). Excludes @everyone and
    // managed (bot/integration) roles — neither can be assigned by a flow.
    app.get('/:guildId/roles', (c) => {
        const user = c.get('user');
        const guildId = c.req.param('guildId');
        if (!mayAccessGuild(user, guildId)) {
            return c.json({ error: 'You do not have access to this server.' }, 403);
        }
        const guild = DISCORD_CLIENT.guilds.cache.get(guildId);
        if (!guild) {
            return c.json({ error: 'Server not found.' }, 404);
        }

        const roles = [...guild.roles.cache.values()]
            .filter((role) => role.id !== guildId && !role.managed)
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
        const user = c.get('user');
        const guildId = c.req.param('guildId');
        if (!mayAccessGuild(user, guildId)) {
            return c.json({ error: 'You do not have access to this server.' }, 403);
        }
        const guild = DISCORD_CLIENT.guilds.cache.get(guildId);
        if (!guild) {
            return c.json({ error: 'Server not found.' }, 404);
        }

        const config = await warningsConfigRepo.getByGuildId(guildId);
        return c.json(resolveWarningsConfig(guild, config?.modChannelId ?? null));
    });

    // Update the warnings mod-log channel. Validates + persists via the shared
    // {@link setWarningsModChannel} — the same path the Discord slash-modal uses.
    app.put('/:guildId/config/warnings', async (c) => {
        const user = c.get('user');
        const guildId = c.req.param('guildId');
        if (!mayAccessGuild(user, guildId)) {
            return c.json({ error: 'You do not have access to this server.' }, 403);
        }
        const guild = DISCORD_CLIENT.guilds.cache.get(guildId);
        if (!guild) {
            return c.json({ error: 'Server not found.' }, 404);
        }

        const parsed = warningsConfigBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            const message = parsed.error.issues[0]?.message ?? 'Invalid request body.';
            return c.json({ error: message }, 400);
        }

        const result = await setWarningsModChannel(guildId, parsed.data.modChannelId);
        if (!result.ok) {
            return c.json({ error: result.message }, 400);
        }

        return c.json(resolveWarningsConfig(guild, result.config.modChannelId));
    });

    return app;
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
